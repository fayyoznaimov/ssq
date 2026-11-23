import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { TaskType as TaskTypeEntity } from './task_type.entity';
import { Repository } from 'typeorm';
import CreateTaskTypeDto from './dto/create.task_type.dto';
import { HelperService } from '../helper/helper.service';

@Injectable()
export class TaskTypeService {
  constructor(
    @InjectRepository(TaskTypeEntity)
    private taskTypeRepository: Repository<TaskTypeEntity>,
    private helperService: HelperService,
  ) {}

  async fetchAll(): Promise<TaskTypeEntity[]> {
    return this.taskTypeRepository.find();
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
   * The tasks of a deleted type move to another type (DEFAULT_TASK_TYPE when it is not the deleted
   * one): a task without a type breaks the task board and the history of older clients. The last
   * type and a type that a trigger creates tasks of are not deleted.
   */
  async delete(id: number): Promise<void> {
    const taskType = await this.helperService.getById(TaskTypeEntity, id);
    const defaultName = (process.env.DEFAULT_TASK_TYPE || 'Связаться').trim();
    await this.taskTypeRepository.manager.transaction(async (manager) => {
      const replacement: { id: number; name: string }[] = await manager.query(
        `SELECT id, name FROM task_type WHERE id <> $1 ORDER BY (name = $2) DESC, id LIMIT 1`,
        [id, defaultName],
      );
      if (!replacement.length) {
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
      await manager.query('UPDATE task SET type_id = $1 WHERE type_id = $2', [replacement[0].id, id]);
      await manager.query('DELETE FROM task_type WHERE id = $1', [id]);
    });
  }

  async throwExceptionIfNameAlreadyExists(name: string): Promise<void> {
    const taskType = await this.taskTypeRepository.findOneBy({
      name: name,
    });
    if (taskType) {
      throw new BadRequestException(
        `TaskType with name ${name} already exists!`,
      );
    }
  }
}
