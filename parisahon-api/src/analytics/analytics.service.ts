import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Deal } from 'src/deal/deal.entity';
import { DealStage } from 'src/deal_stage/deal_stage.entity';
import { DealStageRecord } from 'src/deal_stage/deal_stage.records.entity';
import { HelperService } from 'src/helper/helper.service';
import { Repository } from 'typeorm';
import { DealAnalyticsQuery } from './dto/deal.analytics.dto';
import { Recording } from './recordings.entity';
import { UserAnalyticsQuery } from './dto/user.analytics.dto';
import { RoleEnum, User } from 'src/user/user.entity';
import {
  ConsolidatedReportQuery,
  PeriodEnum,
} from './dto/consolidated.report.query.dto';
import { Company } from 'src/company/company.entity';
import { Task } from 'src/task/task.entity';
import { periodBounds } from './period';

/** Staff roles: the people the reports are about (clients' contacts are not) */
const STAFF_ROLES = [RoleEnum.ADMIN, RoleEnum.MANAGER, RoleEnum.AGENT];

/** The call recorder stores `recording.duration` in milliseconds */
const MS_PER_MINUTE = 60000;

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(Deal)
    private dealRepository: Repository<Deal>,
    @InjectRepository(DealStage)
    private dealStageRepository: Repository<DealStage>,
    @InjectRepository(DealStageRecord)
    private dealStageRecordRepository: Repository<DealStageRecord>,
    @InjectRepository(Recording)
    private recordingRepository: Repository<Recording>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Company)
    private companyRepository: Repository<Company>,
    @InjectRepository(Task)
    private taskRepository: Repository<Task>,
    private helperService: HelperService,
  ) {}

  async dealAnalytics(query: DealAnalyticsQuery): Promise<Record<string, any>> {
    let stageStatsQb = this.dealStageRecordRepository
      .createQueryBuilder('t0')
      .select('COUNT(t0.deal_id)', 'deal_count')
      .addSelect('AVG(t0.moved_after_minutes)', 'average_time_in_stage')
      .addSelect('SUM(t3.budget)', 'total_deal_budget')
      .addSelect('t1.id', 'id')
      .leftJoin('t0.stage', 't1')
      .leftJoin('t1.collection', 't2')
      .leftJoin('t0.deal', 't3')
      .where('t2.is_active = true');

    if (query.is_active === 'true') {
      stageStatsQb = stageStatsQb.andWhere('t3.closed_at IS NULl');
    } else if (query.is_active === 'false') {
      stageStatsQb = stageStatsQb.andWhere('t3.closed_at IS NOT NULl');
    }

    const stageStats = await stageStatsQb.groupBy('t1.id').getRawMany();

    const stageStatsMap = this.helperService.createHashMap(stageStats);

    const dealStats = await this.dealRepository
      .createQueryBuilder('t0')
      .select(
        'AVG(EXTRACT(EPOCH FROM (t0.closed_at - t0.created_at)) / 60)',
        'average_deal_duration_in_minutes',
      )
      .addSelect('COUNT(t0.*)', 'total_deal_count')
      .getRawOne();

    const stages = await this.dealStageRepository
      .createQueryBuilder('t0')
      .leftJoin('t0.collection', 't1')
      .where('t1.is_active = true')
      .getMany();

    const mergedStages = [];

    // TODO: Refactor
    for (const stage of stages) {
      if (stageStatsMap.has(stage.id)) {
        mergedStages.push({ ...stage, ...stageStatsMap.get(stage.id) });
        continue;
      }

      mergedStages.push({
        ...stage,
        deal_count: 0,
        average_time_in_stage: 0,
        total_deal_budget: 0,
      });
    }

    return {
      ...dealStats,
      stages: mergedStages,
    };
  }

  /**
   * Calls per employee. `recording.duration` is stored in milliseconds by the
   * recorder; every duration here is returned in minutes (one decimal), which
   * is how the page labels them.
   */
  async callAnalytics(): Promise<Record<string, any>> {
    const ms = MS_PER_MINUTE;
    const query = `
    SELECT
      u.id AS user_id,
      u.username AS user_name,
      ROUND(AVG(r.duration) / ${ms}, 1) AS avg_duration,
      COUNT(*) AS call_count,
      SUM(CASE WHEN r.outgoing THEN 1 ELSE 0 END) AS outgoing_call_count,
      SUM(CASE WHEN NOT r.outgoing THEN 1 ELSE 0 END) AS incoming_call_count,
      ROUND(SUM(CASE WHEN r.outgoing THEN r.duration ELSE 0 END) / ${ms}.0, 1) AS total_outgoing_duration,
      ROUND(SUM(CASE WHEN NOT r.outgoing THEN r.duration ELSE 0 END) / ${ms}.0, 1) AS total_incoming_duration,
      ROUND(SUM(r.duration) / ${ms}.0, 1) AS total_call_duration
    FROM
        recording r
    JOIN
        public.user u ON r.user_id = u.id
    GROUP BY
        u.id, u.username
    ORDER BY
        u.username;
  `;

    const rows = await this.recordingRepository.query(query);

    return rows.map((row) => ({
      user_id: +row.user_id,
      user_name: row.user_name,
      avg_duration: +row.avg_duration,
      call_count: +row.call_count,
      outgoing_call_count: +row.outgoing_call_count,
      incoming_call_count: +row.incoming_call_count,
      total_outgoing_duration: +row.total_outgoing_duration,
      total_incoming_duration: +row.total_incoming_duration,
      total_call_duration: +row.total_call_duration,
      duration_unit: 'minutes',
    }));
  }

  /**
   * "По сотрудникам": deals (responsible = the employee) and tasks (assignee =
   * the employee) created in the period, one row per staff member.
   *
   * Deals and tasks are aggregated in separate sub-queries. The old version
   * joined both onto the user, so every deal was counted once per task (and
   * vice versa), and an employee without a task in the period lost all of
   * their deals. Deleted deals are not counted.
   */
  async userAnalytics(query: UserAnalyticsQuery): Promise<Record<string, any>> {
    const period = periodBounds(query);

    const rows = await this.userRepository
      .createQueryBuilder('t0')
      .select('t0.id', 'id')
      .addSelect('t0.username', 'username')
      .addSelect('t0.role', 'role')
      .addSelect(
        `(SELECT COUNT(*) FROM deal d WHERE d.agent_id = t0.id AND d.deleted_at IS NULL
          AND d.created_at >= :from_date AND d.created_at <= :till_date)`,
        'deal_count',
      )
      .addSelect(
        `(SELECT COALESCE(SUM(d.budget), 0) FROM deal d WHERE d.agent_id = t0.id AND d.deleted_at IS NULL
          AND d.created_at >= :from_date AND d.created_at <= :till_date)`,
        'deal_budget',
      )
      .addSelect(
        `(SELECT COUNT(*) FROM task tk WHERE tk.agent_id = t0.id
          AND tk.created_at >= :from_date AND tk.created_at <= :till_date)`,
        'task_count',
      )
      .where('t0.role IN (:...roles)', { roles: STAFF_ROLES })
      .setParameters(period)
      .orderBy('t0.username', 'ASC')
      .getRawMany();

    return rows.map((row) => ({
      id: +row.id,
      username: row.username,
      role: row.role,
      deal_count: +row.deal_count,
      deal_budget: +row.deal_budget,
      task_count: +row.task_count,
    }));
  }

  /**
   * Сводный отчёт.
   *
   * Graph: "new" = deals created in the period (by creation date); "won" =
   * deals in the successful stage with `closed_at` in the period (by closing
   * date); "lost" = deals in the closed-not-realised stage, same rule. The old
   * version decided "new" and "won" by whether a deal had ever visited the
   * "НЕРАЗОБРАННОЕ" / "ПРЕДОПЛАТА" stages, which has nothing to do with winning.
   * Deleted deals are excluded everywhere (raw SQL filters `deleted_at`).
   */
  async consolidatedReportAnalytics(
    query: ConsolidatedReportQuery,
  ): Promise<Record<string, any>> {
    const period = periodBounds(query);
    const wonStageName = process.env.DEAL_STAGE_CLOSED;
    const lostStageName = process.env.DEAL_STAGE_CLOSED_NOT_REALIZED;

    // Bucket boundaries of the graph
    let unit = 'week';
    let bucketEnd = '6 days';
    if (query.period === PeriodEnum.MONTHLY) {
      unit = 'month';
      bucketEnd = '1 month - 1 day';
    } else if (query.period === PeriodEnum.YEARLY) {
      unit = 'year';
      bucketEnd = '1 year - 1 day';
    }
    // Plain `YYYY-MM-DD` strings: a period is a calendar date, not a moment, so
    // it must not go through a time zone on the way to JSON (a timestamp at
    // midnight would show up as the previous day in a browser west of the API).
    const bucketSelect = (column: string) =>
      `TO_CHAR(DATE_TRUNC('${unit}', ${column}), 'YYYY-MM-DD') AS date_start, ` +
      `TO_CHAR(DATE_TRUNC('${unit}', ${column}) + INTERVAL '${bucketEnd}', 'YYYY-MM-DD') AS date_end`;
    const bucketGroup = (column: string) =>
      `GROUP BY DATE_TRUNC('${unit}', ${column}) ORDER BY DATE_TRUNC('${unit}', ${column})`;

    const newGraphStats: Record<string, any>[] = await this.dealRepository.query(
      `SELECT COUNT(t0.id) AS count, ${bucketSelect('t0.created_at')}
         FROM deal t0
        WHERE t0.deleted_at IS NULL
          AND t0.created_at >= $1 AND t0.created_at <= $2
        ${bucketGroup('t0.created_at')}`,
      [period.from_date, period.till_date],
    );

    const closedGraphSql = `
      SELECT COUNT(t0.id) AS count, ${bucketSelect('t0.closed_at')}
        FROM deal t0
       WHERE t0.deleted_at IS NULL
         AND t0.closed_at IS NOT NULL
         AND t0.closed_at >= $1 AND t0.closed_at <= $2
         AND t0.stage_id IN (SELECT s.id FROM deal_stage s WHERE s.name = $3)
       ${bucketGroup('t0.closed_at')}`;

    const wonGraphStats: Record<string, any>[] = await this.dealRepository.query(
      closedGraphSql,
      [period.from_date, period.till_date, wonStageName],
    );
    const lostGraphStats: Record<string, any>[] =
      await this.dealRepository.query(closedGraphSql, [
        period.from_date,
        period.till_date,
        lostStageName,
      ]);

    // Merge the three series by bucket (the old code keyed the Map by the Date
    // objects `pg` returns, and two equal Dates are different keys, so new and
    // won of the same bucket never met).
    const graphDataMap = new Map<string, Record<string, any>>();
    const bucketOf = (row: Record<string, any>) => {
      const key = String(row.date_start);
      if (!graphDataMap.has(key)) {
        graphDataMap.set(key, {
          date_start: row.date_start,
          date_end: row.date_end,
          new_count: 0,
          won_count: 0,
          lost_count: 0,
        });
      }
      return graphDataMap.get(key);
    };
    for (const row of newGraphStats) bucketOf(row).new_count += +row.count;
    for (const row of wonGraphStats) bucketOf(row).won_count += +row.count;
    for (const row of lostGraphStats) bucketOf(row).lost_count += +row.count;

    const graph = Array.from(graphDataMap.values()).sort((a, b) =>
      String(a.date_start).localeCompare(String(b.date_start)),
    );

    // Deals created in the period, by stage of the active pipeline
    const dealStats = await this.dealStageRepository
      .createQueryBuilder('t0')
      .leftJoin(
        't0.deals',
        't1',
        't1.created_at >= :from_date AND t1.created_at <= :till_date',
      )
      .leftJoin('t0.collection', 't2')
      .where('t2.is_active = true')
      .select('t0.id', 'id')
      .addSelect('t0.name', 'name')
      .addSelect('COUNT(t1.id)', 'deal_count_in_stage')
      .addSelect('COALESCE(SUM(t1.budget), 0)', 'total_budget_in_stage')
      .setParameters(period)
      .groupBy('t0.id')
      .orderBy('t0.order', 'ASC')
      .getRawMany();

    const totalDealStats = await this.dealRepository
      .createQueryBuilder('t0')
      .where('t0.created_at >= :from_date AND t0.created_at <= :till_date')
      .select('COUNT(t0.id)', 'total_deal_count')
      .addSelect('COALESCE(SUM(t0.budget), 0)', 'total_deal_budget')
      .setParameters(period)
      .getRawOne();

    // Closed in the period (by closing date), won and lost apart
    const closedStats = await this.dealRepository
      .createQueryBuilder('t0')
      .leftJoin('t0.stage', 't1')
      .where('t0.closed_at IS NOT NULL')
      .andWhere('t0.closed_at >= :from_date AND t0.closed_at <= :till_date')
      .select(
        'COUNT(t0.id) FILTER (WHERE t1.name = :won_stage)',
        'won_deal_count',
      )
      .addSelect(
        'COALESCE(SUM(t0.budget) FILTER (WHERE t1.name = :won_stage), 0)',
        'won_deal_budget',
      )
      .addSelect(
        'COUNT(t0.id) FILTER (WHERE t1.name = :lost_stage)',
        'lost_deal_count',
      )
      .addSelect(
        'COALESCE(SUM(t0.budget) FILTER (WHERE t1.name = :lost_stage), 0)',
        'lost_deal_budget',
      )
      .setParameters({
        ...period,
        won_stage: wonStageName,
        lost_stage: lostStageName,
      })
      .getRawOne();

    // Deals created in the period, by responsible employee
    const userDealStats = await this.userRepository
      .createQueryBuilder('t0')
      .leftJoin(
        't0.assigned_deals',
        't1',
        't1.created_at >= :from_date AND t1.created_at <= :till_date',
      )
      .where('t0.role IN (:...roles)', { roles: STAFF_ROLES })
      .select('t0.id', 'id')
      .addSelect('t0.username', 'username')
      .addSelect('COUNT(t1.id)', 'deal_count')
      .addSelect('COALESCE(SUM(t1.budget), 0)', 'deal_budget')
      .setParameters(period)
      .groupBy('t0.id')
      .orderBy('t0.username', 'ASC')
      .getRawMany();

    // Contact stats
    const contactStats = await this.userRepository
      .createQueryBuilder('t0')
      .leftJoin('t0.assigned_deals', 't1')
      .leftJoin('t1.ctr_agents', 't2')
      .leftJoin('t1.company', 't3')
      .select('t0.id', 'id')
      .addSelect('t0.username', 'username')
      .addSelect('COUNT(DISTINCT t2.id)', 'ctr_agent_count')
      .addSelect('COUNT(DISTINCT t3.id)', 'company_count')
      .where('t0.role = :agent_role', { agent_role: RoleEnum.AGENT })
      .groupBy('t0.id')
      .getRawMany();

    // Total Contact count
    const totalCompanyCount = await this.companyRepository
      .createQueryBuilder('t0')
      .getCount();
    const totalCtrAgentCount = await this.userRepository
      .createQueryBuilder('t0')
      .where('t0.role = :role', { role: RoleEnum.CTR_AGENT })
      .getCount();

    // Task stats (tasks created in the period)
    const taskStats = await this.taskRepository
      .createQueryBuilder('t0')
      .leftJoin('t0.agent', 't1')
      .select('t1.id', 'id')
      .addSelect('t1.username', 'username')
      .addSelect('COUNT(t0.id)', 'task_count')
      .where('t0.created_at >= :from_date AND t0.created_at <= :till_date')
      .setParameters(period)
      .groupBy('t1.id')
      .getRawMany();

    const taskTypeStats = await this.taskRepository
      .createQueryBuilder('t0')
      .leftJoin('t0.type', 't1')
      .select('t1.id', 'id')
      .addSelect('t1.name', 'name')
      .addSelect('COUNT(t0.id)', 'task_count')
      .where('t0.created_at >= :from_date AND t0.created_at <= :till_date')
      .setParameters(period)
      .groupBy('t1.id')
      .getRawMany();

    const totalTaskCount = await this.taskRepository
      .createQueryBuilder('t0')
      .where('t0.created_at >= :from_date AND t0.created_at <= :till_date')
      .setParameters(period)
      .getCount();

    return {
      graph,
      deals: {
        total_stats: {
          total_deal_count: +totalDealStats.total_deal_count,
          total_deal_budget: +totalDealStats.total_deal_budget,
          won_deal_count: +closedStats.won_deal_count,
          won_deal_budget: +closedStats.won_deal_budget,
          lost_deal_count: +closedStats.lost_deal_count,
          lost_deal_budget: +closedStats.lost_deal_budget,
        },
        stage_stats: dealStats,
        user_stats: userDealStats,
      },
      contacts: {
        total_stats: {
          total_ctr_agent_count: totalCtrAgentCount,
          total_company_count: totalCompanyCount,
        },
        user_stats: contactStats,
      },
      tasks: {
        user_stats: taskStats,
        type_stats: taskTypeStats,
        total_stats: {
          count: totalTaskCount,
        },
      },
    };
  }
}
