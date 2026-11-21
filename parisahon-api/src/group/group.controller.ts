import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { GroupService } from './group.service';
import { Roles } from '../auth/decorator/roles.decorator';
import { AuthGuard } from '../auth/auth.guard';
import { CreateGroupDto } from './dto/create.group.dto';
import { Group } from './group.entity';

@Controller('groups')
export class GroupController {
  constructor(private groupService: GroupService) {}

  @Get()
  async findAll(): Promise<Group[]> {
    return this.groupService.fetchAll();
  }

  @Roles(AuthGuard.ADMIN_LEVEL)
  @Post()
  async create(@Body() data: CreateGroupDto): Promise<Group> {
    return this.groupService.create(data);
  }

  @Roles(AuthGuard.ADMIN_LEVEL)
  @Patch(':id')
  async update(
    @Body() data: CreateGroupDto,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    return this.groupService.update(id, data);
  }

  @Roles(AuthGuard.ADMIN_LEVEL)
  @Delete(':id')
  async delete(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.groupService.delete(id);
  }
}
