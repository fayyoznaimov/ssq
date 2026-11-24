import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { Task } from '../task/task.entity';
import { User } from '../user/user.entity';
import { EventTypes } from '../events/event.entity';
import { TaskEventDto } from '../events/dto/task.event.dto';
import { AutoTaskService } from '../automation/auto-task.service';
import { NotificationGateWay } from '../gateway/notification.gateway';

/**
 * The tasks the AI makes and closes, and the live update of the deal page.
 * A task is made by AutoTaskService (for the deal's responsible manager, in the deal feed, live);
 * it is closed like a trigger closes one: closed_at and the result, and «Задача закрыта» in the deal
 * history — but only when none of the questions or promises it was made for is still open.
 */
@Injectable()
export class AiTaskService {
  private readonly logger = new Logger('AiTasks');

  constructor(
    @InjectRepository(Task) private tasks: Repository<Task>,
    private dataSource: DataSource,
    private autoTasks: AutoTaskService,
    private eventEmitter: EventEmitter2,
    private gateway: NotificationGateWay,
  ) {}

  create(dealId: number, label: string, dueAt: Date): Promise<Task | null> {
    return this.autoTasks.create(dealId, label, dueAt);
  }

  /** Closes the task when no open question or promise is linked to it any more; true if it was closed now. */
  async closeIfDone(taskId: number, result: string, by: User | null = null): Promise<boolean> {
    const open = await this.dataSource.query(`SELECT 1 FROM conversation_item WHERE task_id = $1 AND status = 'open' LIMIT 1`, [taskId]);
    if (open.length) return false;
    const task = await this.tasks.findOne({
      where: { id: taskId },
      relations: ['deal', 'agent', 'type', 'created_by', 'company', 'group'],
    });
    if (!task || task.closed_at) return false;
    task.closed_at = new Date();
    task.result = result;
    // only the two columns: the loaded relations are not written back
    await this.tasks.update(task.id, { closed_at: task.closed_at, result });
    const eventData: TaskEventDto = { task, deal: task.deal, originated_by: by ?? task.agent };
    this.eventEmitter.emit(EventTypes.NEW_TASK_STATUS.toString(), eventData);
    return true;
  }

  async closeAllIfDone(taskIds: (number | null | undefined)[], result: string, by: User | null = null): Promise<number> {
    let closed = 0;
    for (const id of [...new Set(taskIds.filter((t): t is number => Number.isInteger(t)))]) {
      try {
        if (await this.closeIfDone(id, result, by)) closed++;
      } catch (error) {
        this.logger.warn(`task ${id}: cannot close: ${(error as Error).message}`);
      }
    }
    return closed;
  }

  /** The deal page reloads its AI block (socket 'changed' {ai: [dealId]}: ids only, never data). */
  changed(dealId: number): void {
    try {
      this.gateway.server?.emit('changed', { ai: [dealId] });
    } catch (error) {
      this.logger.warn(`live update: ${(error as Error).message}`);
    }
  }
}
