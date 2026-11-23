import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DefaultTaskRelations, Task } from './task.entity';
import { DataSource, Repository } from 'typeorm';
import { HelperService } from '../helper/helper.service';
import {
  AssignToDto,
  CreateTaskDto,
  LinkToDto,
  TargetToEntityAttributeMapping,
  TargetToEntityMapping,
  UpdateTaskDto,
  ViableAssignTargets,
  ViableLinkTargets,
} from './dto/create.task.dto';
import { User, RoleEnum } from '../user/user.entity';
import { TaskType as TaskTypeEntity } from '../task_type/task_type.entity';
import { PaginationResponseDto } from '../helper/dto/pagination.dto';
import { CloseTaskDto } from './dto/close.task.dto';
import { Request } from 'express';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventTypes } from '../events/event.entity';
import { TaskEventDto } from '../events/dto/task.event.dto';
import SearchTaskDto, { TaskType } from './dto/search.task.dto';
import { NotificationGateWay } from 'src/gateway/notification.gateway';
import { AuthUser } from '../auth/auth.guard';
import { Access } from '../auth/access';
import { contactSql, taskVisibilitySql } from './task-access';
import { defaultTaskType } from '../task_type/default-task-type';

const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-11-23" without a time is a local date (the server's zone), not UTC midnight (05:00 here). */
export function isPlainDate(value: unknown): boolean {
  return typeof value === 'string' && PLAIN_DATE.test(value.trim());
}

export function toTaskDate(value: Date | string): Date {
  if (isPlainDate(value)) {
    const [y, m, d] = String(value).trim().split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(value);
}

/**
 * An all-day task lasts from 00:00 of its first day to 23:59 of its last day (local time), as the
 * bot makes them. An end at midnight is exclusive: an all-day event of the calendar on the 23rd
 * ends on the 24th at 00:00.
 */
export function allDaySpan(start: Date, end: Date): [Date, Date] {
  const from = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const atMidnight =
    end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0 && end.getMilliseconds() === 0;
  let last = atMidnight && end.getTime() > from.getTime() ? new Date(end.getTime() - 1) : end;
  if (last.getTime() < from.getTime()) last = from;
  return [from, new Date(last.getFullYear(), last.getMonth(), last.getDate(), 23, 59)];
}

const LINK_NAMES: Record<ViableLinkTargets, string> = {
  [ViableLinkTargets.DEAL]: 'Сделка',
  [ViableLinkTargets.COMPANY]: 'Компания',
  [ViableLinkTargets.CTR_AGENT]: 'Контакт',
};

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);

  constructor(
    @InjectRepository(Task)
    private taskRepository: Repository<Task>,
    private helperService: HelperService,
    private eventEmitter: EventEmitter2,
    private notificationGatewayService: NotificationGateWay,
    private dataSource: DataSource,
  ) { }

  /** `user`: the caller; everyone but admin and manager gets only the tasks they may see (task-access.ts). */
  async fetchAll(query: SearchTaskDto, user?: AuthUser): Promise<PaginationResponseDto<any>> {
    let qb = this.taskRepository.createQueryBuilder('t0');

    if (query.type_id) {
      qb = qb.where('t0.type_id = :type_id', { type_id: query.type_id });
    }

    if (query.deal_id) {
      qb = qb.andWhere('t0.deal_id = :deal_id', { deal_id: query.deal_id });
    }

    if (query.company_id) {
      qb = qb.andWhere(
        `(t0.company_id = :company_id
          OR t0.deal_id IN (SELECT cd.id FROM deal cd WHERE cd.company_id = :company_id)
          OR t0.ctr_agent_id IN (SELECT cu.id FROM "user" cu WHERE cu.company_id = :company_id AND cu.role = :contact_role))`,
        { company_id: query.company_id, contact_role: RoleEnum.CTR_AGENT },
      );
    }

    if (query.ctr_agent_id) {
      qb = qb.andWhere(
        `(t0.ctr_agent_id = :ctr_agent_id
          OR t0.deal_id IN (SELECT du."dealId" FROM deal_user du WHERE du."userId" = :ctr_agent_id))`,
        { ctr_agent_id: query.ctr_agent_id },
      );
    }

    if (query.stage_ids) {
      qb = qb
        .leftJoinAndSelect('t0.deal', 't1')
        .andWhere('t1.stage_id IN (:...stage_ids)', {
          stage_ids: query.stage_ids,
        });
    }

    if (query.assigned_to && query.assigned_to.length > 0) {
      qb = qb.andWhere('t0.agent_id IN (:...user_ids)', {
        user_ids: query.assigned_to,
      });
    }

    if (query.created_by && query.created_by.length > 0) {
      qb = qb.andWhere('t0.created_by IN (:...creator_ids)', {
        creator_ids: query.created_by,
      });
    }

    // "Мои": assigned to me or to my group
    if (user && ['true', '1'].includes(String(query.mine ?? '').toLowerCase())) {
      qb = qb.andWhere(
        user.group_id != null
          ? '(t0.agent_id = :mine_user OR t0.group_id = :mine_group)'
          : 't0.agent_id = :mine_user',
        { mine_user: user.sub, mine_group: user.group_id },
      );
    }

    // a plain end date means the whole day (the list sends dates, the calendar the end of its view)
    const tillDate = isPlainDate(query.till_date) ? `${query.till_date} 23:59:59.999` : query.till_date;
    if (query.from_date && query.till_date) {
      qb = qb.andWhere(
        '(t0.start_time, t0.end_time) OVERLAPS (:requested_start_time, :requested_end_time)',
        {
          requested_start_time: query.from_date,
          requested_end_time: tillDate,
        },
      );
    } else {
      if (query.from_date) {
        qb = qb.andWhere('t0.end_time >= :from_date', {
          from_date: query.from_date,
        });
      }

      if (query.till_date) {
        qb = qb.andWhere('t0.start_time <= :till_date', {
          till_date: tillDate,
        });
      }
    }

    switch (query.type) {
      case TaskType.CLOSED:
        qb = qb.andWhere('t0.closed_at IS NOT NULL');
        break;
      case TaskType.OVERDUE:
        qb = qb.andWhere('t0.end_time < :current_time AND t0.closed_at IS NULL', { current_time: new Date() });
        break;
      case TaskType.ALL:
        break;
      default:
        // no status (the deal page, older clients) or "open"
        qb = qb.andWhere('t0.closed_at IS NULL');
    }

    // Tasks of (soft) deleted deals stay in the database, but are not listed
    qb = qb.andWhere(
      'NOT EXISTS (SELECT 1 FROM deal dd WHERE dd.id = t0.deal_id AND dd.deleted_at IS NOT NULL)',
    );

    const visible = taskVisibilitySql(user, 't0');
    if (visible) {
      qb = qb.andWhere(visible.sql, visible.params);
    }

    const response = await this.helperService.withPagination(
      this.helperService.withRelations<any>(qb, DefaultTaskRelations, 't0', 3),
      query,
    );

    response.data = response.data.map((task: Task) => {
      // Destructure the user object to get the start_time and end_time properties
      const { start_time, end_time, ...rest } = task;

      // Rename properties and return the modified user object
      return {
        ...rest,
        start: start_time,
        end: end_time,
      };
    });

    return response;
  }

  async getById(id: number): Promise<Task> {
    return this.helperService.getById(Task, id, DefaultTaskRelations);
  }

  /** GET /tasks/:id: a task the user may not see is "not found", like a hidden deal. */
  async getVisibleById(id: number, user?: AuthUser): Promise<Task> {
    const task = await this.getById(id);
    const visible = taskVisibilitySql(user, 'vt');
    if (visible) {
      const row = await this.dataSource
        .createQueryBuilder()
        .select('1', 'ok')
        .from('task', 'vt')
        .where('vt.id = :task_id', { task_id: id })
        .andWhere(visible.sql, visible.params)
        .getRawOne();
      if (!row) throw new NotFoundException(`Task with id ${id} does not exist!`);
    }
    return task;
  }

  /** `user`: the caller of POST /tasks; the deal, company or contact must be visible to them. */
  async create(
    creator_id: number,
    data: CreateTaskDto,
    user?: AuthUser,
  ): Promise<Record<string, any>> {
    if (user) await this.assertCanLink(user, data.link_to);

    let newTask = new Task();
    const creator = await this.helperService.getById(User, creator_id);

    newTask = await this.assignValuesToEntity(newTask, data, creator);

    let savedTask = await this.taskRepository.save(newTask);
    savedTask = this.helperService.addUndefinedRelations(
      savedTask,
      DefaultTaskRelations,
    );

    const eventData: TaskEventDto = {
      task: savedTask,
      deal: savedTask.deal,
      originated_by: creator,
    };

    this.eventEmitter.emit(EventTypes.NEW_TASK.toString(), eventData);

    // The task is already saved: a failed notification must not fail the request
    try {
      await this.notifyAboutNewTask(savedTask);
    } catch (error) {
      this.logger.error(
        `Task ${savedTask.id} is created, but the notification failed: ${error?.message}`,
      );
    }

    return savedTask;
  }

  /**
   * Notifies about a new task linked to a company, a deal or a contact.
   *
   * The `notification` table requires a company, so the row is written when a
   * company can be found: the company itself, the company of the deal or the
   * company of the contact. The websocket notification is sent in any case.
   */
  private async notifyAboutNewTask(task: Task): Promise<void> {
    const companyId = await this.findCompanyIdOfTask(task);

    if (companyId) {
      await this.dataSource
        .createQueryBuilder()
        .insert()
        .into('notification')
        .values({ message: 'new task', company_id: companyId })
        .execute();
    }

    this.notificationGatewayService.sendNotification(JSON.stringify(task));
  }

  private async findCompanyIdOfTask(task: Task): Promise<number | null> {
    if (task.company) {
      return task.company.id;
    }

    let rows: { company_id: number | null }[] = [];

    if (task.deal) {
      rows = await this.dataSource.query(
        'SELECT company_id FROM deal WHERE id = $1',
        [task.deal.id],
      );
    } else if (task.ctr_agent) {
      rows = await this.dataSource.query(
        'SELECT company_id FROM "user" WHERE id = $1',
        [task.ctr_agent.id],
      );
    }

    return rows[0]?.company_id ?? null;
  }

  /**
   * PATCH /tasks/:id. Only what is sent changes. The links stay when the client sends what the
   * task is already linked to: an automatic task (deal + its company) moved on the board or in the
   * calendar used to lose its deal, because the client sends the company first.
   */
  async update(id: number, data: UpdateTaskDto, user?: AuthUser): Promise<Task> {
    const task = await this.helperService.getById(Task, id, DefaultTaskRelations);
    const before = {
      start: new Date(task.start_time).getTime(),
      agent: task.agent?.id ?? null,
      group: task.group?.id ?? null,
    };

    this.setTimes(
      task,
      data.start_time ?? task.start_time,
      data.end_time ?? task.end_time,
      data.allDay ?? task.allDay,
    );

    if (data.assign_to) {
      task.resetAssignTarget();
      await this.assignTo(task, data.assign_to);
    }

    if (data.link_to && !(await this.isCurrentLink(task, data.link_to))) {
      if (user) await this.assertCanLink(user, data.link_to);
      task.resetLinkTarget();
      await this.linkTo(task, data.link_to);
    }

    if (data.label !== undefined) {
      task.label = data.label;
    }

    if (data.type_id) {
      task.type = await this.helperService.getById(TaskTypeEntity, data.type_id);
    } else if (!task.type) {
      task.type = await defaultTaskType(this.taskRepository.manager);
    }

    const saved = await this.taskRepository.save(task);

    // moved or handed over: the bot reminds again before the new start (bot-reminder.service.ts)
    if (
      before.start !== new Date(saved.start_time).getTime() ||
      before.agent !== (saved.agent?.id ?? null) ||
      before.group !== (saved.group?.id ?? null)
    ) {
      await this.dataSource
        .query('DELETE FROM bot_reminder WHERE task_id = $1', [id])
        .catch((error) => this.logger.warn(`task ${id}: the bot reminder is not reset: ${error?.message}`));
    }

    return saved;
  }

  async delete(id: number): Promise<void> {
    return this.helperService.deleteById(Task, id);
  }

  async close(id: number, data: CloseTaskDto, request: Request): Promise<void> {
    const task = await this.helperService.getById(
      Task,
      id,
      DefaultTaskRelations,
    );

    task.result = data.result;
    task.closed_at = new Date();

    const savedTask = await this.taskRepository.save(task);

    const eventData: TaskEventDto = {
      task: savedTask,
      deal: savedTask.deal,
      originated_by: await this.helperService.extractUserFromRequest(request),
    };
    this.eventEmitter.emit(EventTypes.NEW_TASK_STATUS.toString(), eventData);
  }

  private async assignValuesToEntity(
    task: Task,
    data: CreateTaskDto,
    creator?: User,
  ): Promise<Task> {
    this.setTimes(task, data.start_time, data.end_time, data.allDay);

    // Assign newTask to a Group/User[role=agent]
    await this.assignTo(task, data.assign_to);

    // Link newTask to a Company/Deal/User[role=ctr_agent]
    await this.linkTo(task, data.link_to);

    if (creator) {
      task.created_by = creator;
    }

    task.label = data.label;
    // a task without a type breaks the task board and the deal history of older clients
    task.type = data.type_id
      ? await this.helperService.getById(TaskTypeEntity, data.type_id)
      : await defaultTaskType(this.taskRepository.manager);

    return task;
  }

  /**
   * Start, end and "all day". A date without a time ("2026-11-23", a click on a day in the calendar)
   * is that local day, and such a task is an all-day one (it used to become a task at 05:00).
   */
  private setTimes(task: Task, start: Date | string, end: Date | string, allDay: boolean): void {
    let from = toTaskDate(start);
    let till = toTaskDate(end ?? start);
    if (Number.isNaN(from.getTime()) || Number.isNaN(till.getTime())) {
      throw new BadRequestException('Неверная дата задачи');
    }
    const wholeDay = !!allDay || (isPlainDate(start) && isPlainDate(end ?? start));
    if (wholeDay) {
      [from, till] = allDaySpan(from, till);
    }
    if (till.getTime() < from.getTime()) {
      throw new BadRequestException('Срок задачи раньше её начала');
    }
    task.start_time = from;
    task.end_time = till;
    task.allDay = wholeDay;
  }

  private async assignTo(task: Task, assign: AssignToDto): Promise<void> {
    const assignTargetEntity = TargetToEntityMapping[assign.target];
    const assignee = await this.helperService.getById(assignTargetEntity, assign.id);
    if (assign.target === ViableAssignTargets.AGENT && (assignee as User).role === RoleEnum.CTR_AGENT) {
      throw new BadRequestException('Исполнителем задачи может быть только сотрудник, а не контакт клиента');
    }
    task[TargetToEntityAttributeMapping[assign.target]] = assignee;
  }

  private async linkTo(task: Task, link: LinkToDto): Promise<void> {
    const linkTargetEntity = TargetToEntityMapping[link.target];
    task[TargetToEntityAttributeMapping[link.target]] =
      await this.helperService.getById(linkTargetEntity, link.id);
  }

  /** The client sends what the task is linked to already: the deal, the contact, the company or the company of its deal. */
  private async isCurrentLink(task: Task, link: LinkToDto): Promise<boolean> {
    switch (link.target) {
      case ViableLinkTargets.DEAL:
        return task.deal?.id === link.id;
      case ViableLinkTargets.CTR_AGENT:
        return task.ctr_agent?.id === link.id;
      case ViableLinkTargets.COMPANY: {
        if (task.company?.id === link.id) return true;
        if (!task.deal) return false;
        const rows = await this.dataSource.query('SELECT company_id FROM deal WHERE id = $1', [task.deal.id]);
        return rows[0]?.company_id != null && Number(rows[0].company_id) === link.id;
      }
    }
    return false;
  }

  /** A task may be put only on a deal, company or contact the user sees (and that is not in the trash). */
  private async assertCanLink(user: AuthUser, link: LinkToDto): Promise<void> {
    const access = new Access(user);
    let table: string;
    let filter: string;
    let cond: { sql: string; params: Record<string, any> };
    switch (link.target) {
      case ViableLinkTargets.DEAL:
        table = 'deal';
        filter = 'lt.deleted_at IS NULL';
        cond = access.dealSql('lt', 'view');
        break;
      case ViableLinkTargets.COMPANY:
        table = 'company';
        filter = 'lt.deleted_at IS NULL';
        cond = access.companySql('lt', 'view');
        break;
      default:
        table = 'user';
        filter = `lt.deleted_at IS NULL AND lt.role = '${RoleEnum.CTR_AGENT}'`;
        cond = contactSql(access, 'lt');
    }
    const row = await this.dataSource
      .createQueryBuilder()
      .select('1', 'ok')
      .from(table, 'lt')
      .where('lt.id = :link_id', { link_id: link.id })
      .andWhere(filter)
      .andWhere(cond.sql, cond.params)
      .getRawOne();
    if (!row) {
      throw new NotFoundException(`${LINK_NAMES[link.target] ?? 'Запись'} ${link.id} не найдена или нет доступа`);
    }
  }
}
