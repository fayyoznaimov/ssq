import { Body, Controller, Delete, ForbiddenException, Get, Param, ParseIntPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuthUser } from '../auth/auth.guard';
import { RoleEnum } from '../user/user.entity';
import { MessengerFilterService } from './messenger-filter.service';
import { MessengerHealthService } from './messenger-health.service';
import { AddIgnoredChatDto, MessengerSettingsDto } from './dto/messenger.dto';

/**
 * The managers' own Telegram and WhatsApp, what both share (a CRM login, rights checked in the services):
 *  - GET /messenger/status: are my Telegram and WhatsApp feeding the CRM right now (the deal composer, the pages);
 *  - «Не клиент»: GET / POST /messenger/ignored, DELETE /messenger/ignored/:id — chats that never become
 *    contacts and deals (per manager);
 *  - GET / PATCH /messenger/settings: «только известные контакты» per manager and messenger.
 */
@Controller('messenger')
export class MessengerController {
  constructor(
    private filter: MessengerFilterService,
    private health: MessengerHealthService,
  ) {}

  @Get('status')
  async status(@Req() request: Request, @Query('user_id') userId?: string) {
    const me = request['user'] as AuthUser;
    const id = Number(userId) || me.sub;
    if (id !== me.sub && me.role !== RoleEnum.ADMIN) throw new ForbiddenException('Состояние чужих мессенджеров видит только администратор');
    return { user_id: id, ...(await this.health.statusOf(id)) };
  }

  @Get('ignored')
  async ignored(@Req() request: Request, @Query('user_id') userId?: string) {
    return this.filter.list(request['user'] as AuthUser, Number(userId) || undefined);
  }

  @Post('ignored')
  async ignore(@Req() request: Request, @Body() body: AddIgnoredChatDto) {
    return this.filter.add(request['user'] as AuthUser, body);
  }

  @Delete('ignored/:id')
  async unignore(@Req() request: Request, @Param('id', ParseIntPipe) id: number) {
    return this.filter.remove(request['user'] as AuthUser, id);
  }

  @Get('settings')
  async settings(@Req() request: Request, @Query('user_id') userId?: string) {
    return this.filter.settings(request['user'] as AuthUser, Number(userId) || undefined);
  }

  @Patch('settings')
  async updateSettings(@Req() request: Request, @Body() body: MessengerSettingsDto) {
    return this.filter.updateSettings(request['user'] as AuthUser, body);
  }
}
