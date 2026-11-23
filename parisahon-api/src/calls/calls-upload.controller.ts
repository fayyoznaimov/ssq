import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UseGuards,
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  Post,
  Req,
  UnauthorizedException,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { Request } from 'express';
import { extname } from 'path';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { Public } from '../auth/decorator/public.decorator';
import { TelegramServiceTokenGuard } from '../telegram/telegram-inbox.controller';
import { FileService } from '../file/file.service';
import { CallsService, UploadMeta } from './calls.service';
import { UploadCallDto } from './dto/calls.dto';
import { parseRecordingName, plausibleCallTime } from './recording-name';

/**
 * POST /calls/upload — the recorder app sends a call: multipart with the audio
 * (`file`: .amr / .mp3 / .m4a) and either the fields duration (ms), number,
 * direction (Incoming / Outgoing) or the recorder's own .json (`meta`:
 * {"duration":"71825","callee":"+998…","direction":"Incoming"}).
 * Who: the manager's recorder token in X-Recorder-Token; or the Telegram
 * service's folder scanner with X-Telegram-Service-Token plus user_id; or the
 * FTP receiver (parisahon-ftp) with X-Calls-Service-Token plus user_id.
 * A recorder that sends nothing but the file (Cube ACR through FTP): the number,
 * the direction and the time of the call are read from the name of the file;
 * so is a call whose .json cannot be read (the recording is never refused for it).
 * Up to CALLS_UPLOAD_MAX_MB (default 200 MB) per file: an hour-long WAV fits.
 * No JWT (@Public): phones have no CRM login.
 *
 * GET /calls/recorder — whose recorder token this is (the FTP receiver checks the
 * password of an FTP login with it).
 */

/**
 * POST /calls/upload: refuses a request without a valid credential BEFORE multer writes the file
 * (up to 50 MB) to disk. Which user the upload belongs to is still decided in the handler.
 */
@Injectable()
export class CallsUploadAuthGuard implements CanActivate {
  constructor(private calls: CallsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req: Request = context.switchToHttp().getRequest();
    const recorder = String(req.headers['x-recorder-token'] ?? '').trim();
    if (recorder && (await this.calls.userOfToken(recorder, false))) return true;
    if (TelegramServiceTokenGuard.tokenMatches(req)) return true;
    if (CallsService.serviceTokenMatches(req.headers['x-calls-service-token'])) return true;
    throw new UnauthorizedException();
  }
}

/** Largest audio file POST /calls/upload takes (CALLS_UPLOAD_MAX_MB, default 200; nginx in front has its own limit). */
export const CALLS_UPLOAD_MAX_BYTES = Math.max(1, Number(process.env.CALLS_UPLOAD_MAX_MB) || 200) * 1024 * 1024;

@Public()
@Controller('calls')
export class CallsUploadController {
  private readonly logger = new Logger(CallsUploadController.name);

  constructor(private calls: CallsService) {}

  @Get('recorder')
  async recorder(@Req() req: Request) {
    const user = await this.calls.userOfToken(String(req.headers['x-recorder-token'] ?? '').trim(), false);
    if (!user) throw new UnauthorizedException();
    return { user_id: user.id, username: user.username };
  }

  @Post('upload')
  @UseGuards(CallsUploadAuthGuard)
  @UseInterceptors(
    FileFieldsInterceptor([{ name: 'file', maxCount: 1 }, { name: 'meta', maxCount: 1 }], {
      storage: diskStorage({
        destination: CallsService.uploadsDir(),
        filename: (_req, file, callback) =>
          callback(null, `call_${randomBytes(8).toString('hex')}${extname(file.originalname || '').toLowerCase().slice(0, 8)}`),
      }),
      // names arrive as UTF-8 bytes read as latin1: "Феруз ↗.amr" must stay readable
      fileFilter: FileService.fixNameEncoding,
      limits: { fileSize: CALLS_UPLOAD_MAX_BYTES },
    }),
  )
  async upload(
    @Req() req: Request,
    @Body() body: UploadCallDto,
    @UploadedFiles() files: { file?: Express.Multer.File[]; meta?: Express.Multer.File[] },
  ) {
    const audio = files?.file?.[0];
    const metaFile = files?.meta?.[0];
    const cleanup = async () => {
      for (const f of [audio, metaFile]) if (f) await fs.unlink(f.path).catch(() => undefined);
    };

    // who is uploading
    const recorderToken = String(req.headers['x-recorder-token'] ?? '').trim();
    let user = recorderToken ? await this.calls.userOfToken(recorderToken) : null;
    let source = 'recorder';
    if (!user && TelegramServiceTokenGuard.tokenMatches(req) && body.user_id) {
      user = await this.calls.staffUser(Number(body.user_id));
      source = 'folder';
    }
    if (!user && CallsService.serviceTokenMatches(req.headers['x-calls-service-token']) && body.user_id) {
      // the receiver itself is known: a folder of a manager who is gone is a bad file, not a bad login
      user = await this.calls.staffUser(Number(body.user_id)).catch(() => null);
      if (!user) {
        await cleanup();
        throw new BadRequestException(`No staff user ${body.user_id}`);
      }
      source = 'ftp';
      await this.calls.touchToken(user.id);
    }
    if (!user) {
      await cleanup();
      throw new UnauthorizedException();
    }
    if (!audio) {
      await cleanup();
      throw new BadRequestException('No audio file: send it as the multipart field "file"');
    }

    // the metadata: fields, or the recorder's json
    let duration: number | null = body.duration ? Number(body.duration) : null;
    let number: string | null = body.number ?? null;
    let direction: string | null = body.direction ?? null;
    if (metaFile) {
      // the .json is optional: one that cannot be read is skipped (the name of the file still tells the call),
      // the recording itself is never refused for it — a refused file is not sent again and would be lost
      try {
        const meta = JSON.parse(await fs.readFile(metaFile.path, 'utf8'));
        if (meta && typeof meta === 'object') {
          if (duration === null && meta.duration !== undefined) duration = Number(meta.duration);
          if (!number && meta.callee) number = String(meta.callee);
          if (!number && meta.number) number = String(meta.number);
          if (!direction && meta.direction) direction = String(meta.direction);
        }
      } catch (error) {
        this.logger.warn(`call upload of user ${user.id} (${audio.originalname}): the meta file is not JSON, ignored: ${(error as Error).message}`);
      }
      await fs.unlink(metaFile.path).catch(() => undefined);
    }
    if (direction && !['incoming', 'outgoing'].includes(direction.toLowerCase())) direction = null;
    // what the request did not say is in the name of the file
    const named = parseRecordingName(audio.originalname);
    // a messenger call: the recorder knows the name from the phone book only ("callee":"Textile Trading")
    let callerName = named.caller_name;
    if (number && CallsService.digits(number).length < 7) {
      callerName = number.trim() || callerName;
      number = null;
    }
    if (!number && named.number) number = named.number;
    if (!direction && named.outgoing !== null) direction = named.outgoing ? 'Outgoing' : 'Incoming';
    const fileTime = body.recorded_at && /^\d{10,16}$/.test(body.recorded_at) ? new Date(Number(body.recorded_at)) : null;
    const meta: UploadMeta = {
      duration: Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : null,
      from_number: number,
      outgoing: String(direction ?? 'Outgoing').toLowerCase() !== 'incoming',
      source,
      recorded_at: named.recorded_at ?? plausibleCallTime(fileTime),
      caller_name: number ? null : callerName,
    };
    const upload = await this.calls.enqueue(user, audio, meta);
    if (!upload.duplicate) this.calls.processSoon();
    return { id: upload.id, status: upload.status, user_id: user.id, ...(upload.duplicate ? { duplicate: true } : {}) };
  }
}
