import { Controller, ForbiddenException, Get, Header, HttpCode, Req } from '@nestjs/common';
import { Request } from 'express';
import { Public } from '../auth/decorator/public.decorator';
import { FileLink } from './file-link';

/**
 * GET /files/link-check — nginx asks it (auth_request) before it serves /uploads/<name>: the original
 * address comes in X-Original-URI. No login: only the signature of the link is checked (FileLink).
 * 204 — serve the file; 403 — a link without a valid signature while FILE_LINK_ENFORCE=1.
 */
@Public()
@Controller('files')
export class FileLinkController {
  @Get('link-check')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  check(@Req() request: Request): void {
    const uri = String(request.headers['x-original-uri'] ?? '');
    if (!FileLink.allows(uri)) throw new ForbiddenException('The link to the file is not valid or has expired');
  }
}
