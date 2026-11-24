import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { execFile } from 'child_process';
import { createReadStream, promises as fs } from 'fs';
import { extname, join } from 'path';
import { RecorderToken } from './recorder-token.entity';
import { CallUpload, CallUploadStatus } from './call-upload.entity';
import { Recording } from '../analytics/recordings.entity';
import { RoleEnum, User } from '../user/user.entity';
import { Deal } from '../deal/deal.entity';
import { EventTypes } from '../events/event.entity';
import { CallRecordingEventDto } from '../events/dto/call.recording.event.dto';
import { CallFeedQueryDto, CallListQueryDto, RecordingsQueryDto, QueueQueryDto } from './dto/calls.dto';
import { CallClient, CallClientService } from './call-client.service';
import { Access } from '../auth/access';
import { ClientDealsService } from '../messenger/client-deals.service';
import { phoneKeySql } from '../helper/phone';
import { AuditJournal } from '../audit/audit-journal';

const STAFF = [RoleEnum.ADMIN, RoleEnum.MANAGER, RoleEnum.AGENT];
/** The conversation with a client goes on where the latest of these is (as ClientDealsService counts it). */
const CALL_CHAT_TYPES = [
  EventTypes.NEW_TELEGRAM_MESSAGE,
  EventTypes.NEW_WHATSAPP_MESSAGE,
  EventTypes.NEW_EMAIL,
  EventTypes.NEW_SMS,
  EventTypes.NEW_CALL_RECORDING,
];
const AUDIO_EXTENSIONS = ['.amr', '.mp3', '.m4a', '.wav', '.ogg', '.aac', '.3gp'];

/** SQL: the last 9 digits of a phone column (how a call's number is compared with the CRM's phones; helper/phone.ts). */
const TAIL = (column: string) => phoneKeySql(column);
const DIGITS = (column: string) => `regexp_replace(COALESCE(${column}, ''), '[^0-9]', '', 'g')`;

/** One call as the lists show it (the admin's list, a staff member's own list, the company card). */
export interface CallRow {
  id: number;
  created_at: Date;
  // milliseconds, as the recorder writes them
  duration: number;
  outgoing: boolean;
  path: string;
  from_number: string | null;
  // the staff member whose phone recorded it
  user: { id: number; username: string } | null;
  // the client: the contact whose history has the call, else the contact with that number
  contact: { id: number; username: string } | null;
  deal: { id: number; label: string } | null;
}

/** An earlier upload of the same call (see CallsService.earlierCopy). */
interface EarlierCopy {
  upload_id: number;
  recording_id: number;
  path: string;
}

export interface UploadMeta {
  duration?: number | null;
  from_number?: string | null;
  outgoing: boolean;
  source: string;
  recorded_at?: Date | null;
  caller_name?: string | null;
}

/**
 * Call recordings through the API.
 *
 * The recorder app on a manager's phone (or the folder scanner of the Telegram
 * service, or the FTP receiver parisahon-ftp a phone syncs its recordings folder
 * to) sends every call to POST /calls/upload with the manager's recorder
 * token. What the request does not say (number, direction, time) is read from
 * the name of the file (recording-name.ts); the same file is queued once. The file lands in the queue (`call_upload`); the processor converts it
 * to mp3 with ffmpeg, writes the `recording` row the analytics read, puts the
 * call into the history of the client with that number (NEW_CALL_RECORDING
 * events: one deal — the manager's own open deal with the client, else another
 * manager's live open deal — else the client's card; see linkToDeals) and records the outcome
 * per file: a broken file is `failed` with its error, the next one is processed;
 * a second copy of a call that is already there (a sync app sent it cut off, then
 * whole) is `duplicate` and only the longer copy stays. Before, the Telegram
 * service wrote all of this straight into Postgres and one bad file stopped
 * the whole pass for ever.
 */
@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);
  private processing = false;
  // a file arrived while the processor was busy: one more pass right after this one
  private again = false;

  constructor(
    @InjectRepository(RecorderToken) private tokenRepository: Repository<RecorderToken>,
    @InjectRepository(CallUpload) private uploadRepository: Repository<CallUpload>,
    @InjectRepository(Recording) private recordingRepository: Repository<Recording>,
    @InjectRepository(User) private userRepository: Repository<User>,
    @InjectRepository(Deal) private dealRepository: Repository<Deal>,
    private dataSource: DataSource,
    private eventEmitter: EventEmitter2,
    private callClients: CallClientService,
  ) {}

  static uploadsDir(): string {
    return join(__dirname, '..', '..', 'public', 'uploads');
  }

  static ffmpegBin(): string {
    return (process.env.FFMPEG_BIN || 'ffmpeg').trim();
  }

  static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  static digits(phone?: string | null): string {
    return String(phone ?? '').replace(/[^\d]/g, '');
  }

  /** The shared secret of the FTP receiver (X-Calls-Service-Token): it uploads for the manager who logged in to it. */
  static serviceTokenMatches(value: unknown): boolean {
    const expected = (process.env.CALLS_SERVICE_TOKEN || '').trim();
    const given = String(value ?? '').trim();
    if (expected.length < 16 || given.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  }

  /** Where a phone sends its recordings by FTP ("host:port"), for the settings page; null — no FTP receiver. */
  static ftpAddress(): string | null {
    return (process.env.CALLS_FTP_ADDRESS || '').trim() || null;
  }

  private static async sizeOf(path: string): Promise<number> {
    try {
      return (await fs.stat(path)).size;
    } catch {
      return 0;
    }
  }

  private static sha256OfFile(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      createReadStream(path)
        .on('data', (chunk) => hash.update(chunk))
        .on('error', reject)
        .on('end', () => resolve(hash.digest('hex')));
    });
  }

  // ------------------------------------------------------------------ tokens

  /** Every staff user with the state of their recorder token. */
  async listTokens(): Promise<any[]> {
    const users = await this.userRepository.find({
      where: { role: In(STAFF) },
      order: { username: 'ASC' },
    });
    // `revoked_at: null` would be no condition at all in TypeORM: IsNull() it is
    const tokens = await this.tokenRepository.find({
      where: { revoked_at: IsNull() },
      relations: { user: true },
    });
    const byUser = new Map(tokens.map((t) => [t.user.id, t]));
    return users.map((u) => {
      const t = byUser.get(u.id);
      return {
        user_id: u.id,
        username: u.username,
        role: u.role,
        has_token: !!t,
        tls_required: t?.tls_required ?? false,
        issued_at: t?.created_at ?? null,
        last_upload_at: t?.last_upload_at ?? null,
      };
    });
  }

  /** A new token for the user (the old one is revoked); the value is returned once. */
  async issueToken(userId: number, admin: User, tlsRequired?: boolean): Promise<{ user_id: number; token: string; tls_required: boolean }> {
    const user = await this.userRepository.findOne({ where: { id: userId, role: In(STAFF) } });
    if (!user) throw new NotFoundException(`Staff user ${userId} does not exist`);
    // a new token of the same phone keeps the FTPS rule of the old one unless the admin says otherwise
    const previous = await this.tokenRepository.findOne({ where: { user: { id: userId }, revoked_at: IsNull() } });
    await this.revokeToken(userId);
    const token = 'rec_' + randomBytes(24).toString('hex');
    const row = new RecorderToken();
    row.user = user;
    row.token_hash = CallsService.hash(token);
    row.created_by = admin;
    row.tls_required = tlsRequired ?? previous?.tls_required ?? false;
    await this.tokenRepository.save(row);
    return { user_id: userId, token, tls_required: row.tls_required };
  }

  /** FTPS required for the FTP logins with the manager's current token (the FTP receiver asks GET /calls/recorder). */
  async setTokenTls(userId: number, tlsRequired: boolean): Promise<{ user_id: number; tls_required: boolean }> {
    // the journal (src/audit): «Только FTPS: нет → да» of the token, who changed it
    const result = await AuditJournal.around(this.tokenRepository.manager, 'recorder_token', 't.user_id = $1 AND t.revoked_at IS NULL', [userId], () =>
      this.tokenRepository
        .createQueryBuilder()
        .update(RecorderToken)
        .set({ tls_required: tlsRequired })
        .where('user_id = :userId AND revoked_at IS NULL', { userId })
        .execute(),
    );
    if (!result.affected) throw new NotFoundException(`Staff user ${userId} has no recorder token`);
    return { user_id: userId, tls_required: tlsRequired };
  }

  /** The manager behind a recorder token and whether FTP logins with it must use FTPS; null — no such token. */
  async recorderOfToken(token: string | undefined): Promise<{ user: User; tls_required: boolean } | null> {
    if (!token || token.length < 16) return null;
    const row = await this.tokenRepository.findOne({
      where: { token_hash: CallsService.hash(token), revoked_at: IsNull() },
      relations: { user: true },
    });
    if (!row || !row.user || row.user.deleted_at) return null;
    return { user: row.user, tls_required: !!row.tls_required };
  }

  async revokeToken(userId: number): Promise<{ revoked: number }> {
    // the journal (src/audit): «Отозван», who revoked it (the token itself is never stored)
    const result = await AuditJournal.around(this.tokenRepository.manager, 'recorder_token', 't.user_id = $1 AND t.revoked_at IS NULL', [userId], () =>
      this.tokenRepository
        .createQueryBuilder()
        .update(RecorderToken)
        .set({ revoked_at: new Date() })
        .where('user_id = :userId AND revoked_at IS NULL', { userId })
        .execute(),
    );
    return { revoked: result.affected ?? 0 };
  }

  /** The manager behind a recorder token, or null. */
  async userOfToken(token: string | undefined, uploading = true): Promise<User | null> {
    if (!token || token.length < 16) return null;
    const row = await this.tokenRepository.findOne({
      where: { token_hash: CallsService.hash(token), revoked_at: IsNull() },
      relations: { user: true },
    });
    if (!row || !row.user || row.user.deleted_at) return null;
    if (uploading) await this.touchToken(row.user.id);
    return row.user;
  }

  /** "Last upload" of the manager's token, shown on the settings page. */
  async touchToken(userId: number): Promise<void> {
    await this.tokenRepository
      .createQueryBuilder()
      .update(RecorderToken)
      .set({ last_upload_at: new Date() })
      .where('user_id = :userId AND revoked_at IS NULL', { userId })
      .execute();
  }

  // ------------------------------------------------------------------ queue

  async enqueue(user: User, file: Express.Multer.File, meta: UploadMeta): Promise<CallUpload & { duplicate?: boolean }> {
    const ext = extname(file.originalname || file.filename || '').toLowerCase();
    if (!AUDIO_EXTENSIONS.includes(ext)) {
      await fs.unlink(file.path).catch(() => undefined);
      throw new BadRequestException(`Unsupported audio file "${ext || file.originalname}": expected ${AUDIO_EXTENSIONS.join(', ')}`);
    }
    // the same file of the same manager again (a sync app after a reinstall): the first one stays
    const fileHash = await CallsService.sha256OfFile(file.path);
    const same = await this.uploadRepository
      .createQueryBuilder('u')
      .where('u.user_id = :user AND u.file_hash = :hash AND u.status <> :discarded', {
        user: user.id,
        hash: fileHash,
        discarded: CallUploadStatus.DISCARDED,
      })
      .orderBy('u.id', 'ASC')
      .getOne();
    if (same) {
      await fs.unlink(file.path).catch(() => undefined);
      return Object.assign(same, { duplicate: true });
    }
    const upload = new CallUpload();
    upload.user = user;
    upload.file_hash = fileHash;
    upload.recorded_at = meta.recorded_at ?? null;
    upload.caller_name = meta.caller_name ? meta.caller_name.slice(0, 255) : null;
    upload.file_name = (file.originalname || file.filename).slice(0, 255);
    upload.raw_path = file.filename;
    upload.duration = meta.duration ?? null;
    upload.from_number = meta.from_number ? meta.from_number.slice(0, 64) : null;
    upload.outgoing = meta.outgoing;
    upload.source = meta.source;
    upload.status = CallUploadStatus.PENDING;
    return this.uploadRepository.save(upload);
  }

  async queue(query: QueueQueryDto): Promise<any[]> {
    const qb = this.uploadRepository
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.user', 'user')
      .leftJoinAndSelect('u.recording', 'recording')
      .orderBy('u.received_at', 'DESC')
      .take(500);
    const status = query.status ?? 'all';
    if (status !== 'all') qb.andWhere('u.status = :status', { status });
    if (query.user_id) qb.andWhere('u.user_id = :user', { user: query.user_id });
    const rows = await qb.getMany();
    return rows.map((u) => ({
      id: u.id,
      user: u.user ? { id: u.user.id, username: u.user.username } : null,
      file_name: u.file_name,
      duration: u.duration === null ? null : Number(u.duration),
      from_number: u.from_number,
      caller_name: u.caller_name,
      recorded_at: u.recorded_at,
      outgoing: u.outgoing,
      source: u.source,
      status: u.status,
      error: u.error,
      recording_id: u.recording?.id ?? null,
      received_at: u.received_at,
      processed_at: u.processed_at,
    }));
  }

  async retry(id: number): Promise<CallUpload> {
    const upload = await this.uploadRepository.findOne({ where: { id } });
    if (!upload) throw new NotFoundException(`Upload ${id} does not exist`);
    if (upload.status === CallUploadStatus.DONE) throw new BadRequestException('This file is already processed');
    const raw = join(CallsService.uploadsDir(), upload.raw_path);
    try {
      await fs.access(raw);
    } catch {
      throw new BadRequestException('The received file is gone: upload it again');
    }
    upload.status = CallUploadStatus.PENDING;
    upload.error = null;
    upload.processed_at = null;
    return this.uploadRepository.save(upload);
  }

  async discard(id: number): Promise<{ discarded: boolean }> {
    const upload = await this.uploadRepository.findOne({ where: { id } });
    if (!upload) throw new NotFoundException(`Upload ${id} does not exist`);
    if (upload.status === CallUploadStatus.DONE) throw new BadRequestException('A processed file cannot be discarded');
    await fs.unlink(join(CallsService.uploadsDir(), upload.raw_path)).catch(() => undefined);
    upload.status = CallUploadStatus.DISCARDED;
    upload.processed_at = new Date();
    await this.uploadRepository.save(upload);
    return { discarded: true };
  }

  // ------------------------------------------------------------------ processing

  /** Right after an upload, without waiting for the scheduler: a call is in its deal seconds after it ends. */
  processSoon(): void {
    if (this.processing) {
      this.again = true;
      return;
    }
    setImmediate(() => {
      this.processPending().catch((error) => this.logger.warn(`processing after an upload: ${(error as Error).message}`));
    });
  }

  /** Converts and links every pending file; one broken file fails alone. `duplicate`: second copies of a call (in `done` too). */
  async processPending(limit = 50): Promise<{ done: number; failed: number; duplicate: number }> {
    if (this.processing) return { done: 0, failed: 0, duplicate: 0 };
    this.processing = true;
    const outcome = { done: 0, failed: 0, duplicate: 0 };
    try {
      const pending = await this.uploadRepository.find({
        where: { status: CallUploadStatus.PENDING },
        relations: { user: true },
        order: { received_at: 'ASC' },
        take: limit,
      });
      for (const upload of pending) {
        try {
          const result = await this.processOne(upload);
          upload.recording = result.recording;
          if (result.duplicateOf) {
            upload.status = CallUploadStatus.DUPLICATE;
            upload.error = `Повтор звонка: он уже есть (загрузка ${result.duplicateOf}), осталась более длинная запись`;
            outcome.duplicate++;
          } else {
            upload.status = CallUploadStatus.DONE;
            upload.error = null;
          }
          outcome.done++;
        } catch (error) {
          upload.status = CallUploadStatus.FAILED;
          upload.error = String((error as Error).message ?? error).slice(0, 2000);
          outcome.failed++;
          this.logger.warn(`call upload ${upload.id} (${upload.file_name}) failed: ${upload.error}`);
        }
        upload.processed_at = new Date();
        await this.uploadRepository.save(upload);
      }
    } finally {
      this.processing = false;
      if (this.again) {
        this.again = false;
        this.processSoon();
      }
    }
    return outcome;
  }

  private async processOne(upload: CallUpload): Promise<{ recording: Recording | null; duplicateOf?: number }> {
    const dir = CallsService.uploadsDir();
    const raw = join(dir, upload.raw_path);
    await fs.access(raw).catch(() => {
      throw new Error('the received file is missing on disk');
    });
    const target = `recording_${randomBytes(8).toString('hex')}.mp3`;
    // two minutes, and two more seconds per MB: an hour-long WAV takes a while
    await this.toMp3(raw, join(dir, target), 120_000 + Math.ceil((await CallsService.sizeOf(raw)) / (1024 * 1024)) * 2000);

    // The same call came before (the sync app sent it cut off, then whole): the longer copy stays.
    // Both went through the same ffmpeg settings, so the bigger mp3 is the longer audio.
    const earlier = await this.earlierCopy(upload);
    if (earlier && (await CallsService.sizeOf(join(dir, target))) <= (await CallsService.sizeOf(join(dir, earlier.path)))) {
      await fs.unlink(join(dir, target)).catch(() => undefined);
      await fs.unlink(raw).catch(() => undefined);
      const kept = await this.recordingRepository.findOne({ where: { id: earlier.recording_id } });
      return { recording: kept, duplicateOf: earlier.upload_id };
    }

    const duration = upload.duration ?? (await this.probeDurationMs(join(dir, target)));

    const client = await this.clientOf(upload);
    const recording = new Recording();
    recording.duration = duration ?? 0;
    recording.user = upload.user;
    recording.outgoing = upload.outgoing;
    recording.path = target;
    // no number in the file (a messenger call): the number of the client found by name, else the name
    recording.from_number = upload.from_number ?? client.contacts[0]?.phone ?? upload.caller_name ?? null;
    // a call synced later keeps its own time in the lists and the analytics
    if (upload.recorded_at) recording.created_at = upload.recorded_at;
    const saved = await this.recordingRepository.save(recording);

    // this is the whole call and its cut-off copy is in the history already: the history plays this file now
    const moved = earlier ? await this.replaceCopy(earlier, saved, upload) : 0;
    if (!moved) await this.linkToDeals(saved, upload, client);
    await fs.unlink(raw).catch(() => undefined);
    return { recording: saved };
  }

  /**
   * An earlier processed upload of the same call: the same manager and direction, the time of the
   * call within 5 seconds, and the same file name or the same number (the last 9 digits) — for a
   * messenger call without a number the same name. Only calls whose time is known (from the name of
   * the file or the file's time on the phone) are compared.
   */
  private async earlierCopy(upload: CallUpload): Promise<EarlierCopy | null> {
    if (!upload.recorded_at || !upload.user) return null;
    const digits = CallsService.digits(upload.from_number);
    const rows: EarlierCopy[] = await this.dataSource.query(
      `SELECT u.id AS upload_id, r.id AS recording_id, r.path
         FROM call_upload u JOIN recording r ON r.id = u.recording_id
        WHERE u.user_id = $1 AND u.id <> $2 AND u.status = $3 AND u.outgoing = $4 AND r.path IS NOT NULL
          AND u.recorded_at BETWEEN $5::timestamp - interval '5 seconds' AND $5::timestamp + interval '5 seconds'
          AND (u.file_name = $6
               OR ($7::text <> '' AND ${TAIL('u.from_number')} = $7::text)
               OR ($7::text = '' AND $8::text <> '' AND lower(btrim(COALESCE(u.caller_name, ''))) = $8::text))
        ORDER BY u.id ASC
        LIMIT 1`,
      [
        upload.user.id,
        upload.id ?? 0,
        CallUploadStatus.DONE,
        upload.outgoing,
        upload.recorded_at,
        upload.file_name,
        digits.length >= 7 ? digits.slice(-9) : '',
        String(upload.caller_name ?? '').trim().toLowerCase(),
      ],
    );
    return rows[0] ? { upload_id: Number(rows[0].upload_id), recording_id: Number(rows[0].recording_id), path: rows[0].path } : null;
  }

  /**
   * The earlier copy of this call was cut off: its history events (deals, the client's card) now play
   * the whole file, its upload points to the new recording as a `duplicate`, and its own recording row
   * and mp3 go — the call is counted once. Returns how many events were moved (0: the cut-off copy was
   * in no history, the new recording is linked as any other call).
   */
  private async replaceCopy(earlier: EarlierCopy, recording: Recording, upload: CallUpload): Promise<number> {
    const result = await this.dataSource.query(
      `UPDATE event
          SET after_state = jsonb_set(jsonb_set(COALESCE(after_state, '{}'::jsonb), '{path}', to_jsonb($2::text)), '{name}', to_jsonb($2::text)),
              duration = $3
        WHERE type = $4 AND after_state->>'path' = $1`,
      [earlier.path, recording.path, recording.duration ?? 0, EventTypes.NEW_CALL_RECORDING],
    );
    const moved = Array.isArray(result) ? Number(result[1] ?? 0) : 0;
    await this.uploadRepository.update(earlier.upload_id, {
      status: CallUploadStatus.DUPLICATE,
      recording: { id: recording.id } as Recording,
      error: `Обрезанная копия звонка: целая запись пришла позже (загрузка ${upload.id})`,
    });
    // a still shorter copy that came in between points to the cut-off recording: now to the whole one
    await this.dataSource.query(`UPDATE call_upload SET recording_id = $1 WHERE recording_id = $2`, [recording.id, earlier.recording_id]);
    await this.recordingRepository.delete(earlier.recording_id);
    await fs.unlink(join(CallsService.uploadsDir(), earlier.path)).catch(() => undefined);
    return moved;
  }

  private toMp3(input: string, output: string, timeout = 120_000): Promise<void> {
    const bin = CallsService.ffmpegBin();
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        ['-y', '-nostdin', '-loglevel', 'error', '-i', input, '-vn', '-acodec', 'libmp3lame', '-q:a', '5', output],
        { timeout },
        (error, _stdout, stderr) => {
          if (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
              return reject(new Error(`ffmpeg is not available (FFMPEG_BIN=${bin})`));
            }
            return reject(new Error(`ffmpeg: ${(stderr || error.message).trim().split('\n').pop()}`));
          }
          resolve();
        },
      );
    });
  }

  private probeDurationMs(file: string): Promise<number | null> {
    const bin = CallsService.ffmpegBin().replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
    return new Promise((resolve) => {
      execFile(bin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 30_000 }, (error, stdout) => {
        if (error) return resolve(null);
        const seconds = Number(String(stdout).trim());
        resolve(Number.isFinite(seconds) ? Math.round(seconds * 1000) : null);
      });
    });
  }

  /** The client of the call: by the number (or the company with that phone), or — a messenger call — by the name (CallClientService). */
  private async clientOf(upload: CallUpload): Promise<CallClient> {
    return this.callClients.find({
      managerId: upload.user.id,
      number: upload.from_number,
      name: upload.caller_name,
      fileName: upload.file_name,
    });
  }

  /**
   * The call in the history of its client, ONE deal per call by the rule of the messengers
   * (ClientDealsService.dealForMessage), without opening a deal:
   *  - the client's open deal with the manager whose phone recorded it: the one the conversation goes on
   *    in (the latest message or call with the client), else the newest;
   *  - otherwise another manager's open deal with the client that is alive (its manager is still on the
   *    staff, something happened in it within MESSENGER_FOREIGN_DEAL_DAYS days): the latest active one;
   *  - otherwise no deal: a phone records private calls too, so no deal is opened by itself («Создать
   *    сделку» does that); the call goes on the client's card (an event without a deal, the contact card
   *    shows it), so a regular client whose deals are closed still has the call in the history.
   * A number that is the phone of a company (no contact has it): the deals of that company, the event
   * from its primary contact. The «записан звонок» triggers run for the deals only.
   * Before, every open deal of every contact with these digits got the call — other managers' deals and
   * other companies' too, each firing its triggers — and a client without an open deal got nothing.
   */
  private async linkToDeals(recording: Recording, upload: CallUpload, client: CallClient): Promise<number> {
    const contacts = client.contacts ?? [];
    const companyId = client.company?.id ?? null;
    if (contacts.length === 0 && !companyId) return 0;

    const deals = await this.dealsForCall(upload.user.id, contacts.map((c) => c.id), companyId);
    // awaited: the history rows exist before the next file is processed (a second copy of this call moves them)
    const write = async (deal: Deal | null, contact: User | null) => {
      const eventData: CallRecordingEventDto = { recording, deal, originated_by: contact, target_user: upload.user };
      await this.eventEmitter
        .emitAsync(EventTypes.NEW_CALL_RECORDING.toString(), eventData)
        .catch((error) => this.logger.warn(`call recording ${recording.id}: history event failed: ${(error as Error).message}`));
    };
    for (const deal of deals) {
      await write(deal, deal.ctr_agents?.find((c) => contacts.some((x) => x.id === c.id)) ?? contacts[0] ?? null);
    }
    if (deals.length === 0) {
      // several contacts with one number (a shared line): each card gets it, a handful at most
      for (const contact of contacts.slice(0, 5)) await write(null, contact);
    }
    return deals.length;
  }

  /** linkToDeals: the one deal of the call (see there), or none. */
  private async dealsForCall(managerId: number, contactIds: number[], companyId: number | null): Promise<Deal[]> {
    const params: any[] = [contactIds, companyId, CALL_CHAT_TYPES, STAFF];
    const rows: { id: number; own: boolean; active: boolean; last_chat_at: Date | null; last_event_at: Date | null; created_at: Date }[] =
      await this.dataSource.query(
        `SELECT d.id, (d.agent_id = $5) AS own, d.created_at,
                (a.id IS NOT NULL AND a.deleted_at IS NULL AND a.role::text = ANY($4::text[])) AS active,
                (SELECT max(e.created_at) FROM event e
                  WHERE e.deal_id = d.id AND e.type = ANY($3::int[])
                    AND (e.user_id = ANY($1::int[]) OR e.target_user_id = ANY($1::int[]))) AS last_chat_at,
                (SELECT max(e.created_at) FROM event e WHERE e.deal_id = d.id) AS last_event_at
           FROM deal d
           LEFT JOIN "user" a ON a.id = d.agent_id
          WHERE d.closed_at IS NULL AND d.deleted_at IS NULL
            AND (EXISTS (SELECT 1 FROM deal_user cdu WHERE cdu."dealId" = d.id AND cdu."userId" = ANY($1::int[]))
                 OR ($2::int IS NOT NULL AND d.company_id = $2::int))
          ORDER BY d.id DESC`,
        [...params, managerId],
      );
    const time = (value: Date | null) => (value ? new Date(value).getTime() : 0);
    let chosen: number | null = null;
    const own = rows.filter((r) => r.own);
    if (own.length) {
      chosen = [...own].sort((a, b) => time(b.last_chat_at) - time(a.last_chat_at) || b.id - a.id)[0].id;
    } else {
      const days = ClientDealsService.foreignDealDays();
      const since = Date.now() - days * 24 * 3600 * 1000;
      const live = rows
        .filter((r) => r.active && (days === 0 || Math.max(time(r.last_event_at), time(r.created_at)) >= since))
        .sort((a, b) => Math.max(time(b.last_event_at), time(b.created_at)) - Math.max(time(a.last_event_at), time(a.created_at)) || b.id - a.id);
      chosen = live[0]?.id ?? null;
    }
    if (!chosen) return [];
    const deal = await this.dealRepository.findOne({ where: { id: chosen }, relations: { agent: true, ctr_agents: true } });
    return deal ? [deal] : [];
  }

  // ------------------------------------------------------------------ recordings

  /** Every recording (the admin's list): filters by manager, days and number; each with its client and deal. */
  async recordings(query: RecordingsQueryDto, access?: Access): Promise<{ data: CallRow[]; count: number; page: number; limit: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const qb = this.recordingRepository
      .createQueryBuilder('r')
      .leftJoinAndSelect('r.user', 'user')
      .orderBy('r.created_at', 'DESC')
      .addOrderBy('r.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    if (query.user_id) qb.andWhere('r.user_id = :user', { user: query.user_id });
    if (query.from) qb.andWhere('r.created_at >= :from', { from: query.from });
    if (query.till) qb.andWhere("r.created_at < (CAST(:till AS date) + interval '1 day')", { till: query.till });
    if (query.direction) qb.andWhere(query.direction === 'out' ? 'r.outgoing = true' : 'r.outgoing = false');
    if (query.number) {
      const digits = CallsService.digits(query.number);
      if (digits) qb.andWhere(`${DIGITS('r.from_number')} LIKE :num`, { num: '%' + digits + '%' });
    }
    const [rows, count] = await qb.getManyAndCount();
    return { data: await this.describe(rows, access), count, page, limit };
  }

  /**
   * «Записи звонков» (GET /calls/list): the calls, newest first, with the manager, the client, the deal,
   * the direction and the duration; filters by manager, days, direction and number. Admin and manager
   * see everybody's calls (user_id picks one person); anybody else sees their own recordings only
   * (the rule of GET /calls/staff/:id), and a deal they may not see is not named.
   */
  async listCalls(query: CallListQueryDto, access: Access): Promise<{ data: CallRow[]; count: number; page: number; limit: number }> {
    const own = !access.isManager;
    return this.recordings(
      { ...query, limit: query.limit ?? 25, user_id: own ? access.id : query.user_id } as RecordingsQueryDto,
      own ? access : undefined,
    );
  }

  /** The recordings of one staff member (their own page «Записи звонков»), newest first, with client and deal. */
  async staffRecordings(userId: number, query: CallFeedQueryDto): Promise<{ data: CallRow[]; count: number; page: number; limit: number }> {
    return this.recordings({ ...query, user_id: userId } as RecordingsQueryDto);
  }

  /**
   * Every call with a company (the «Звонки» tab of its card): the calls in the history of its deals or
   * of its contacts' cards, and the calls from or to the numbers of its contacts and of the company
   * itself that are in no history (made before the contact was entered, or never linked). Newest
   * first, with the manager, the direction, the duration, the contact and the deal.
   * `access` (anybody but admin and manager): as in the company's feed (EventsService.fetchCompanyEvents),
   * the calls of the deals they may not see are left out — the user's own recordings stay — and a deal
   * they may not see is not named.
   */
  async companyCalls(
    companyId: number,
    query: CallFeedQueryDto,
    access?: Access,
  ): Promise<{ data: CallRow[]; count: number; page: number; limit: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const [company] = await this.dataSource.query(`SELECT 1 FROM company WHERE id = $1 AND deleted_at IS NULL`, [companyId]);
    if (!company) throw new NotFoundException(`Company ${companyId} not found`);
    const params: any[] = [companyId, EventTypes.NEW_CALL_RECORDING];
    const visible = CallsService.visibleDealSql(access, 'vd', params);
    let period = '';
    if (query.from) {
      params.push(query.from);
      period += ` AND r.created_at >= $${params.length}`;
    }
    if (query.till) {
      params.push(query.till);
      period += ` AND r.created_at < (CAST($${params.length} AS date) + interval '1 day')`;
    }
    if (query.direction) period += query.direction === 'out' ? ' AND r.outgoing' : ' AND NOT r.outgoing';
    let scope = '';
    if (visible) {
      params.push(access.id);
      // a call that is in the history of a deal the user may not see: only when it is their own recording
      scope = ` AND (r.user_id = $${params.length} OR NOT EXISTS (
          SELECT 1 FROM event he JOIN deal vd ON vd.id = he.deal_id
           WHERE he.type = $2 AND he.after_state->>'path' = r.path AND NOT (${visible})))`;
    }
    // two halves, so that the second one can use the index on the last 9 digits (IDX_recording_number_tail);
    // a call on a contact's card: the contact is the event's user (an incoming call) or its target (outgoing)
    const where = `r.id IN (
        SELECT lr.id FROM recording lr
         WHERE lr.path IN (
           SELECT e.after_state->>'path' FROM event e
            WHERE e.type = $2 AND (
              e.deal_id IN (SELECT d.id FROM deal d WHERE d.deleted_at IS NULL AND (d.company_id = $1
                            OR EXISTS (SELECT 1 FROM deal_user du JOIN "user" cu ON cu.id = du."userId" WHERE du."dealId" = d.id AND cu.company_id = $1)))
              OR (e.deal_id IS NULL AND (e.user_id IN (SELECT cu.id FROM "user" cu WHERE cu.company_id = $1 AND cu.role = 'ctr_agent')
                                          OR e.target_user_id IN (SELECT cu.id FROM "user" cu WHERE cu.company_id = $1 AND cu.role = 'ctr_agent')))))
        UNION
        SELECT nr.id FROM recording nr
         WHERE ${TAIL('nr.from_number')} IN (
           SELECT ${TAIL('cu.phone')} FROM "user" cu
            WHERE cu.company_id = $1 AND cu.role = 'ctr_agent' AND cu.deleted_at IS NULL AND length(${DIGITS('cu.phone')}) >= 7
           UNION
           SELECT ${TAIL('c.phone')} FROM company c WHERE c.id = $1 AND length(${DIGITS('c.phone')}) >= 7)
      )${period}${scope}`;
    const [{ count }] = await this.dataSource.query(`SELECT COUNT(*)::int AS count FROM recording r WHERE ${where}`, params);
    const ids: { id: number }[] = await this.dataSource.query(
      `SELECT r.id FROM recording r WHERE ${where}
        ORDER BY r.created_at DESC, r.id DESC LIMIT ${Number(limit)} OFFSET ${Number((page - 1) * limit)}`,
      params,
    );
    const rows = ids.length
      ? await this.recordingRepository.find({ where: { id: In(ids.map((r) => Number(r.id))) }, relations: { user: true } })
      : [];
    const order = new Map(ids.map((r, i) => [Number(r.id), i]));
    rows.sort((a, b) => order.get(a.id) - order.get(b.id));
    return { data: await this.describe(rows, access), count: Number(count), page, limit };
  }

  /**
   * SQL (positional parameters appended to `params`) true for the deals of `alias` the user may see, by
   * Access.dealSql's rule; null — every deal (no access given, admin, manager, the scope "all").
   */
  private static visibleDealSql(access: Access | undefined, alias: string, params: any[]): string | null {
    if (!access) return null;
    const scope = access.scope('deal', 'view');
    if (scope === 'all') return null;
    if (scope === 'none') return 'FALSE';
    params.push(access.id);
    const me = `$${params.length}`;
    const group = access.user.group_id;
    if (scope === 'own' || group === null || group === undefined) return `${alias}.agent_id = ${me}`;
    params.push(group);
    return `(${alias}.agent_id = ${me} OR ${alias}.agent_id IN (SELECT vg.id FROM "user" vg WHERE vg.group_id = $${params.length}))`;
  }

  /**
   * The rows of a list: the deal and the contact from the call's history events (a deal first, the
   * newest one; with `access` only a deal the user may see); the contact of a call that is in no
   * history by its number (the last 9 digits).
   */
  private async describe(rows: Recording[], access?: Access): Promise<CallRow[]> {
    const paths = rows.map((r) => r.path).filter(Boolean);
    const params: any[] = [EventTypes.NEW_CALL_RECORDING, paths];
    const visible = CallsService.visibleDealSql(access, 'd', params);
    const links: { path: string; deal_id: number | null; label: string | null; contact_id: number | null; contact_name: string | null }[] = paths.length
      ? await this.dataSource.query(
          `SELECT DISTINCT ON (e.after_state->>'path') e.after_state->>'path' AS path, d.id AS deal_id, d.label,
                  cu.id AS contact_id, cu.username AS contact_name
             FROM event e
             LEFT JOIN deal d ON d.id = e.deal_id AND d.deleted_at IS NULL${visible ? ` AND ${visible}` : ''}
             LEFT JOIN "user" cu ON cu.role = 'ctr_agent' AND cu.id IN (e.user_id, e.target_user_id)
            WHERE e.type = $1 AND e.after_state->>'path' = ANY($2)
            ORDER BY e.after_state->>'path', (d.id IS NULL), (cu.id IS NULL), e.id DESC`,
          params,
        )
      : [];
    const linkOf = new Map(links.map((l) => [l.path, l]));
    const tails = [
      ...new Set(
        rows
          .filter((r) => !linkOf.get(r.path)?.contact_id)
          .map((r) => CallsService.digits(r.from_number))
          .filter((d) => d.length >= 7)
          .map((d) => d.slice(-9)),
      ),
    ];
    const byNumber: { tail: string; id: number; username: string }[] = tails.length
      ? await this.dataSource.query(
          `SELECT DISTINCT ON (t.tail) t.tail, u.id, u.username
             FROM unnest($1::text[]) AS t(tail)
             JOIN "user" u ON u.role = 'ctr_agent' AND u.deleted_at IS NULL AND ${DIGITS('u.phone')} LIKE '%' || t.tail
            ORDER BY t.tail, u.id`,
          [tails],
        )
      : [];
    const contactOf = new Map(byNumber.map((c) => [c.tail, { id: Number(c.id), username: c.username }]));
    return rows.map((r) => {
      const link = linkOf.get(r.path);
      const digits = CallsService.digits(r.from_number);
      let contact: CallRow['contact'] = null;
      if (link?.contact_id) contact = { id: Number(link.contact_id), username: link.contact_name };
      else if (digits.length >= 7) contact = contactOf.get(digits.slice(-9)) ?? null;
      return {
        id: r.id,
        created_at: r.created_at,
        duration: Number(r.duration),
        outgoing: r.outgoing,
        path: r.path,
        from_number: r.from_number,
        user: r.user ? { id: r.user.id, username: r.user.username } : null,
        contact,
        deal: link?.deal_id ? { id: Number(link.deal_id), label: link.label } : null,
      };
    });
  }

  /** For the upload guard: the user given by the Telegram service's folder scanner. */
  async staffUser(id: number): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id, role: In(STAFF) } });
    if (!user) throw new UnauthorizedException();
    return user;
  }
}
