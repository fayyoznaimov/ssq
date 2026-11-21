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

  async delete(id: number): Promise<void> {
    return this.helperService.deleteById(TaskTypeEntity, id);
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
