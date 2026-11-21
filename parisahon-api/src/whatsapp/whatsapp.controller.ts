import { Body, Controller, Delete, Get, Post, Query, Req, UploadedFiles } from '@nestjs/common';
import { Request } from 'express';
import { Roles } from '../auth/decorator/roles.decorator';
import { AuthGuard } from '../auth/auth.guard';
import { UploadFiles } from '../file/upload-files.decorator';
import { WhatsAppService } from './whatsapp.service';
import { SendWhatsAppDto } from './dto/send.whatsapp.dto';

/** WhatsApp of the managers: connect by QR, state, disconnect, write from a deal. */
@Controller('whatsapp')
export class WhatsAppController {
  constructor(private whatsapp: WhatsAppService) {}

  @Get('status')
  async status(@Req() request: Request, @Query('user_id') userId?: string) {
    return this.whatsapp.state(request['user'], Number(userId) || undefined);
  }

  @Post('connect')
  async connect(@Req() request: Request, @Body('user_id') userId?: number, @Body('phone') phone?: string) {
    return this.whatsapp.connect(request['user'], Number(userId) || undefined, phone);
  }

  @Delete('session')
  async disconnect(@Req() request: Request, @Query('user_id') userId?: string) {
    return this.whatsapp.disconnect(request['user'], Number(userId) || undefined);
  }

  @Roles(AuthGuard.ADMIN_LEVEL)
  @Get('sessions')
  async sessions() {
    return this.whatsapp.sessions();
  }

  // files of a message WhatsApp did not accept are removed from the disk again
  @Post('send-message')
  @UploadFiles()
  async send(
    @Req() request: Request,
    @Body() data: SendWhatsAppDto,
    @UploadedFiles() files: Array<Express.Multer.File>,
  ) {
    return this.whatsapp.send(request['user'], data, files ?? []);
  }
}
