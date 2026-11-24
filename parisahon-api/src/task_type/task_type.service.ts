import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { TaskType as TaskTypeEntity } from './task_type.entity';
import { Repository } from 'typeorm';
import CreateTaskTypeDto from './dto/create.task_type.dto';
import { HelperService } from '../helper/helper.service';
import { AuditJournal } from '../audit/audit-journal';

/** 1 задача, 2 задачи, 5 задач */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

@Injectable()
export class TaskTypeService {
  constructor(
    @InjectRepository(TaskTypeEntity)
    private taskTypeRepository: Repository<TaskTypeEntity>,
    private helperService: HelperService,
  ) {}

  /**
   * The types with `task_count` (how many tasks a deletion moves) and `default` (the type that takes
   * them and the tasks the CRM makes itself: DEFAULT_TASK_TYPE, else the first one), for the settings window.
   */
  async fetchAll(): Promise<(TaskTypeEntity & { task_count: number; default: boolean })[]> {
    const types = await this.taskTypeRepository.find({ order: { id: 'ASC' } });
    const counts: { type_id: number; n: number }[] = await this.taskTypeRepository.manager.query(
      'SELECT type_id, COUNT(*)::int AS n FROM task WHERE type_id IS NOT NULL GROUP BY type_id',
    );
    const byType = new Map(counts.map((c) => [Number(c.type_id), Number(c.n)]));
    const defaultName = (process.env.DEFAULT_TASK_TYPE || 'Связаться').trim();
    const defaultId = (types.find((t) => t.name === defaultName) ?? types[0])?.id;
    return types.map((t) => Object.assign(t, { task_count: byType.get(t.id) ?? 0, default: t.id === defaultId }));
  }

  async getById(id: number): Promise<TaskTypeEntity> {
    return this.helperService.getById(TaskTypeEntity, id);
  }

  async create(data: CreateTaskTypeDto): Promise<TaskTypeEntity> {
    await this.throwExceptionIfNameAlreadyExists(data.name);

    const newTaskType = new TaskTypeEntity();
    newTaskType.name = data.name;

    return this.taskTypeRepository.save(newTaskType);
  }

  async update(id: number, data: CreateTaskTypeDto): Promise<void> {
    const taskType = await this.helperService.getById(TaskTypeEntity, id);
    if (taskType.name !== data.name) {
      await this.throwExceptionIfNameAlreadyExists(data.name);
    }

    taskType.name = data.name;

    await this.taskTypeRepository.save(taskType);
  }

  /**
   * DELETE /task-types/:id. A type without tasks is just deleted. A type with tasks is not deleted
   * silently (their tasks would lose the type, the board and the history broke on that): 409
   * TASK_TYPE_IN_USE with the number of tasks and the type that would take them, and the client asks;
   * with `moveTo` (?move_to=<id>) its tasks move to that type first, in one transaction. The last type
   * and a type that a trigger creates tasks of are not deleted.
   */
  async delete(id: number, moveTo?: number | null): Promise<{ moved: number; move_to: number | null }> {
    const taskType = await this.helperService.getById(TaskTypeEntity, id);
    const defaultName = (process.env.DEFAULT_TASK_TYPE || 'Связаться').trim();
    return this.taskTypeRepository.manager.transaction(async (manager) => {
      const others: { id: number; name: string }[] = await manager.query(
        `SELECT id, name FROM task_type WHERE id <> $1 ORDER BY (name = $2) DESC, id`,
        [id, defaultName],
      );
      if (!others.length) {
        throw new BadRequestException('Нельзя удалить последний тип задач');
      }
      const triggers: { id: number }[] = await manager.query(
        `SELECT id FROM "trigger" WHERE data IS NOT NULL AND jsonb_typeof(data) = 'object' AND data->>'type_id' = $1::text`,
        [String(id)],
      );
      if (triggers.length) {
        throw new BadRequestException(
          `Тип «${taskType.name}» используется в триггерах (${triggers.map((t) => t.id).join(', ')}): сначала выберите в них другой тип`,
        );
      }
      const count = Number(
        (await manager.query('SELECT COUNT(*)::int AS n FROM task WHERE type_id = $1', [id]))[0]?.n ?? 0,
      );
      let target: { id: number; name: string } | null = null;
      if (count > 0) {
        if (moveTo === undefined || moveTo === null) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: 'TASK_TYPE_IN_USE',
            message: `У типа «${taskType.name}» ${count} ${plural(count, 'задача', 'задачи', 'задач')}: перенесите их на другой тип`,
            task_count: count,
            move_to: others[0],
          });
        }
        target = others.find((t) => t.id === Number(moveTo)) ?? null;
        if (!target) {
          throw new BadRequestException('Тип, на который переносятся задачи, не найден (или это удаляемый тип)');
        }
        // the journal (src/audit): «Тип: … → …» of every task moved, in this transaction
        await AuditJournal.around(manager, 'task', 't.type_id = $1', [id], () =>
          manager.query('UPDATE task SET type_id = $1 WHERE type_id = $2', [target.id, id]),
        );
      }
      await AuditJournal.around(manager, 'task_type', 't.id = $1', [id], () => manager.query('DELETE FROM task_type WHERE id = $1', [id]));
      return { moved: count, move_to: target?.id ?? null };
    });
  }

  async throwExceptionIfNameAlreadyExists(name: string): Promise<void> {
    const taskType = await this.taskTypeRepository.findOneBy({
      name: name,
    });
    if (taskType) {
      throw new BadRequestException(`Тип задач «${name}» уже есть`);
    }
  }
}
