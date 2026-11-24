import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DesktopQueryDto } from './dto/desktop.query.dto';
import { RoleEnum } from 'src/user/user.entity';
import { File } from 'src/file/file.entity';
import { Request } from 'express';
import { AuthUser } from 'src/auth/auth.guard';
import { periodBounds } from 'src/analytics/period';
import { StageKind } from 'src/deal_stage/stage-kind';

const STAFF_ROLES = [RoleEnum.ADMIN, RoleEnum.MANAGER, RoleEnum.AGENT];

/** Whose numbers: the whole company, the caller (my_stats=true) or the staff users picked on the desktop. */
type Who =
  | { kind: 'all' }
  | { kind: 'me'; id: number; group: number | null }
  | { kind: 'users'; ids: number[] };

/** Positional parameters ($1, $2, ...) of one raw query. */
class Params {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return '$' + this.values.length;
  }
}

@Injectable()
export class DesktopService {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * The desktop (pages/index.vue). The period comes as plain dates and its last day counts in full
   * (analytics/period.ts), like the "По сотрудникам" list next to it: "Сегодня" is today.
   *
   * Task counters:
   *   tasks_overdue  — open, deadline passed: all of them now, whatever the period (a task overdue since
   *                    last week is still to be done)
   *   active_tasks   — open, deadline not passed yet, the task's span touches the period
   *   tasks_closed   — done within the period
   * The task list gives the same tasks (the counters link to it): status overdue / upcoming with the
   * period's dates (the span overlaps) / closed with closed_from..closed_till.
   *   deals_without_tasks — open deals without an open task now, whatever the period (a state, like
   *                    "overdue"; the deals list "Сделки без задач" shows the same deals); "mine": responsible
   *   comments       — notes (comments) written in the period (by the user for "mine" / the picked users)
   * "Mine" are the tasks assigned to the user or to the user's group, as in the task list ("Мои") and in
   * the bot. Picked users (user_ids): their tasks, deals, calls and files. Tasks of a deal in the trash
   * are not counted (they come back with the deal).
   *   succesfull_deals — deals won (the stage of kind "won") and closed in the period, by the responsible
   *                    user: the reports count won deals the same way (analytics: by closed_at)
   * won_stage: the stage of kind "won" of the active pipeline (the card links to the deals list by it).
   * total_manager_stats: deals created in the period with a staff user responsible — the sum of the
   * "Сделки по менеджерам" list (by the responsible user, all staff roles; it used to count only the
   * deals created by role "manager").
   */
  async fetchStats(query: DesktopQueryDto, request: Request): Promise<Record<string, any>> {
    const user: AuthUser = request['user'];
    const ids = [query.user_ids ?? []]
      .flat()
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);
    const who: Who =
      String(query.my_stats ?? '').toLowerCase() === 'true'
        ? { kind: 'me', id: user.sub, group: user.group_id ?? null }
        : ids.length
          ? { kind: 'users', ids }
          : { kind: 'all' };
    const period = periodBounds(query);

    return {
      task_stats: await this.taskStats(who, period.from_date, period.till_date),
      manager_stats: await this.managerStats(who, period.from_date, period.till_date),
      total_manager_stats: await this.totalManagerStats(who, period.from_date, period.till_date),
      file_stats: await this.fileStats(who, period.from_date, period.till_date),
      won_stage: await this.wonStage(),
    };
  }

  private async taskStats(who: Who, fromDate: string, tillDate: string): Promise<Record<string, string>> {
    const p = new Params();
    const from = p.add(fromDate);
    const till = p.add(tillDate);
    const me = who.kind === 'me' ? p.add(who.id) : null;
    const group = who.kind === 'me' && who.group != null ? p.add(who.group) : null;
    const users = who.kind === 'users' ? p.add(who.ids) : null;
    const closedStage = p.add(StageKind.WON);

    const taskWho = (a: string) =>
      who.kind === 'all'
        ? 'TRUE'
        : who.kind === 'me'
          ? `(${a}.agent_id = ${me}${group ? ` OR ${a}.group_id = ${group}` : ''})`
          : `${a}.agent_id = ANY(${users}::int[])`;
    // the responsible user, as the deals list filters "Только мои" / by the user
    const responsible = (a: string) =>
      who.kind === 'all' ? 'TRUE' : who.kind === 'me' ? `${a}.agent_id = ${me}` : `${a}.agent_id = ANY(${users}::int[])`;
    const eventWho = (a: string, column: 'user_id' | 'target_user_id') =>
      who.kind === 'all' ? 'TRUE' : who.kind === 'me' ? `${a}.${column} = ${me}` : `${a}.${column} = ANY(${users}::int[])`;
    const notInTrash = (a: string) =>
      `NOT EXISTS (SELECT 1 FROM deal dd WHERE dd.id = ${a}.deal_id AND dd.deleted_at IS NOT NULL)`;
    const inPeriod = (column: string) => `${column} >= ${from}::timestamp AND ${column} <= ${till}::timestamp`;

    const rows = await this.dataSource.query(
      `SELECT
        (SELECT COUNT(*) FROM task a1
          WHERE a1.closed_at IS NULL AND a1.end_time < NOW() AND ${notInTrash('a1')} AND ${taskWho('a1')}) AS tasks_overdue,
        (SELECT COUNT(*) FROM task a2
          WHERE a2.closed_at IS NOT NULL AND ${inPeriod('a2.closed_at')} AND ${notInTrash('a2')} AND ${taskWho('a2')}) AS tasks_closed,
        (SELECT COUNT(*) FROM task a3
          WHERE a3.closed_at IS NULL AND a3.end_time >= NOW()
            AND (a3.start_time, a3.end_time) OVERLAPS (${from}::timestamp, ${till}::timestamp)
            AND ${notInTrash('a3')} AND ${taskWho('a3')}) AS active_tasks,
        (SELECT COUNT(*) FROM deal a4
          WHERE a4.deleted_at IS NULL AND a4.closed_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM task a5 WHERE a5.deal_id = a4.id AND a5.closed_at IS NULL)
            AND ${responsible('a4')}) AS deals_without_tasks,
        (SELECT COUNT(*) FROM event a11
          WHERE a11.type = 5 AND ${inPeriod('a11.created_at')} AND ${eventWho('a11', 'user_id')}
            AND NOT EXISTS (SELECT 1 FROM deal dd WHERE dd.id = a11.deal_id AND dd.deleted_at IS NOT NULL)) AS comments,
        (SELECT COUNT(*) FROM event a6
          WHERE a6.type = 10 AND a6.outgoing = true AND ${inPeriod('a6.created_at')} AND ${eventWho('a6', 'user_id')}) AS outgoing_calls,
        (SELECT COUNT(*) FROM event a7
          WHERE a7.type = 10 AND a7.outgoing = false AND ${inPeriod('a7.created_at')} AND ${eventWho('a7', 'target_user_id')}) AS incoming_calls,
        (SELECT COUNT(*) FROM deal a8
          WHERE a8.deleted_at IS NULL AND a8.closed_at IS NOT NULL
            AND a8.stage_id IN (SELECT a9.id FROM deal_stage a9 LEFT JOIN collection a10 ON a9.collection_id = a10.id
                                 WHERE a9.kind = ${closedStage} AND a10.is_active = true)
            AND ${inPeriod('a8.closed_at')} AND ${responsible('a8')}) AS succesfull_deals`,
      p.values,
    );
    return rows[0];
  }

  private async wonStage(): Promise<{ id: number; name: string } | null> {
    const rows: { id: number; name: string }[] = await this.dataSource.query(
      `SELECT s.id, s.name FROM deal_stage s LEFT JOIN collection c ON c.id = s.collection_id
       WHERE s.kind = $1 ORDER BY (c.is_active IS TRUE) DESC, s.id LIMIT 1`,
      [StageKind.WON],
    );
    return rows[0] ?? null;
  }

  /** Deals of the period per staff user (responsible), the same rows as "По сотрудникам". */
  private async managerStats(who: Who, fromDate: string, tillDate: string) {
    const p = new Params();
    const from = p.add(fromDate);
    const till = p.add(tillDate);
    const roles = p.add(STAFF_ROLES);
    const filter =
      who.kind === 'all' ? '' : who.kind === 'me' ? `AND u.id = ${p.add(who.id)}` : `AND u.id = ANY(${p.add(who.ids)}::int[])`;
    return this.dataSource.query(
      `SELECT u.id, u.username, SUM(d.budget) AS total_budget, COUNT(d.id) AS deal_count
       FROM "user" u
       JOIN deal d ON d.agent_id = u.id AND d.deleted_at IS NULL
        AND d.created_at >= ${from}::timestamp AND d.created_at <= ${till}::timestamp
       WHERE u.role = ANY(${roles}::text[]) ${filter}
       GROUP BY u.id
       ORDER BY u.username`,
      p.values,
    );
  }

  private async totalManagerStats(who: Who, fromDate: string, tillDate: string) {
    const p = new Params();
    const from = p.add(fromDate);
    const till = p.add(tillDate);
    const roles = p.add(STAFF_ROLES);
    const filter =
      who.kind === 'all' ? '' : who.kind === 'me' ? `AND u.id = ${p.add(who.id)}` : `AND u.id = ANY(${p.add(who.ids)}::int[])`;
    const rows = await this.dataSource.query(
      `SELECT SUM(d.budget) AS total_budget, COUNT(d.id) AS deal_count
       FROM deal d JOIN "user" u ON u.id = d.agent_id
       WHERE d.deleted_at IS NULL AND d.created_at >= ${from}::timestamp AND d.created_at <= ${till}::timestamp
         AND u.role = ANY(${roles}::text[]) ${filter}`,
      p.values,
    );
    return rows[0];
  }

  private async fileStats(who: Who, fromDate: string, tillDate: string) {
    let qb = this.dataSource
      .getRepository(File)
      .createQueryBuilder('t0')
      .leftJoin('t0.uploaded_by', 't1')
      .addSelect('t1.id')
      .addSelect('t1.username')
      .where('(t0.created_at >= :from_date and t0.created_at <= :till_date)', {
        from_date: fromDate,
        till_date: tillDate,
      });
    if (who.kind === 'me') qb = qb.andWhere('t0.uploaded_by = :user_id', { user_id: who.id });
    if (who.kind === 'users') qb = qb.andWhere('t0.uploaded_by IN (:...user_ids)', { user_ids: who.ids });
    return qb.orderBy('t0.created_at').limit(10).getMany();
  }
}
