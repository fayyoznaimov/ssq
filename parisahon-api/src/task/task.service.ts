import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DefaultTaskRelations, Task } from './task.entity';
import { DataSource, Repository } from 'typeorm';
import { HelperService } from '../helper/helper.service';
import {
  CreateTaskDto,
  TargetToEntityAttributeMapping,
  TargetToEntityMapping,
} from './dto/create.task.dto';
import { User } from '../user/user.entity';
import { TaskType as TaskTypeEntity } from '../task_type/task_type.entity';
import { PaginationResponseDto } from '../helper/dto/pagination.dto';
import { CloseTaskDto } from './dto/close.task.dto';
import { Request } from 'express';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventTypes } from '../events/event.entity';
import { TaskEventDto } from '../events/dto/task.event.dto';
import SearchTaskDto, { TaskType } from './dto/search.task.dto';
import { NotificationGateWay } from 'src/gateway/notification.gateway';

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

  async fetchAll(query: SearchTaskDto): Promise<PaginationResponseDto<any>> {
    let qb = this.taskRepository.createQueryBuilder('t0');

    if (query.type_id) {
      qb = qb.where('t0.type_id = :type_id', { type_id: query.type_id });
    }

    if (query.deal_id) {
      qb = qb.andWhere('t0.deal_id = :deal_id', { deal_id: query.deal_id });
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
      qb = qb.andWhere('t0.created_by IN (:...user_ids)', {
        user_ids: query.created_by,
      });
    }

    if (query.from_date && query.till_date) {
      qb = qb.andWhere(
        '(t0.start_time, t0.end_time) OVERLAPS (:requested_start_time, :requested_end_time)',
        {
          requested_start_time: query.from_date,
          requested_end_time: query.till_date,
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
          till_date: query.till_date,
        });
      }
    }

    /**
     * This could be written in a separate function to avoid else statement
     * However, this logic is fairly simple and easier to read right in the spot
     */
    if (query.type) {
      if (query.type === TaskType.CLOSED) {
        qb = qb.andWhere('t0.closed_at IS NOT NULL');
      } else {
        // Overdue tasks
        qb = qb.andWhere(
          't0.end_time < :current_time AND t0.closed_at IS NULL',
          {
            current_time: new Date(),
          },
        );
      }
    } else {
      qb = qb.andWhere('t0.closed_at IS NULL');
    }

    // Tasks of (soft) deleted deals stay in the database, but are not listed
    qb = qb.andWhere(
      'NOT EXISTS (SELECT 1 FROM deal dd WHERE dd.id = t0.deal_id AND dd.deleted_at IS NOT NULL)',
    );

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

  async create(
    creator_id: number,
    data: CreateTaskDto,
  ): Promise<Record<string, any>> {
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

  async update(id: number, data: CreateTaskDto): Promise<Task> {
    let task = await this.helperService.getById(Task, id, DefaultTaskRelations);

    task.resetAssignTarget();
    task.resetLinkTarget();

    task = await this.assignValuesToEntity(task, data);

    return this.taskRepository.save(task);
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
    // Assign newTask to a Group/User[role=agent]
    const assignTargetEntity = TargetToEntityMapping[data.assign_to.target];
    task[TargetToEntityAttributeMapping[data.assign_to.target]] =
      await this.helperService.getById(assignTargetEntity, data.assign_to.id);

    // Link newTask to a Company/Deal/User[role=ctr_agent]
    const linkTargetEntity = TargetToEntityMapping[data.link_to.target];
    task[TargetToEntityAttributeMapping[data.link_to.target]] =
      await this.helperService.getById(linkTargetEntity, data.link_to.id);

    if (creator) {
      task.created_by = creator;
    }

    task.label = data.label;
    task.type = await this.helperService.getById(TaskTypeEntity, data.type_id);
    task.start_time = data.start_time;
    task.end_time = data.end_time;
    task.allDay = data.allDay;

    return task;
  }
}
