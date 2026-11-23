import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { GroupService, GroupUsage } from './group.service';
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

  /** How many staff and open tasks the group has: the delete dialog of the group page asks with them. */
  @Roles(AuthGuard.ADMIN_LEVEL)
  @Get(':id/usage')
  async usage(@Param('id', ParseIntPipe) id: number): Promise<GroupUsage> {
    return this.groupService.usage(id);
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

  /**
   * 409 when the group still has staff or open tasks, unless `?move_to=<group id>`:
   * they are moved to that group first.
   */
  @Roles(AuthGuard.ADMIN_LEVEL)
  @Delete(':id')
  async delete(
    @Param('id', ParseIntPipe) id: number,
    @Query('move_to') moveTo?: string,
  ): Promise<void> {
    const target = moveTo === undefined || moveTo === '' ? undefined : Number(moveTo);
    if (target !== undefined && !Number.isInteger(target)) {
      throw new BadRequestException('move_to: id группы');
    }
    return this.groupService.delete(id, target);
  }
}
