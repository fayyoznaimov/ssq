import { Controller, Delete, Get, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { BotService } from './bot.service';

/**
 * Linking the signed-in user's Telegram to the CRM bot (profile page).
 *   GET    /bot/link   status: is the bot on, is this user linked
 *   POST   /bot/link   one-time t.me link, valid 15 minutes
 *   DELETE /bot/link   unlink
 * Any staff role (global JWT guard).
 */
@Controller('bot/link')
export class BotLinkController {
  constructor(private bot: BotService) {}

  @Get()
  status(@Req() req: Request) {
    return this.bot.status(req['user'].sub);
  }

  @Post()
  create(@Req() req: Request) {
    return this.bot.createLink(req['user'].sub);
  }

  @Delete()
  async remove(@Req() req: Request) {
    await this.bot.unlink(req['user'].sub);
    return this.bot.status(req['user'].sub);
  }
}
