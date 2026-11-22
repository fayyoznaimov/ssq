import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Repository } from 'typeorm';
import { Task } from '../task/task.entity';
import { Deal } from '../deal/deal.entity';
import { EventTypes } from '../events/event.entity';
import { TaskEventDto } from '../events/dto/task.event.dto';
import { NotificationGateWay } from '../gateway/notification.gateway';

/** Labels of the tasks the CRM creates by itself; the rules find their own tasks by these prefixes. */
export const AUTO_NEXT_STEP = 'Авто: запланируйте следующий шаг по сделке';
export const AUTO_REPLY = 'Авто: ответьте клиенту';

/** A task for the responsible manager of a deal, created by a rule instead of a person. */
@Injectable()
export class AutoTaskService {
  private readonly logger = new Logger(AutoTaskService.name);

  constructor(
    @InjectRepository(Task) private tasks: Repository<Task>,
    @InjectRepository(Deal) private deals: Repository<Deal>,
    private eventEmitter: EventEmitter2,
    private gateway: NotificationGateWay,
  ) {}

  /** null when the deal has nobody responsible. Appears in the deal feed and live in the browser like any task. */
  async create(dealId: number, label: string, dueAt: Date): Promise<Task | null> {
    const deal = await this.deals.findOne({ where: { id: dealId }, relations: ['agent', 'company'] });
    if (!deal?.agent) return null;

    const task = new Task();
    task.label = label.slice(0, 255);
    task.agent = deal.agent;
    task.created_by = deal.agent;
    task.deal = deal;
    task.company = deal.company ?? null;
    task.allDay = false;
    task.start_time = new Date();
    task.end_time = dueAt;
    const saved = await this.tasks.save(task);

    const eventData: TaskEventDto = { task: saved, deal, originated_by: deal.agent };
    this.eventEmitter.emit(EventTypes.NEW_TASK.toString(), eventData);
    try {
      this.gateway.sendNotification(JSON.stringify(saved));
    } catch (error) {
      this.logger.warn(`notification about task ${saved.id} failed: ${(error as Error).message}`);
    }
    return saved;
  }
}
