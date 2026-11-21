import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DesktopQueryDto } from './dto/desktop.query.dto';
import { Task } from 'src/task/task.entity';
import { RoleEnum, User } from 'src/user/user.entity';
import { File } from 'src/file/file.entity';
import { Request } from 'express';
import { HelperService } from 'src/helper/helper.service';

@Injectable()
export class DesktopService {
  /**
   * The three task counters. Before, "overdue" counted tasks with a deadline
   * in the future and "active" counted closed tasks.
   *   overdue  — open, deadline passed
   *   active   — open, deadline not passed yet
   *   closed   — closed (whenever)
   * All three count the tasks whose span touches the selected period.
   */
  static readonly TASK_OVERDUE = (a: string) =>
    `${a}.closed_at IS NULL AND ${a}.end_time < NOW()`;
  static readonly TASK_ACTIVE = (a: string) =>
    `${a}.closed_at IS NULL AND ${a}.end_time >= NOW()`;
  static readonly TASK_CLOSED = (a: string) => `${a}.closed_at IS NOT NULL`;
  static readonly TASK_IN_PERIOD = (a: string) =>
    `(${a}.start_time, ${a}.end_time) OVERLAPS (:from_date, :till_date)`;
  /** Tasks of a deal in the trash are not counted (they come back with the deal) */
  static readonly TASK_NOT_IN_TRASH = (a: string) =>
    `NOT EXISTS (SELECT 1 FROM deal dd WHERE dd.id = ${a}.deal_id AND dd.deleted_at IS NOT NULL)`;
  static readonly TASK_OF_USER = (a: string) =>
    `(${a}.agent_id = :user_id OR ${a}."createdById" = :user_id)`;

  constructor(
    private readonly dataSource: DataSource,
    private readonly helperService: HelperService,
  ) {}

  async fetchStats(
    query: DesktopQueryDto,
    request: Request,
  ): Promise<Record<string, any>> {
    if (query.my_stats && query.my_stats.toLowerCase() === 'true') {
      return this.fetchMyStats(
        query,
        this.helperService.extractUserIdFromRequest(request),
      );
    }

    const taskStats = await this.dataSource
      .getRepository(Task)
      .createQueryBuilder('t0')
      .select(
        `(SELECT COUNT(*) FROM task a1 WHERE ${DesktopService.TASK_OVERDUE('a1')} AND ${DesktopService.TASK_IN_PERIOD('a1')} AND ${DesktopService.TASK_NOT_IN_TRASH('a1')})`,
        'tasks_overdue',
      )
      .addSelect(
        `(SELECT COUNT(*) FROM task a2 WHERE ${DesktopService.TASK_CLOSED('a2')} AND ${DesktopService.TASK_IN_PERIOD('a2')} AND ${DesktopService.TASK_NOT_IN_TRASH('a2')})`,
        'tasks_closed',
      )
      .addSelect(
        `(SELECT COUNT(*) FROM task a3 WHERE ${DesktopService.TASK_ACTIVE('a3')} AND ${DesktopService.TASK_IN_PERIOD('a3')} AND ${DesktopService.TASK_NOT_IN_TRASH('a3')})`,
        'active_tasks',
      )
      .addSelect(
        '(SELECT COUNT(*) FROM deal a4 WHERE a4.deleted_at IS NULL AND a4.closed_at IS NULL AND NOT EXISTS (SELECT 1 FROM task a5 WHERE a5.deal_id = a4.id AND a5.closed_at IS NULL) AND a4.created_at > :from_date AND a4.created_at < :till_date)',
        'deals_without_tasks',
      )
      .addSelect(
        '(SELECT COUNT(*) FROM event a6 WHERE a6.type = 10 AND a6.outgoing = true AND a6.created_at > :from_date AND a6.created_at < :till_date)',
        'outgoing_calls',
      )
      .addSelect(
        '(SELECT COUNT(*) FROM event a7 WHERE a7.type = 10 AND a7.outgoing = false AND a7.created_at > :from_date AND a7.created_at < :till_date)',
        'incoming_calls',
      )
      .addSelect(
        `(SELECT COUNT(*) FROM deal a8 WHERE a8.deleted_at IS NULL AND a8.closed_at IS NOT NULL AND a8.stage_id IN (SELECT a9.id FROM deal_stage a9 LEFT JOIN collection a10 ON a9.collection_id = a10.id WHERE a9.name = '${process.env.DEAL_STAGE_CLOSED}' AND a10.is_active = true) AND a8.created_at > :from_date AND a8.created_at < :till_date)`,
        'succesfull_deals',
      )
      .setParameters({ from_date: query.from_date, till_date: query.till_date })
      .getRawOne();

    const managerStats = await this.dataSource
      .getRepository(User)
      .createQueryBuilder('t0')
      .select('t0.id', 'id')
      .addSelect('t0.username', 'username')
      .leftJoin('t0.created_deals', 't1')
      .addSelect('SUM(t1.budget)', 'total_budget')
      .addSelect('COUNT(t1.id)', 'deal_count')
      .where('t1.created_at > :from_date', { from_date: query.from_date })
      .andWhere('t1.created_at < :till_date', { till_date: query.till_date })
      .andWhere('t0.role = :manager', { manager: RoleEnum.MANAGER })
      .groupBy('t0.id')
      .getRawMany();

    const totalManagerStats = await this.dataSource
      .getRepository(User)
      .createQueryBuilder('t0')
      .leftJoin('t0.created_deals', 't1')
      .select('SUM(t1.budget)', 'total_budget')
      .addSelect('COUNT(t1.id)', 'deal_count')
      .where('t1.created_at > :from_date', { from_date: query.from_date })
      .andWhere('t1.created_at < :till_date', { till_date: query.till_date })
      .andWhere('t0.role = :manager_role', { manager_role: RoleEnum.MANAGER })
      .getRawOne();

    const fileStats = await this.dataSource
      .getRepository(File)
      .createQueryBuilder('t0')
      .leftJoin('t0.uploaded_by', 't1')
      .addSelect('t1.id')
      .addSelect('t1.username')
      .where('(t0.created_at > :from_date and t0.created_at < :till_date)', {
        from_date: query.from_date,
        till_date: query.till_date,
      })
      .orderBy('t0.created_at')
      .limit(10)
      .getMany();

    return {
      task_stats: taskStats,
      manager_stats: managerStats,
      total_manager_stats: totalManagerStats,
      file_stats: fileStats,
    };
  }

  private async fetchMyStats(
    query: DesktopQueryDto,
    user_id: number,
  ): Promise<Record<string, any>> {
    const taskStats = await this.dataSource
      .getRepository(Task)
      .createQueryBuilder('t0')
      .select(
        `(SELECT COUNT(*) FROM task a1 WHERE ${DesktopService.TASK_OVERDUE('a1')} AND ${DesktopService.TASK_IN_PERIOD('a1')} AND ${DesktopService.TASK_NOT_IN_TRASH('a1')} AND ${DesktopService.TASK_OF_USER('a1')})`,
        'tasks_overdue',
      )
      .addSelect(
        `(SELECT COUNT(*) FROM task a2 WHERE ${DesktopService.TASK_CLOSED('a2')} AND ${DesktopService.TASK_IN_PERIOD('a2')} AND ${DesktopService.TASK_NOT_IN_TRASH('a2')} AND ${DesktopService.TASK_OF_USER('a2')})`,
        'tasks_closed',
      )
      .addSelect(
        `(SELECT COUNT(*) FROM task a3 WHERE ${DesktopService.TASK_ACTIVE('a3')} AND ${DesktopService.TASK_IN_PERIOD('a3')} AND ${DesktopService.TASK_NOT_IN_TRASH('a3')} AND ${DesktopService.TASK_OF_USER('a3')})`,
        'active_tasks',
      )
      .addSelect(
        '(SELECT COUNT(*) FROM deal a4 WHERE a4.deleted_at IS NULL AND a4.closed_at IS NULL AND NOT EXISTS (SELECT 1 FROM task a5 WHERE a5.deal_id = a4.id AND a5.closed_at IS NULL) AND a4.created_at > :from_date AND a4.created_at < :till_date AND (a4.agent_id = :user_id OR a4.created_by = :user_id))',
        'deals_without_tasks',
      )
      .addSelect(
        '(SELECT COUNT(*) FROM event a6 WHERE a6.type = 10 AND a6.outgoing = true AND a6.created_at > :from_date AND a6.created_at < :till_date AND a6.user_id = :user_id)',
        'outgoing_calls',
      )
      .addSelect(
        '(SELECT COUNT(*) FROM event a7 WHERE a7.type = 10 AND a7.outgoing = false AND a7.created_at > :from_date AND a7.created_at < :till_date AND a7.target_user_id = :user_id)',
        'incoming_calls',
      )
      .addSelect(
        `(SELECT COUNT(*) FROM deal a8 WHERE a8.deleted_at IS NULL AND a8.closed_at IS NOT NULL AND a8.stage_id IN (SELECT a9.id FROM deal_stage a9 LEFT JOIN collection a10 ON a9.collection_id = a10.id WHERE a9.name = '${process.env.DEAL_STAGE_CLOSED}' AND a10.is_active = true) AND a8.created_at > :from_date AND a8.created_at < :till_date AND (a8.agent_id = :user_id OR a8.created_by = :user_id))`,
        'succesfull_deals',
      )
      .setParameters({
        from_date: query.from_date,
        till_date: query.till_date,
        user_id: user_id,
      })
      .getRawOne();

    const managerStats = await this.dataSource
      .getRepository(User)
      .createQueryBuilder('t0')
      .select('t0.id', 'id')
      .addSelect('t0.username', 'username')
      .leftJoin('t0.created_deals', 't1')
      .addSelect('SUM(t1.budget)', 'total_budget')
      .addSelect('COUNT(t1.id)', 'deal_count')
      .where('t1.created_at > :from_date', { from_date: query.from_date })
      .andWhere('t1.created_at < :till_date', { till_date: query.till_date })
      .andWhere('t0.role = :manager', { manager: RoleEnum.MANAGER })
      .andWhere('t0.id = :user_id', { user_id })
      .groupBy('t0.id')
      .getRawMany();

    const totalManagerStats = await this.dataSource
      .getRepository(User)
      .createQueryBuilder('t0')
      .leftJoin('t0.created_deals', 't1')
      .select('SUM(t1.budget)', 'total_budget')
      .addSelect('COUNT(t1.id)', 'deal_count')
      .where('t1.created_at > :from_date', { from_date: query.from_date })
      .andWhere('t1.created_at < :till_date', { till_date: query.till_date })
      .andWhere('t0.role = :manager_role', { manager_role: RoleEnum.MANAGER })
      .andWhere('t0.id = :user_id', { user_id })
      .getRawOne();

    const fileStats = await this.dataSource
      .getRepository(File)
      .createQueryBuilder('t0')
      .leftJoin('t0.uploaded_by', 't1')
      .addSelect('t1.id')
      .addSelect('t1.username')
      .where('(t0.created_at > :from_date and t0.created_at < :till_date)', {
        from_date: query.from_date,
        till_date: query.till_date,
      })
      .andWhere('t0.uploaded_by = :user_id', { user_id })
      .orderBy('t0.created_at')
      .limit(10)
      .getMany();

    return {
      task_stats: taskStats,
      manager_stats: managerStats,
      total_manager_stats: totalManagerStats,
      file_stats: fileStats,
    };
  }
}
