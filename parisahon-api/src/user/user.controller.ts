import { ClientHistoryService } from '../deal/client-history.service';
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
} from '@nestjs/common';
import { RecordAccess } from '../auth/access';
import { Request } from 'express';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/create.user.dto';
import { AuthGuard, AuthUser } from '../auth/auth.guard';
import { Roles } from '../auth/decorator/roles.decorator';
import { instanceToPlain } from 'class-transformer';
import { ChangeOwnPasswordDto, UpdateUserDto } from './dto/update.user.dto';
import { SearchUserQueryDto } from './dto/search.user.query.dto';
import { PaginationRequestDto } from '../helper/dto/pagination.dto';
import { EventsService } from 'src/events/events.service';
import { SearchEventDto } from 'src/events/dto/search.event.dto';
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

  @Get(':id')
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

  /** Every deal a contact is linked to (tab "Сделки" of the contact card). */
  @Get(':id/deals')
  @RecordAccess('staffData', 'view')
  async fetchUserDeals(@Param('id', ParseIntPipe) id: number) {
    return this.clientHistory.forContact(id);
  }

  @Get(':id/events')
  @RecordAccess('staffData', 'view')
  async fetchUserEvents(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: SearchEventDto,
  ): Promise<Record<string, any>> {
    return instanceToPlain(await this.eventService.fetchUserEvents(id, query));
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
    const response = instanceToPlain(await this.userService.fetchAll(query));

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

  @Patch(':id')
  @RecordAccess('contact', 'update')
  async update(
    @Body() data: UpdateUserDto,
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<void> {
    return this.userService.updateUser(id, request, data);
  }

  @Delete(':id')
  @RecordAccess('contact', 'delete')
  async delete(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: Request,
  ): Promise<void> {
    return this.userService.deleteUser(id, request['user']?.sub);
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
