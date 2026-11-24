import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { loadStaffUser } from './bot-access';
import { BotService } from './bot.service';
import { BotCrmService, TaskView, localStamp } from './bot-crm.service';

/** TypeORM returns [rows, count] for INSERT ... ON CONFLICT DO UPDATE ... RETURNING on Postgres. */
function returned(result: any): any[] {
  return Array.isArray(result?.[0]) ? result[0] : result ?? [];
}

/**
 * Reminders before tasks and the morning digest, sent by the bot to managers
 * who linked their Telegram. No AI here.
 *
 * A task is reminded to its assignee, a task of a group to every member of the group who linked the bot
 * and may close it. A bot_reminder row marks a task as reminded for its start time: a task moved to
 * another time is reminded again (TaskService.update also removes the row when it is handed over).
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
    private crm: BotCrmService,
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

  /**
   * Tasks starting within CRM_BOT_REMIND_BEFORE_MIN (or that started at most 2 minutes ago: a pass may be late):
   * each once per start time — bot_reminder keeps the start it was reminded for, so a task moved by any path
   * (the web, the bot, a trigger) is reminded again before its new start. A task that started earlier is not
   * reminded with «сейчас» (the digest and /tasks have it). To the assignee, or to every member of the task's group
   * who may see and close it (as the web); one message per chat for the tasks of one pass.
   */
  private async remindDueTasks() {
    const now = new Date();
    const before = Math.max(1, Number(process.env.CRM_BOT_REMIND_BEFORE_MIN || 15));
    const rows: { id: number; start_time: Date }[] = await this.dataSource.query(
      `SELECT t.id, t.start_time
       FROM task t
       LEFT JOIN deal d ON d.id = t.deal_id
       WHERE t.closed_at IS NULL AND NOT t."allDay"
         AND t.start_time > $1 AND t.start_time <= $2
         AND (d.id IS NULL OR d.deleted_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM bot_reminder r WHERE r.task_id = t.id AND r.start_time = t.start_time)
         AND EXISTS (SELECT 1 FROM bot_account ba JOIN "user" bu ON bu.id = ba.user_id
                      WHERE bu.deleted_at IS NULL
                        AND (ba.user_id = t.agent_id OR (t.agent_id IS NULL AND bu.group_id = t.group_id)))
       ORDER BY t.start_time, t.id
       LIMIT 200`,
      [new Date(now.getTime() - 2 * 60_000), new Date(now.getTime() + before * 60_000)],
    );
    const byChat = new Map<string, { userId: number; tasks: TaskView[] }>();
    for (const t of rows) {
      // claim first, so two instances or a slow send never remind twice about the same start
      const claimed = await this.dataSource.query(
        `INSERT INTO bot_reminder (task_id, start_time) VALUES ($1, $2)
         ON CONFLICT (task_id) DO UPDATE SET start_time = EXCLUDED.start_time, sent_at = now()
           WHERE bot_reminder.start_time IS DISTINCT FROM EXCLUDED.start_time
         RETURNING task_id`,
        [t.id, t.start_time],
      );
      if (!returned(claimed).length) continue;
      for (const r of await this.crm.taskRecipients(t.id)) {
        const entry = byChat.get(r.chatId) ?? { userId: r.user.sub, tasks: [] };
        entry.tasks.push(r.task);
        byChat.set(r.chatId, entry);
      }
    }
    for (const [chatId, entry] of byChat) {
      await this.bot
        .sendReminder(chatId, entry.userId, entry.tasks, now)
        .catch((error) => this.logger.warn(`reminder to user ${entry.userId}: ${(error as Error).message}`));
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
      if (!returned(updated).length) continue;
      const user = await loadStaffUser(this.dataSource, account.user_id);
      if (!user) continue;
      await this.bot
        .sendTasks(user, String(account.chat_id), true)
        .catch((error) => this.logger.warn(`digest for user ${account.user_id}: ${(error as Error).message}`));
    }
  }
}
