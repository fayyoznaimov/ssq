import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Injectable,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { timingSafeEqual } from 'crypto';
import { Public } from '../auth/decorator/public.decorator';
import { WhatsAppInboxService } from './whatsapp-inbox.service';
import { IncomingWhatsAppDto } from './dto/incoming.whatsapp.dto';

/** The shared secret of parisahon-whatsapp-service: WHATSAPP_SERVICE_TOKEN in X-WhatsApp-Service-Token. */
@Injectable()
export class WhatsAppServiceTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const expected = (process.env.WHATSAPP_SERVICE_TOKEN ?? '').trim();
    const given = String(req.headers['x-whatsapp-service-token'] ?? '').trim();
    if (expected.length < 16 || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
      throw new UnauthorizedException();
    }
    return true;
  }
}

/** Entry point for parisahon-whatsapp-service, not for people (@Public + the service token). */
@Public()
@UseGuards(WhatsAppServiceTokenGuard)
@Controller('whatsapp/incoming')
export class WhatsAppInboxController {
  constructor(private inbox: WhatsAppInboxService) {}

  @Post()
  async receive(@Body() data: IncomingWhatsAppDto) {
    return this.inbox.receive(data);
  }
}
