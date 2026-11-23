import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthUser } from '../auth/auth.guard';
import { Access } from '../auth/access';
import { RoleEnum } from '../user/user.entity';
import { phoneKey, phoneKeySql } from '../helper/phone';

export type Channel = 'telegram' | 'whatsapp';
export const CHANNELS: Channel[] = ['telegram', 'whatsapp'];

/** What a messenger tells about the other side of a chat. */
export interface ChatIdentity {
  tgId?: number | string | null;
  waId?: string | null;
  phone?: string | null;
}

export interface IgnoredChat {
  id: number;
  agent_id: number;
  channel: Channel | null;
  tg_id: string | null;
  wa_id: string | null;
  phone_key: string | null;
  label: string | null;
  contact_id: number | null;
  created_at: Date;
}

const STAFF_ROLES = [RoleEnum.ADMIN, RoleEnum.MANAGER, RoleEnum.AGENT];

/** The last 9 digits of a phone ('+998 90 123-45-67' and '90 123 45 67' give the same key), or null (helper/phone.ts). */
export function keyOf(phone?: string | null): string | null {
  return phoneKey(phone ?? null);
}

/**
 * SQL: the phone key of a column, exactly as helper/phone.ts writes it (the expression index of the
 * contacts). A number shorter than 9 digits gives a shorter text, so it never equals a key.
 */
export const PHONE_KEY_SQL = (column: string) => phoneKeySql(column);

/**
 * Which chats of a manager's own Telegram / WhatsApp are not for the CRM (TG-4, WA-2):
 *  - a colleague: the chat's Telegram id or phone (the last 9 digits) is a staff user's: never a client;
 *  - a chat the manager marked «Не клиент» (table messenger_ignore, per manager: family, friends,
 *    suppliers), by Telegram id, WhatsApp chat id or phone;
 *  - «только известные контакты» (messenger_account.known_only per manager and messenger, else the
 *    global TELEGRAM_KNOWN_CONTACTS_ONLY): a chat with somebody who is not in the CRM creates nothing.
 * Contacts and deals that were made from such chats before are not deleted: the manager decides.
 */
@Injectable()
export class MessengerFilterService {
  constructor(private dataSource: DataSource) {}

  static globalKnownOnly(): boolean {
    return ['1', 'true', 'yes'].includes(String(process.env.TELEGRAM_KNOWN_CONTACTS_ONLY ?? '').toLowerCase());
  }

  /** 'staff' / 'not_client' when the chat is not for the CRM, else null. */
  async reasonToIgnore(agentId: number, channel: Channel, chat: ChatIdentity): Promise<string | null> {
    if (await this.isStaff(chat)) return 'staff';
    if (await this.isIgnored(agentId, channel, chat)) return 'not_client';
    return null;
  }

  async isStaff(chat: ChatIdentity): Promise<boolean> {
    const tg = Number(chat.tgId) > 0 ? String(chat.tgId) : null;
    const key = keyOf(chat.phone);
    if (!tg && !key) return false;
    const rows = await this.dataSource.query(
      `SELECT 1 FROM "user" u
        WHERE u.deleted_at IS NULL AND u.role = ANY($1)
          AND (($2::bigint IS NOT NULL AND u.tg_id = $2::bigint) OR ($3::text IS NOT NULL AND ${PHONE_KEY_SQL('u.phone')} = $3::text))
        LIMIT 1`,
      [STAFF_ROLES, tg, key],
    );
    return rows.length > 0;
  }

  async isIgnored(agentId: number, channel: Channel, chat: ChatIdentity): Promise<boolean> {
    const tg = Number(chat.tgId) > 0 ? String(chat.tgId) : null;
    const wa = chat.waId ? String(chat.waId) : null;
    const key = keyOf(chat.phone);
    if (!tg && !wa && !key) return false;
    const rows = await this.dataSource.query(
      `SELECT 1 FROM messenger_ignore i
        WHERE i.agent_id = $1 AND (i.channel IS NULL OR i.channel = $2)
          AND (($3::bigint IS NOT NULL AND i.tg_id = $3::bigint) OR ($4::text IS NOT NULL AND i.wa_id = $4::text)
               OR ($5::text IS NOT NULL AND i.phone_key = $5::text))
        LIMIT 1`,
      [agentId, channel, tg, wa, key],
    );
    return rows.length > 0;
  }

  /** «Только известные контакты» of this manager in this messenger (the global env when not set). */
  async knownOnly(agentId: number, channel: Channel): Promise<boolean> {
    const rows = await this.dataSource.query(
      `SELECT known_only FROM messenger_account WHERE user_id = $1 AND channel = $2`,
      [agentId, channel],
    );
    const value = rows[0]?.known_only;
    return typeof value === 'boolean' ? value : MessengerFilterService.globalKnownOnly();
  }

  // ------------------------------------------------------------------ settings of a manager

  async settings(me: AuthUser, userId?: number) {
    const owner = await this.ownerOf(me, userId);
    const rows: { channel: Channel; known_only: boolean | null }[] = await this.dataSource.query(
      `SELECT channel, known_only FROM messenger_account WHERE user_id = $1`,
      [owner],
    );
    const fallback = MessengerFilterService.globalKnownOnly();
    const of = (channel: Channel) => {
      const value = rows.find((r) => r.channel === channel)?.known_only;
      return typeof value === 'boolean' ? value : fallback;
    };
    return { user_id: owner, known_only: { telegram: of('telegram'), whatsapp: of('whatsapp') }, default_known_only: fallback };
  }

  async updateSettings(me: AuthUser, body: { user_id?: number; channel?: string; known_only?: boolean | null }) {
    const owner = await this.ownerOf(me, body.user_id);
    const channels = body.channel ? [this.channelOf(body.channel)] : CHANNELS;
    if (body.known_only !== null && typeof body.known_only !== 'boolean') {
      throw new BadRequestException('known_only: true, false или null (как задано на сервере)');
    }
    for (const channel of channels) {
      await this.dataSource.query(
        `INSERT INTO messenger_account (user_id, channel, known_only) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, channel) DO UPDATE SET known_only = EXCLUDED.known_only`,
        [owner, channel, body.known_only],
      );
    }
    return this.settings(me, owner);
  }

  // ------------------------------------------------------------------ «Не клиент»

  async list(me: AuthUser, userId?: number): Promise<IgnoredChat[]> {
    const owner = await this.ownerOf(me, userId);
    return this.dataSource.query(
      `SELECT id, agent_id, channel, tg_id::text AS tg_id, wa_id, phone_key, label, contact_id, created_at
         FROM messenger_ignore WHERE agent_id = $1 ORDER BY created_at DESC, id DESC`,
      [owner],
    );
  }

  /**
   * «Не клиент»: the chats of this person stop coming into the CRM for the manager. From a contact
   * (its Telegram id, WhatsApp chat id and phone), or from a phone typed by hand. Called from a deal,
   * the list is the deal's manager's (whose messenger got the chat); otherwise the requester's own,
   * another user's only for an admin.
   */
  async add(
    me: AuthUser,
    body: { contact_id?: number; deal_id?: number; user_id?: number; phone?: string; channel?: string; label?: string },
  ): Promise<IgnoredChat> {
    const owner = body.deal_id ? await this.ownerOfDeal(me, Number(body.deal_id)) : await this.ownerOf(me, body.user_id);
    const channel = body.channel ? this.channelOf(body.channel) : null;
    let tg: string | null = null;
    let wa: string | null = null;
    let key: string | null = null;
    let label = String(body.label ?? '').trim() || null;
    let contactId: number | null = null;
    if (body.contact_id) {
      const rows = await this.dataSource.query(
        `SELECT id, username, phone, tg_id::text AS tg_id, wa_id, role FROM "user" WHERE id = $1 AND deleted_at IS NULL`,
        [Number(body.contact_id)],
      );
      const contact = rows[0];
      if (!contact) throw new NotFoundException('Контакт не найден');
      if (contact.role !== RoleEnum.CTR_AGENT) throw new BadRequestException('Это не контакт клиента');
      tg = contact.tg_id || null;
      wa = contact.wa_id || null;
      key = keyOf(contact.phone);
      label = label || [contact.username, contact.phone].filter(Boolean).join(' · ') || null;
      contactId = contact.id;
    } else {
      key = keyOf(body.phone);
      if (!key) throw new BadRequestException('Укажите контакт или номер телефона (не меньше 9 цифр)');
      label = label || String(body.phone).trim();
    }
    if (!tg && !wa && !key) {
      throw new BadRequestException('У контакта нет ни Telegram, ни WhatsApp, ни телефона: отмечать нечего');
    }
    const columns = 'id, agent_id, channel, tg_id::text AS tg_id, wa_id, phone_key, label, contact_id, created_at';
    const existing: IgnoredChat[] = await this.dataSource.query(
      `SELECT ${columns} FROM messenger_ignore
        WHERE agent_id = $1 AND channel IS NOT DISTINCT FROM $2::varchar AND tg_id IS NOT DISTINCT FROM $3::bigint
          AND wa_id IS NOT DISTINCT FROM $4::varchar AND phone_key IS NOT DISTINCT FROM $5::varchar`,
      [owner, channel, tg, wa, key],
    );
    if (existing.length) return existing[0];
    const rows: IgnoredChat[] = await this.dataSource.query(
      `INSERT INTO messenger_ignore (agent_id, channel, tg_id, wa_id, phone_key, label, contact_id, created_by)
       VALUES ($1, $2, $3::bigint, $4, $5, $6, $7, $8)
       RETURNING ${columns}`,
      [owner, channel, tg, wa, key, label ? label.slice(0, 255) : null, contactId, me.sub],
    );
    return rows[0];
  }

  async remove(me: AuthUser, id: number): Promise<{ removed: boolean }> {
    const rows = await this.dataSource.query(`SELECT agent_id FROM messenger_ignore WHERE id = $1`, [id]);
    if (!rows[0]) throw new NotFoundException('Нет такой записи');
    if (Number(rows[0].agent_id) !== me.sub && me.role !== RoleEnum.ADMIN) {
      throw new ForbiddenException('Это список другого сотрудника');
    }
    await this.dataSource.query(`DELETE FROM messenger_ignore WHERE id = $1`, [id]);
    return { removed: true };
  }

  // ------------------------------------------------------------------ helpers

  private channelOf(value: string): Channel {
    if (value !== 'telegram' && value !== 'whatsapp') throw new BadRequestException('channel: telegram или whatsapp');
    return value;
  }

  /** The requester, or another staff user for an admin. */
  private async ownerOf(me: AuthUser, userId?: number): Promise<number> {
    const id = Number(userId) || me.sub;
    if (id === me.sub) return id;
    if (me.role !== RoleEnum.ADMIN) throw new ForbiddenException('Это настройки другого сотрудника');
    const rows = await this.dataSource.query(`SELECT role FROM "user" WHERE id = $1 AND deleted_at IS NULL`, [id]);
    if (!rows[0]) throw new NotFoundException(`User with id ${id} does not exist!`);
    if (!STAFF_ROLES.includes(rows[0].role)) throw new BadRequestException('Это не сотрудник');
    return id;
  }

  /** The deal's manager, when the requester may change the deal (else 403 / 404). */
  private async ownerOfDeal(me: AuthUser, dealId: number): Promise<number> {
    const rows = await this.dataSource.query(
      `SELECT d.agent_id, a.group_id FROM deal d LEFT JOIN "user" a ON a.id = d.agent_id WHERE d.id = $1 AND d.deleted_at IS NULL`,
      [dealId],
    );
    const deal = rows[0];
    const access = new Access(me);
    if (!deal || !access.allowsDeal('view', deal.agent_id ?? null, deal.group_id ?? null)) {
      throw new NotFoundException(`Deal with id ${dealId} does not exist!`);
    }
    if (!access.allowsDeal('update', deal.agent_id ?? null, deal.group_id ?? null)) {
      throw new ForbiddenException('Нет права менять эту сделку');
    }
    return Number(deal.agent_id) || me.sub;
  }
}
