import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Recording } from '../analytics/recordings.entity';
import { RoleEnum, User } from '../user/user.entity';
import { EventTypes } from '../events/event.entity';
import { CallRecordingEventDto } from '../events/dto/call.recording.event.dto';
import { ClientDealsService } from '../messenger/client-deals.service';
import { CallsService } from './calls.service';
import { CallClientService } from './call-client.service';
import { CallUpload } from './call-upload.entity';

export interface CallDealResult {
  deal: { id: number; label: string };
  contact_id: number;
  created_deal: boolean;
  created_contact: boolean;
  // recordings put into the history of the deal (this one and the earlier calls of the same client)
  linked: number;
}

/**
 * «Создать сделку» on a recording that is in no deal: the number is not in the CRM, or the
 * client had no open deal when the call arrived (a phone records private calls too, so a
 * deal is never opened by itself). The client with that number — for a messenger call, with
 * that name (CallClientService: a Telegram call is looked up in the manager's Telegram) — is
 * found or created; the deal is chosen as for a messenger message
 * (ClientDealsService: the manager's open deal with the client, else the client's open deal,
 * else a new one named "client · phone · company"); every recording of that client that is
 * in no deal yet goes into its history. Only the recording the button was pressed on fires
 * the «записан звонок» triggers.
 */
@Injectable()
export class CallDealService {
  constructor(
    @InjectRepository(Recording) private recordings: Repository<Recording>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(CallUpload) private uploads: Repository<CallUpload>,
    private callClients: CallClientService,
    private dataSource: DataSource,
    private eventEmitter: EventEmitter2,
    private clientDeals: ClientDealsService,
  ) {}

  async forRecording(recordingId: number): Promise<CallDealResult> {
    const recording = await this.recordings.findOne({ where: { id: recordingId }, relations: { user: true } });
    if (!recording || !recording.user) throw new NotFoundException(`Recording ${recordingId} does not exist`);
    const who = String(recording.from_number ?? '').trim();
    if (!who) throw new BadRequestException('Запись без номера и без имени: сделку создать не из чего');
    const digits = CallsService.digits(who);
    const byNumber = digits.length >= 7;

    const upload = await this.uploads.findOne({ where: { recording: { id: recording.id } } });
    const found = await this.callClients.find({
      managerId: recording.user.id,
      number: byNumber ? who : null,
      name: byNumber ? null : (upload?.caller_name ?? who),
      fileName: upload?.file_name,
    });
    if (found.ambiguous) {
      throw new BadRequestException(`Под именем «${who}» несколько человек: укажите телефон в карточке нужного клиента, запись привяжется по номеру`);
    }
    let contact: User | null = found.contacts[0] ?? null;
    const createdContact = !contact;
    if (!contact) {
      // the recorder gives "+998901234567", "998901234567" or "+91 90000 00000"; a short local number stays as it is.
      // A Telegram call: the account the manager's Telegram shows under that name gives the id and the phone.
      const phone = byNumber ? (who.startsWith('+') || digits.length >= 11 ? '+' + digits : digits) : (found.telegram?.phone ?? null);
      const created = new User();
      created.username = (byNumber ? phone : who).slice(0, 255);
      created.role = RoleEnum.CTR_AGENT;
      created.phone = phone;
      if (found.telegram) created.tg_id = found.telegram.tg_id;
      created.created_by = recording.user;
      contact = await this.users.save(created);
    }

    const { deals, created } = await this.clientDeals.dealsForMessage(recording.user, contact);

    // this recording and the earlier calls of the same client that are in no deal yet
    const waiting: { id: number }[] = await this.dataSource.query(
      `SELECT r.id FROM recording r
        WHERE r.path IS NOT NULL
          AND (r.id = $1 OR ${byNumber
            ? "regexp_replace(COALESCE(r.from_number, ''), '[^0-9]', '', 'g') LIKE $2"
            : 'lower(btrim(r.from_number)) = lower($2)'})
          AND NOT EXISTS (SELECT 1 FROM event e WHERE e.type = $3 AND e.after_state->>'path' = r.path)
        ORDER BY r.created_at ASC, r.id ASC`,
      [recording.id, byNumber ? '%' + digits.slice(-9) : who, EventTypes.NEW_CALL_RECORDING],
    );
    let linked = 0;
    for (const row of waiting) {
      const call = row.id === recording.id ? recording : await this.recordings.findOne({ where: { id: row.id }, relations: { user: true } });
      if (!call) continue;
      for (const deal of deals) {
        const eventData: CallRecordingEventDto = {
          recording: call,
          deal,
          originated_by: contact,
          target_user: call.user ?? recording.user,
          history: call.id !== recording.id,
        };
        await this.eventEmitter.emitAsync(EventTypes.NEW_CALL_RECORDING.toString(), eventData);
      }
      linked++;
    }
    const deal = deals[0];
    return { deal: { id: deal.id, label: deal.label }, contact_id: contact.id, created_deal: created, created_contact: createdContact, linked };
  }
}
