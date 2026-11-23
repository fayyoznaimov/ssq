import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ANSWER_TYPES, CHAT_TYPES, WorkSchedule, answerSql, clientMessageSql } from '../analytics/control.service';
import { AUTO_NEXT_STEP, AUTO_REPLY, AutoTaskService } from './auto-task.service';

/**
 * Rules that work without any setup, so that nothing depends on a manager remembering it:
 *  1. «Следующий шаг»: an open deal with a responsible manager and no open task gets the task
 *     «Авто: запланируйте следующий шаг по сделке» (due by the end of the working day). Not sooner than
 *     30 minutes after the deal appeared and 12 hours after its last task was closed; once in 3 days;
 *     only deals with activity in the last 60 days (AUTOPILOT_ACTIVE_DAYS), and not while the client
 *     waits for an answer (that is the other process).
 *  2. A task «Авто: ответьте клиенту» (made by the «клиент ждёт ответа» process when the manager has
 *     no bot) closes itself as soon as the client gets an answer in the deal: a message, a letter or
 *     an outgoing call (answerSql, the same rule as «Контроль менеджеров»).
 * AUTOPILOT=0 turns everything off, AUTOPILOT_NEXT_STEP=0 only rule 1. Period: AUTOPILOT_SEC (600).
 */
@Injectable()
export class AutopilotService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(AutopilotService.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private dataSource: DataSource,
    private autoTasks: AutoTaskService,
  ) {}

  onApplicationBootstrap() {
    if (process.env.AUTOPILOT === '0') return;
    const every = Math.max(60, Number(process.env.AUTOPILOT_SEC || 600));
    this.timer = setInterval(() => void this.tick(), every * 1000);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()): Promise<{ closed: number; created: number }> {
    if (this.ticking) return { closed: 0, created: 0 };
    this.ticking = true;
    try {
      const closed = await this.closeAnswered();
      const created = process.env.AUTOPILOT_NEXT_STEP === '0' ? 0 : await this.nextStep(now);
      if (closed || created) this.logger.log(`autopilot: ${created} task(s) created, ${closed} closed`);
      return { closed, created };
    } catch (error) {
      this.logger.warn(`autopilot: ${(error as Error).message}`);
      return { closed: 0, created: 0 };
    } finally {
      this.ticking = false;
    }
  }

  /**
   * «Авто: ответьте клиенту» is done once somebody answered in the deal after the task appeared, or
   * after the client message it was made for: a call is dated by the call, and its recording comes from
   * the phone later than the task (the manager called back at 10:05, the task appeared at 10:15).
   */
  private async closeAnswered(): Promise<number> {
    const result = await this.dataSource.query(
      `UPDATE task t SET closed_at = now(), result = 'Клиенту ответили'
        WHERE t.closed_at IS NULL AND t.label LIKE $2
          AND EXISTS (SELECT 1 FROM event o
                       WHERE o.deal_id = t.deal_id AND ${answerSql('o', '$1')}
                         AND (o.created_at > t.created_at
                              OR o.created_at > (SELECT MAX(c.created_at) FROM event c
                                                  WHERE c.deal_id = t.deal_id AND ${clientMessageSql('c', '$3')}
                                                    AND c.created_at <= t.created_at)))`,
      [ANSWER_TYPES, `${AUTO_REPLY}%`, CHAT_TYPES],
    );
    return Array.isArray(result) ? Number(result[1] ?? 0) : 0;
  }

  private async nextStep(now: Date): Promise<number> {
    const schedule = new WorkSchedule();
    // tasks appear while the office works, with a deadline today or on the next working day
    if (schedule.seconds(new Date(now.getTime() - 60_000), now) === 0) return 0;
    const closedNames = [process.env.DEAL_STAGE_CLOSED, process.env.DEAL_STAGE_CLOSED_NOT_REALIZED].filter(Boolean);

    const deals: { id: number }[] = await this.dataSource.query(
      `SELECT d.id
         FROM deal d
         JOIN "user" u ON u.id = d.agent_id AND u.deleted_at IS NULL AND u.role IN ('admin', 'manager', 'agent')
         LEFT JOIN deal_stage s ON s.id = d.stage_id
        WHERE d.deleted_at IS NULL AND d.closed_at IS NULL AND d.created_at < now() - interval '30 minutes'
          AND NOT (COALESCE(s.name, '') = ANY($2))
          AND NOT EXISTS (SELECT 1 FROM task t WHERE t.deal_id = d.id AND t.closed_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM task t WHERE t.deal_id = d.id AND t.closed_at > now() - interval '12 hours')
          AND NOT EXISTS (SELECT 1 FROM task t WHERE t.deal_id = d.id AND t.label = $1 AND t.created_at > now() - interval '3 days')
          -- a deal nobody touched for two months is not "in work": it belongs to the stale-deals list, not to today's tasks
          AND (d.created_at > now() - make_interval(days => $4::int)
               OR EXISTS (SELECT 1 FROM event a WHERE a.deal_id = d.id AND a.created_at > now() - make_interval(days => $4::int)))
          -- the client wrote last: the next step is the answer, «клиент ждёт ответа» takes care of it
          AND NOT EXISTS (SELECT 1 FROM event c
                           WHERE c.deal_id = d.id AND ${clientMessageSql('c', '$3')} AND c.created_at > now() - interval '3 days'
                             AND NOT EXISTS (SELECT 1 FROM event o
                                              WHERE o.deal_id = d.id AND ${answerSql('o', '$5')} AND o.created_at > c.created_at))
        ORDER BY d.id LIMIT 50`,
      [AUTO_NEXT_STEP, closedNames, CHAT_TYPES, Math.max(1, Number(process.env.AUTOPILOT_ACTIVE_DAYS || 60)), ANSWER_TYPES],
    );

    let created = 0;
    for (const deal of deals) {
      if (await this.autoTasks.create(deal.id, AUTO_NEXT_STEP, endOfWorkingDay(schedule, now))) created++;
    }
    return created;
  }
}

/** The end of today's working day if at least two working hours are left, else of the next working day. */
export function endOfWorkingDay(schedule: WorkSchedule, now: Date, minLeftSec = 7200): Date {
  for (let i = 0; i < 8; i++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const weekday = day.getDay() === 0 ? 7 : day.getDay();
    if (!schedule.days.has(weekday)) continue;
    const close = new Date(day.getTime() + schedule.endMin * 60000);
    if (close.getTime() - now.getTime() >= minLeftSec * 1000) return close;
  }
  return new Date(now.getTime() + 86_400_000);
}
