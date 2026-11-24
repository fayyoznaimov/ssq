import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { Roles } from '../auth/decorator/roles.decorator';
import { TaskTypeService } from './task_type.service';
import { TaskType as TaskTypeEntity } from './task_type.entity';
import CreateTaskTypeDto from './dto/create.task_type.dto';

@Controller('task-types')
export class TaskTypeController {
  constructor(private taskTypeService: TaskTypeService) {}

  @Get()
  async findAll(): Promise<TaskTypeEntity[]> {
    return this.taskTypeService.fetchAll();
  }

  @Get(':id')
  async findById(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<TaskTypeEntity> {
    return this.taskTypeService.getById(id);
  }

  @Roles(AuthGuard.ADMIN_LEVEL)
  @Post()
  async create(@Body() data: CreateTaskTypeDto): Promise<TaskTypeEntity> {
    return this.taskTypeService.create(data);
  }

  @Roles(AuthGuard.ADMIN_LEVEL)
  @Patch(':id')
  async update(
    @Body() data: CreateTaskTypeDto,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.taskTypeService.update(id, data);
  }

  // a type with tasks: 409 TASK_TYPE_IN_USE unless ?move_to=<type id> says where its tasks go
  @Roles(AuthGuard.ADMIN_LEVEL)
  @Delete(':id')
  async delete(
    @Param('id', ParseIntPipe) id: number,
    @Query('move_to') moveTo?: string,
  ): Promise<{ moved: number; move_to: number | null }> {
    const target = moveTo !== undefined && moveTo !== '' ? Number(moveTo) : null;
    if (target !== null && !Number.isInteger(target)) throw new BadRequestException('move_to должен быть id типа задач');
    return this.taskTypeService.delete(id, target);
  }
}
