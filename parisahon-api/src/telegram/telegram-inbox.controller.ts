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
import { TelegramInboxService } from './telegram-inbox.service';
import { IncomingMessageDto } from './dto/incoming.message.dto';

/**
 * The shared secret of parisahon-telegram-service: TELEGRAM_SERVICE_TOKEN in
 * the header X-Telegram-Service-Token (or Authorization: Bearer). A guard, so
 * that it is checked before the body is validated. Without the variable (or
 * with a short one) the endpoint is closed.
 */
@Injectable()
export class TelegramServiceTokenGuard implements CanActivate {
  static tokenMatches(req: Request): boolean {
    const expected = (process.env.TELEGRAM_SERVICE_TOKEN ?? '').trim();
    if (expected.length < 16) return false;
    const header = String(req.headers['x-telegram-service-token'] ?? '').trim();
    const auth = String(req.headers.authorization ?? '');
    const given = header || (auth.startsWith('Bearer ') ? auth.slice(7).trim() : '');
    if (!given || given.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!TelegramServiceTokenGuard.tokenMatches(req)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}

/**
 * Entry point for parisahon-telegram-service, not for people: the JWT guard
 * is skipped (@Public) and TelegramServiceTokenGuard asks for the shared secret.
 */
@Public()
@UseGuards(TelegramServiceTokenGuard)
@Controller('telegram/incoming')
export class TelegramInboxController {
  constructor(private inbox: TelegramInboxService) {}

  @Post()
  async receive(@Body() data: IncomingMessageDto) {
    return this.inbox.receive(data);
  }
}
