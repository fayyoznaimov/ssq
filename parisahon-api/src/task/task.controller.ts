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
  Req,
  UseGuards,
} from '@nestjs/common';
import { RecordAccess } from '../auth/access';
import { TaskService } from './task.service';
import { AuthGuard } from '../auth/auth.guard';
import { CreateTaskDto, UpdateTaskDto } from './dto/create.task.dto';
import { Request } from 'express';
import { instanceToPlain } from 'class-transformer';
import { CloseTaskDto } from './dto/close.task.dto';
import { EventsService } from '../events/events.service';
import SearchTaskDto from './dto/search.task.dto';

@UseGuards(AuthGuard)
@Controller('tasks')
export class TaskController {
  constructor(
    private taskService: TaskService,
    private eventService: EventsService,
  ) { }

  // tasks carry their deal, company and contact: only the tasks of records the user may see (task-access.ts)
  @Get()
  async fetchAll(
    @Query() query: SearchTaskDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(await this.taskService.fetchAll(query, request['user']));
  }

  @Get(':id')
  async fetchById(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(await this.taskService.getVisibleById(id, request['user']));
  }

  @Post()
  async create(
    @Body() data: CreateTaskDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(
      await this.taskService.create(request['user']?.sub, data, request['user']),
    );
  }

  // only what is sent changes (a drag in the calendar sends the times only)
  @Patch(':id')
  @RecordAccess('task', 'update')
  async update(
    @Body() data: UpdateTaskDto,
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<void> {
    // a task the user does not see is "not found" (the guard checks the right to change it)
    await this.taskService.getVisibleById(id, request['user']);
    const savedTask = await this.taskService.update(id, data, request['user']);

    // the change is a new history entry with its author (the creation entry stays as it was)
    return this.eventService.updateTaskEvent(savedTask, request['user']?.sub);
  }

  @Patch(':id/close')
  @RecordAccess('task', 'update')
  async close(
    @Body() data: CloseTaskDto,
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<void> {
    await this.taskService.getVisibleById(id, request['user']);
    return this.taskService.close(id, data, request);
  }

  @Delete(':id')
  @RecordAccess('task', 'delete')
  async delete(@Param('id', ParseIntPipe) id: number, @Req() request: Request): Promise<void> {
    await this.taskService.getVisibleById(id, request['user']);
    return this.taskService.delete(id);
  }
}
