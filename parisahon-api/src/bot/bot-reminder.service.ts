import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { loadStaffUser } from './bot-access';
import { BotService } from './bot.service';
import { humanStamp, localStamp } from './bot-crm.service';

/**
 * Reminders before tasks and the morning digest, sent by the bot to managers
 * who linked their Telegram. No AI here.
 *
 * A task is reminded to its assignee, a task of a group to every member of the group who linked
 * the bot. A bot_reminder row marks a task as reminded; TaskService.update removes it when the task
 * is moved to another time or handed to someone else, so the new time is reminded again.
 *
 *   CRM_BOT_REMINDER_SEC        how often to look for due tasks (default 60)
 *   CRM_BOT_REMIND_BEFORE_MIN   remind this many minutes before the start (default 15)
 *   CRM_BOT_DIGEST_HOUR         local hour of the morning digest (default 9, -1 = off)
 *   CRM_BOT_DIGEST_WINDOW_H     the digest is sent only within this many hours after it (default 3)
 */
@Injectable()
export class BotReminderService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BotReminderService.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private dataSource: DataSource,
    private bot: BotService,
  ) {}

  onApplicationBootstrap() {
    if (!(process.env.CRM_BOT_TOKEN || '').trim()) return;
    const every = Math.max(5, Number(process.env.CRM_BOT_REMINDER_SEC || 60));
    this.timer = setInterval(() => void this.tick(), every * 1000);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.ticking || !this.bot.enabled) return;
    this.ticking = true;
    try {
      await this.remindDueTasks();
      await this.sendDigests();
    } catch (error) {
      this.logger.error(`reminders: ${(error as Error)?.stack ?? error}`);
    } finally {
      this.ticking = false;
    }
  }

  private async remindDueTasks() {
    const now = new Date();
    const before = Math.max(1, Number(process.env.CRM_BOT_REMIND_BEFORE_MIN || 15));
    // to the assignee, or to the members of the task's group, who linked the bot
    const rows = await this.dataSource.query(
      `SELECT t.id, t.label, t.start_time, t.agent_id, t.group_id, g.name AS group_name, tt.name AS type,
         coalesce(c.name, dc.name) AS company, d.display_id AS deal_number
       FROM task t
       LEFT JOIN task_type tt ON tt.id = t.type_id
       LEFT JOIN "group" g ON g.id = t.group_id
       LEFT JOIN company c ON c.id = t.company_id
       LEFT JOIN deal d ON d.id = t.deal_id
       LEFT JOIN company dc ON dc.id = d.company_id
       WHERE t.closed_at IS NULL AND NOT t."allDay"
         AND t.start_time > $1 AND t.start_time <= $2
         AND (d.id IS NULL OR d.deleted_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM bot_reminder r WHERE r.task_id = t.id)
         AND EXISTS (SELECT 1 FROM bot_account ba JOIN "user" bu ON bu.id = ba.user_id
                      WHERE bu.deleted_at IS NULL
                        AND (ba.user_id = t.agent_id OR (t.agent_id IS NULL AND bu.group_id = t.group_id)))
       ORDER BY t.start_time
       LIMIT 200`,
      [new Date(now.getTime() - 10 * 60_000), new Date(now.getTime() + before * 60_000)],
    );
    for (const t of rows) {
      // claim first, so two instances or a slow send never remind twice
      const claimed = await this.dataSource.query(
        'INSERT INTO bot_reminder (task_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING task_id',
        [t.id],
      );
      if (!claimed.length) continue;
      const minutes = Math.round((new Date(t.start_time).getTime() - now.getTime()) / 60_000);
      const when = minutes > 0 ? `через ${minutes} мин, в ${localStamp(t.start_time).split(' ')[1]}` : `сейчас (${humanStamp(t.start_time)})`;
      const about = [t.company, t.deal_number ? `сделка №${t.deal_number}` : null].filter(Boolean).join(', ');
      const forGroup = t.agent_id === null && t.group_name ? `\nЗадача группы «${t.group_name}»` : '';
      const text = `⏰ ${t.type ?? 'Задача'} ${when}:\n${t.label}${about ? `\n${about}` : ''}${forGroup}`;
      const people: { user_id: number; chat_id: string }[] = await this.dataSource.query(
        `SELECT ba.user_id, ba.chat_id FROM bot_account ba JOIN "user" bu ON bu.id = ba.user_id
         WHERE bu.deleted_at IS NULL
           AND (ba.user_id = $1::int OR ($1::int IS NULL AND $2::int IS NOT NULL AND bu.group_id = $2::int))`,
        [t.agent_id, t.group_id],
      );
      for (const person of people) {
        if (!(await loadStaffUser(this.dataSource, person.user_id))) continue;
        await this.bot
          .send(person.chat_id, text, [[{ text: '✅ Выполнено', callback_data: `done:${t.id}` }]])
          .catch((error) => this.logger.warn(`reminder for task ${t.id} to user ${person.user_id}: ${(error as Error).message}`));
      }
    }
  }

  private async sendDigests() {
    const hour = Number(process.env.CRM_BOT_DIGEST_HOUR ?? 9);
    if (hour < 0) return;
    const now = new Date();
    const window = Math.max(1, Number(process.env.CRM_BOT_DIGEST_WINDOW_H || 3));
    if (now.getHours() < hour || now.getHours() >= hour + window) return;
    const today = localStamp(now, false);
    const accounts = await this.dataSource.query(
      'SELECT user_id, chat_id FROM bot_account WHERE digest_on IS NULL OR digest_on < $1::date',
      [today],
    );
    for (const account of accounts) {
      const updated = await this.dataSource.query(
        `UPDATE bot_account SET digest_on = $2::date
         WHERE user_id = $1 AND (digest_on IS NULL OR digest_on < $2::date) RETURNING user_id`,
        [account.user_id, today],
      );
      const rows = Array.isArray(updated?.[0]) ? updated[0] : updated;
      if (!rows?.length) continue;
      const user = await loadStaffUser(this.dataSource, account.user_id);
      if (!user) continue;
      await this.bot
        .sendTasks(user, String(account.chat_id), true)
        .catch((error) => this.logger.warn(`digest for user ${account.user_id}: ${(error as Error).message}`));
    }
  }
}
