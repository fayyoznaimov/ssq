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
import { TaskService } from './task.service';
import { AuthGuard } from '../auth/auth.guard';
import { CreateTaskDto } from './dto/create.task.dto';
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

  @Get()
  async fetchAll(@Query() query: SearchTaskDto): Promise<Record<string, any>> {
    return instanceToPlain(this.taskService.fetchAll(query));
  }

  @Get(':id')
  async fetchById(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<Record<string, any>> {
    return instanceToPlain(await this.taskService.getById(id));
  }

  @Post()
  async create(
    @Body() data: CreateTaskDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(
      await this.taskService.create(request['user']?.sub, data),
    );
  }

  @Patch(':id')
  async update(
    @Body() data: CreateTaskDto,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    const savedTask = await this.taskService.update(id, data);

    return this.eventService.updateTaskEvent(savedTask);
  }

  @Patch(':id/close')
  async close(
    @Body() data: CloseTaskDto,
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<void> {
    return this.taskService.close(id, data, request);
  }

  @Delete(':id')
  async delete(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.taskService.delete(id);
  }
}
