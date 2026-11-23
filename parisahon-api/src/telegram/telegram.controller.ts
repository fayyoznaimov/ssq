import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Query,
  Req,
  UploadedFiles,
} from '@nestjs/common';
import { Request } from 'express';
import { TelegramService } from './telegram.service';
import { instanceToPlain } from 'class-transformer';
import { SendCodeDto } from './dto/send.code.dto';
import { StartSessionDto } from './dto/start.session.dto';
import { SendMessageDto } from './dto/send.message.dto';
import { UploadFiles } from '../file/upload-files.decorator';

/**
 * Telegram of the managers (their own accounts, through parisahon-telegram-service).
 * Every route needs a CRM login (global guard); who may do what is decided
 * in TelegramService: a manager connects, disconnects and writes only from their own account.
 */
@Controller('telegram')
export class TelegramController {
  constructor(private telegramService: TelegramService) {}

  // the connected accounts, each with `telegram`: the state of its session (works / error / ended in Telegram)
  @Get('/active-sessions')
  async fetchSessions(): Promise<Record<string, any>> {
    return instanceToPlain(await this.telegramService.fetchActiveSessions());
  }

  @Post('/send-code')
  async sendCode(
    @Req() request: Request,
    @Body() data: SendCodeDto,
  ): Promise<Record<string, any>> {
    return this.telegramService.sendCode(request, data);
  }

  @Post('/send-message')
  // files of a message Telegram did not accept are removed from the disk again
  @UploadFiles()
  async sendMessage(
    @Req() request: Request,
    @Body() data: SendMessageDto,
    @UploadedFiles() files: Array<Express.Multer.File>,
  ): Promise<Record<string, any>> {
    return this.telegramService.sendMessage(request, data, files ?? []);
  }

  @Post('/activate-auth')
  async activateAuth(
    @Req() request: Request,
    @Body() data: StartSessionDto,
  ): Promise<Record<string, any>> {
    return this.telegramService.activateAuth(request, data);
  }

  // «Отключить»: own account; an admin: anyone's (also of a deleted user)
  @Delete('/session')
  async disconnect(@Req() request: Request, @Query('user_id') userId?: string): Promise<Record<string, any>> {
    return this.telegramService.disconnect(request, Number(userId) || undefined);
  }
}
