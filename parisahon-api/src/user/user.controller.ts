import { ClientHistoryService } from '../deal/client-history.service';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Access, RecordAccess } from '../auth/access';
import { Request } from 'express';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/create.user.dto';
import { AuthGuard, AuthUser } from '../auth/auth.guard';
import { Roles } from '../auth/decorator/roles.decorator';
import { instanceToPlain } from 'class-transformer';
import { ChangeOwnPasswordDto, MergeContactsDto, UpdateOwnProfileDto, UpdateUserDto } from './dto/update.user.dto';
import { SearchUserQueryDto, StaffQueryDto } from './dto/search.user.query.dto';
import { PaginationRequestDto } from '../helper/dto/pagination.dto';
import { EventsService } from 'src/events/events.service';
import { SearchEventDto } from 'src/events/dto/search.event.dto';
import { CreateCommentDto } from 'src/events/dto/create.comment.dto';
import { RoleEnum } from './user.entity';

/**
 * Authentication is global (APP_GUARD in AppModule).
 *
 * `user` rows are both staff accounts (admin / manager / agent) and customer
 * contacts (ctr_agent), and the frontend works with contacts through /users,
 * so POST / PATCH / DELETE cannot be closed with @Roles: the service lets any
 * staff user manage ctr_agent rows and only admin manage staff accounts.
 */
@Controller('users')
export class UserController {
  constructor(
    private userService: UserService,
    private eventService: EventsService,
    private clientHistory: ClientHistoryService,
  ) { }

  @Roles(AuthGuard.MANAGER_LEVEL)
  @Get('/manager-statistics')
  async getManagersWithStats(
    @Query() query: PaginationRequestDto,
  ): Promise<Record<string, any>> {
    return instanceToPlain(this.userService.getManagerStatistics(query));
  }

  /**
   * The staff accounts only (admin, manager, agent), by name and without a page limit: the pickers
   * and filters of the responsible user and the assignee. Declared before ':id'.
   */
  @Get('staff')
  async fetchStaff(
    @Query() query: StaffQueryDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    const requester: AuthUser = request['user'];
    const response = instanceToPlain(await this.userService.fetchStaff(query), {
      groups: [requester.role],
    });
    response.data = (response.data ?? []).map((user: Record<string, any>) =>
      this.hideStaffDetails(user, requester),
    );
    return response;
  }

  // a contact: within the contact view right (a staff account: as before, hideStaffDetails)
  @Get(':id')
  @RecordAccess('contact', 'view')
  async fetchUser(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    const requester: AuthUser = request['user'];

    return this.hideStaffDetails(
      instanceToPlain(await this.userService.findById(id, true), {
        groups: [requester.role],
      }),
      requester,
    );
  }

  /**
   * Every deal a contact is linked to (tab "Сделки" of the contact card). The deals of a contact the user may see (an agent got 403 for every contact before: the rule
   * of a colleague's data applied); of a staff account: their own, or admin / manager.
   */
  @Get(':id/deals')
  @RecordAccess('contact', 'view')
  async fetchUserDeals(@Param('id', ParseIntPipe) id: number, @Req() request: Request) {
    const access = new Access(request['user']);
    await this.eventService.assertUserFeedAccess(id, access);
    return this.clientHistory.forContact(id, access);
  }

  /** The feed of a contact (the events of their deals the user may see) or of one's own account. */
  @Get(':id/events')
  @RecordAccess('contact', 'view')
  async fetchUserEvents(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: SearchEventDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(
      await this.eventService.fetchUserEvents(id, query, new Access(request['user'])),
    );
  }

  /** A note in the contact's feed, outside any deal (SCR2-4); the right to change the contact. */
  @Post(':id/comments')
  @RecordAccess('contact', 'update')
  async postContactNote(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: CreateCommentDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(await this.eventService.postClientNote({ contact_id: id }, data.comment, request['user'].sub));
  }

  /** The author changes their note. */
  @Patch(':id/comments/:event_id')
  @RecordAccess('contact', 'update')
  async updateContactNote(
    @Param('id', ParseIntPipe) id: number,
    @Param('event_id', ParseIntPipe) eventId: number,
    @Body() data: CreateCommentDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    return instanceToPlain(
      await this.eventService.updateClientNote({ contact_id: id }, eventId, data.comment, request['user'].sub),
    );
  }

  /** The author deletes their note. */
  @Delete(':id/comments/:event_id')
  @RecordAccess('contact', 'update')
  async deleteContactNote(
    @Param('id', ParseIntPipe) id: number,
    @Param('event_id', ParseIntPipe) eventId: number,
    @Req() request: Request,
  ): Promise<void> {
    await this.eventService.deleteClientNote({ contact_id: id }, eventId, request['user'].sub);
  }

  /**
   * Open to every staff role, not only admin + manager: the deal, task, mail
   * and contact screens load their "responsible" and contact pickers from here.
   * An agent gets other staff accounts without permissions / objectives / tg_id.
   */
  @Get()
  async fetchAll(
    @Query() query: SearchUserQueryDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    const requester: AuthUser = request['user'];
    // contacts only within the contact view right; staff accounts for everyone (the pickers)
    const response = instanceToPlain(await this.userService.fetchAll(query, requester));

    if (Array.isArray(response?.data)) {
      response.data = response.data.map((user: Record<string, any>) =>
        this.hideStaffDetails(user, requester),
      );
    }

    return response;
  }

  @Get(':id/files')
  @RecordAccess('staffData', 'view')
  async fetchUserFiles(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: PaginationRequestDto,
  ): Promise<Record<string, any>> {
    return instanceToPlain(this.userService.fetchUserFiles(id, query));
  }

  @Get(':id/recordings')
  @RecordAccess('staffData', 'view')
  async getAgentCallRecordings(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: PaginationRequestDto,
  ): Promise<Record<string, any>> {
    return instanceToPlain(this.userService.getAgentCallRecordings(id, query));
  }

  @Post()
  async createUser(
    @Body() data: CreateUserDto,
    @Req() request: Request,
  ): Promise<Record<string, any>> {
    // "Создание контактов" of the user card (was not checked anywhere)
    if (data.role === RoleEnum.CTR_AGENT && !new Access(request['user']).can('contact', 'create')) {
      throw new ForbiddenException('No right to create contacts');
    }
    return instanceToPlain(
      await this.userService.createUser(request['user'].role, data, request),
    );
  }

  /**
   * Own password: any staff user, old + new password, nothing else changes.
   * Declared before ':id' on purpose; 'me/password' has two segments and
   * cannot be taken for an id anyway.
   */
  @Patch('me/password')
  async changeOwnPassword(
    @Body() data: ChangeOwnPasswordDto,
    @Req() request: Request,
  ): Promise<{ access_token: string }> {
    return this.userService.changeOwnPassword(request['user'].sub, data);
  }

  /** Own name and phone, any staff user (PATCH /users/:id of a staff account is admin only). */
  @Patch('me')
  async updateOwnProfile(
    @Body() data: UpdateOwnProfileDto,
    @Req() request: Request,
  ): Promise<{ id: number; username: string; phone: string | null }> {
    return this.userService.updateOwnProfile(request['user'].sub, data);
  }

  /**
   * «Объединить контакты»: the contact from_id (the same client entered twice) is merged into :id — its
   * deals, history, tasks, e-mails, messenger ids and what :id lacks — and is deleted; the history of :id
   * says so. Needs the right to change :id and to delete from_id.
   */
  @Post(':id/merge')
  @HttpCode(200)
  @RecordAccess('contact', 'update')
  async merge(
    @Param('id', ParseIntPipe) id: number,
    @Body() data: MergeContactsDto,
    @Req() request: Request,
  ): Promise<{ id: number; merged_id: number; deals: number; fields: string[] }> {
    return this.userService.mergeContacts(id, Number(data.from_id), request, new Access(request['user']));
  }

  @Patch(':id')
  @RecordAccess('contact', 'update')
  async update(
    @Body() data: UpdateUserDto,
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<void> {
    return this.userService.updateUser(id, request, data);
  }

  /**
   * successor_id (a staff account, admin): the colleague who takes over the open deals and tasks.
   * Answers how many were moved.
   */
  @Delete(':id')
  @RecordAccess('contact', 'delete')
  async delete(
    @Param('id', ParseIntPipe) id: number,
    @Query('successor_id') successorId: string | undefined,
    @Req() request: Request,
  ): Promise<{ deals: number; tasks: number }> {
    const successor = successorId === undefined || successorId === '' ? undefined : Number(successorId);
    if (successor !== undefined && (!Number.isInteger(successor) || successor < 1)) {
      throw new BadRequestException('successor_id must be a user id');
    }
    return this.userService.deleteUser(id, request['user']?.sub, successor);
  }

  /**
   * Admin and manager see staff accounts in full. An agent sees their own
   * account and customer contacts in full, and of other staff accounts only
   * what the pickers need.
   */
  private hideStaffDetails(
    user: Record<string, any>,
    requester: AuthUser,
  ): Record<string, any> {
    if (
      !user ||
      AuthGuard.MANAGER_LEVEL.includes(requester.role) ||
      user.role === RoleEnum.CTR_AGENT ||
      user.id === requester.sub
    ) {
      return user;
    }

    delete user.permissions;
    delete user.objectives;
    delete user.tg_id;

    return user;
  }
}
