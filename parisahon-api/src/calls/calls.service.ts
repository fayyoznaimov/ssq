import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { execFile } from 'child_process';
import { createReadStream, promises as fs } from 'fs';
import { extname, join } from 'path';
import { RecorderToken } from './recorder-token.entity';
import { CallUpload, CallUploadStatus } from './call-upload.entity';
import { Recording } from '../analytics/recordings.entity';
import { RoleEnum, User } from '../user/user.entity';
import { Deal } from '../deal/deal.entity';
import { EventTypes } from '../events/event.entity';
import { CallRecordingEventDto } from '../events/dto/call.recording.event.dto';
import { RecordingsQueryDto, QueueQueryDto } from './dto/calls.dto';
import { CallClientService } from './call-client.service';

const STAFF = [RoleEnum.ADMIN, RoleEnum.MANAGER, RoleEnum.AGENT];
const AUDIO_EXTENSIONS = ['.amr', '.mp3', '.m4a', '.wav', '.ogg', '.aac', '.3gp'];

export interface UploadMeta {
  duration?: number | null;
  from_number?: string | null;
  outgoing: boolean;
  source: string;
  recorded_at?: Date | null;
  caller_name?: string | null;
}

/**
 * Call recordings through the API.
 *
 * The recorder app on a manager's phone (or the folder scanner of the Telegram
 * service, or the FTP receiver parisahon-ftp a phone syncs its recordings folder
 * to) sends every call to POST /calls/upload with the manager's recorder
 * token. What the request does not say (number, direction, time) is read from
 * the name of the file (recording-name.ts); the same file is queued once. The file lands in the queue (`call_upload`); the processor converts it
 * to mp3 with ffmpeg, writes the `recording` row the analytics read, links the
 * call to the open deals of the client with that number (NEW_CALL_RECORDING
 * events in their history) and records the outcome per file: a broken file is
 * `failed` with its error, the next one is processed. Before, the Telegram
 * service wrote all of this straight into Postgres and one bad file stopped
 * the whole pass for ever.
 */
@Injectable()
export class CallsService {
  private readonly logger = new Logger(CallsService.name);
  private processing = false;
  // a file arrived while the processor was busy: one more pass right after this one
  private again = false;

  constructor(
    @InjectRepository(RecorderToken) private tokenRepository: Repository<RecorderToken>,
    @InjectRepository(CallUpload) private uploadRepository: Repository<CallUpload>,
    @InjectRepository(Recording) private recordingRepository: Repository<Recording>,
    @InjectRepository(User) private userRepository: Repository<User>,
    @InjectRepository(Deal) private dealRepository: Repository<Deal>,
    private dataSource: DataSource,
    private eventEmitter: EventEmitter2,
    private callClients: CallClientService,
  ) {}

  static uploadsDir(): string {
    return join(__dirname, '..', '..', 'public', 'uploads');
  }

  static ffmpegBin(): string {
    return (process.env.FFMPEG_BIN || 'ffmpeg').trim();
  }

  static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  static digits(phone?: string | null): string {
    return String(phone ?? '').replace(/[^\d]/g, '');
  }

  /** The shared secret of the FTP receiver (X-Calls-Service-Token): it uploads for the manager who logged in to it. */
  static serviceTokenMatches(value: unknown): boolean {
    const expected = (process.env.CALLS_SERVICE_TOKEN || '').trim();
    const given = String(value ?? '').trim();
    if (expected.length < 16 || given.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  }

  /** Where a phone sends its recordings by FTP ("host:port"), for the settings page; null — no FTP receiver. */
  static ftpAddress(): string | null {
    return (process.env.CALLS_FTP_ADDRESS || '').trim() || null;
  }

  private static sha256OfFile(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      createReadStream(path)
        .on('data', (chunk) => hash.update(chunk))
        .on('error', reject)
        .on('end', () => resolve(hash.digest('hex')));
    });
  }

  // ------------------------------------------------------------------ tokens

  /** Every staff user with the state of their recorder token. */
  async listTokens(): Promise<any[]> {
    const users = await this.userRepository.find({
      where: { role: In(STAFF) },
      order: { username: 'ASC' },
    });
    // `revoked_at: null` would be no condition at all in TypeORM: IsNull() it is
    const tokens = await this.tokenRepository.find({
      where: { revoked_at: IsNull() },
      relations: { user: true },
    });
    const byUser = new Map(tokens.map((t) => [t.user.id, t]));
    return users.map((u) => {
      const t = byUser.get(u.id);
      return {
        user_id: u.id,
        username: u.username,
        role: u.role,
        has_token: !!t,
        issued_at: t?.created_at ?? null,
        last_upload_at: t?.last_upload_at ?? null,
      };
    });
  }

  /** A new token for the user (the old one is revoked); the value is returned once. */
  async issueToken(userId: number, admin: User): Promise<{ user_id: number; token: string }> {
    const user = await this.userRepository.findOne({ where: { id: userId, role: In(STAFF) } });
    if (!user) throw new NotFoundException(`Staff user ${userId} does not exist`);
    await this.revokeToken(userId);
    const token = 'rec_' + randomBytes(24).toString('hex');
    const row = new RecorderToken();
    row.user = user;
    row.token_hash = CallsService.hash(token);
    row.created_by = admin;
    await this.tokenRepository.save(row);
    return { user_id: userId, token };
  }

  async revokeToken(userId: number): Promise<{ revoked: number }> {
    const result = await this.tokenRepository
      .createQueryBuilder()
      .update(RecorderToken)
      .set({ revoked_at: new Date() })
      .where('user_id = :userId AND revoked_at IS NULL', { userId })
      .execute();
    return { revoked: result.affected ?? 0 };
  }

  /** The manager behind a recorder token, or null. */
  async userOfToken(token: string | undefined, uploading = true): Promise<User | null> {
    if (!token || token.length < 16) return null;
    const row = await this.tokenRepository.findOne({
      where: { token_hash: CallsService.hash(token), revoked_at: IsNull() },
      relations: { user: true },
    });
    if (!row || !row.user || row.user.deleted_at) return null;
    if (uploading) await this.touchToken(row.user.id);
    return row.user;
  }

  /** "Last upload" of the manager's token, shown on the settings page. */
  async touchToken(userId: number): Promise<void> {
    await this.tokenRepository
      .createQueryBuilder()
      .update(RecorderToken)
      .set({ last_upload_at: new Date() })
      .where('user_id = :userId AND revoked_at IS NULL', { userId })
      .execute();
  }

  // ------------------------------------------------------------------ queue

  async enqueue(user: User, file: Express.Multer.File, meta: UploadMeta): Promise<CallUpload & { duplicate?: boolean }> {
    const ext = extname(file.originalname || file.filename || '').toLowerCase();
    if (!AUDIO_EXTENSIONS.includes(ext)) {
      await fs.unlink(file.path).catch(() => undefined);
      throw new BadRequestException(`Unsupported audio file "${ext || file.originalname}": expected ${AUDIO_EXTENSIONS.join(', ')}`);
    }
    // the same file of the same manager again (a sync app after a reinstall): the first one stays
    const fileHash = await CallsService.sha256OfFile(file.path);
    const same = await this.uploadRepository
      .createQueryBuilder('u')
      .where('u.user_id = :user AND u.file_hash = :hash AND u.status <> :discarded', {
        user: user.id,
        hash: fileHash,
        discarded: CallUploadStatus.DISCARDED,
      })
      .orderBy('u.id', 'ASC')
      .getOne();
    if (same) {
      await fs.unlink(file.path).catch(() => undefined);
      return Object.assign(same, { duplicate: true });
    }
    const upload = new CallUpload();
    upload.user = user;
    upload.file_hash = fileHash;
    upload.recorded_at = meta.recorded_at ?? null;
    upload.caller_name = meta.caller_name ? meta.caller_name.slice(0, 255) : null;
    upload.file_name = (file.originalname || file.filename).slice(0, 255);
    upload.raw_path = file.filename;
    upload.duration = meta.duration ?? null;
    upload.from_number = meta.from_number ? meta.from_number.slice(0, 64) : null;
    upload.outgoing = meta.outgoing;
    upload.source = meta.source;
    upload.status = CallUploadStatus.PENDING;
    return this.uploadRepository.save(upload);
  }

  async queue(query: QueueQueryDto): Promise<any[]> {
    const qb = this.uploadRepository
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.user', 'user')
      .leftJoinAndSelect('u.recording', 'recording')
      .orderBy('u.received_at', 'DESC')
      .take(500);
    const status = query.status ?? 'all';
    if (status !== 'all') qb.andWhere('u.status = :status', { status });
    if (query.user_id) qb.andWhere('u.user_id = :user', { user: query.user_id });
    const rows = await qb.getMany();
    return rows.map((u) => ({
      id: u.id,
      user: u.user ? { id: u.user.id, username: u.user.username } : null,
      file_name: u.file_name,
      duration: u.duration === null ? null : Number(u.duration),
      from_number: u.from_number,
      caller_name: u.caller_name,
      recorded_at: u.recorded_at,
      outgoing: u.outgoing,
      source: u.source,
      status: u.status,
      error: u.error,
      recording_id: u.recording?.id ?? null,
      received_at: u.received_at,
      processed_at: u.processed_at,
    }));
  }

  async retry(id: number): Promise<CallUpload> {
    const upload = await this.uploadRepository.findOne({ where: { id } });
    if (!upload) throw new NotFoundException(`Upload ${id} does not exist`);
    if (upload.status === CallUploadStatus.DONE) throw new BadRequestException('This file is already processed');
    const raw = join(CallsService.uploadsDir(), upload.raw_path);
    try {
      await fs.access(raw);
    } catch {
      throw new BadRequestException('The received file is gone: upload it again');
    }
    upload.status = CallUploadStatus.PENDING;
    upload.error = null;
    upload.processed_at = null;
    return this.uploadRepository.save(upload);
  }

  async discard(id: number): Promise<{ discarded: boolean }> {
    const upload = await this.uploadRepository.findOne({ where: { id } });
    if (!upload) throw new NotFoundException(`Upload ${id} does not exist`);
    if (upload.status === CallUploadStatus.DONE) throw new BadRequestException('A processed file cannot be discarded');
    await fs.unlink(join(CallsService.uploadsDir(), upload.raw_path)).catch(() => undefined);
    upload.status = CallUploadStatus.DISCARDED;
    upload.processed_at = new Date();
    await this.uploadRepository.save(upload);
    return { discarded: true };
  }

  // ------------------------------------------------------------------ processing

  /** Right after an upload, without waiting for the scheduler: a call is in its deal seconds after it ends. */
  processSoon(): void {
    if (this.processing) {
      this.again = true;
      return;
    }
    setImmediate(() => {
      this.processPending().catch((error) => this.logger.warn(`processing after an upload: ${(error as Error).message}`));
    });
  }

  /** Converts and links every pending file; one broken file fails alone. */
  async processPending(limit = 50): Promise<{ done: number; failed: number }> {
    if (this.processing) return { done: 0, failed: 0 };
    this.processing = true;
    const outcome = { done: 0, failed: 0 };
    try {
      const pending = await this.uploadRepository.find({
        where: { status: CallUploadStatus.PENDING },
        relations: { user: true },
        order: { received_at: 'ASC' },
        take: limit,
      });
      for (const upload of pending) {
        try {
          const recording = await this.processOne(upload);
          upload.recording = recording;
          upload.status = CallUploadStatus.DONE;
          upload.error = null;
          outcome.done++;
        } catch (error) {
          upload.status = CallUploadStatus.FAILED;
          upload.error = String((error as Error).message ?? error).slice(0, 2000);
          outcome.failed++;
          this.logger.warn(`call upload ${upload.id} (${upload.file_name}) failed: ${upload.error}`);
        }
        upload.processed_at = new Date();
        await this.uploadRepository.save(upload);
      }
    } finally {
      this.processing = false;
      if (this.again) {
        this.again = false;
        this.processSoon();
      }
    }
    return outcome;
  }

  private async processOne(upload: CallUpload): Promise<Recording> {
    const dir = CallsService.uploadsDir();
    const raw = join(dir, upload.raw_path);
    await fs.access(raw).catch(() => {
      throw new Error('the received file is missing on disk');
    });
    const target = `recording_${randomBytes(8).toString('hex')}.mp3`;
    await this.toMp3(raw, join(dir, target));

    const duration = upload.duration ?? (await this.probeDurationMs(join(dir, target)));

    const contacts = await this.contactsOf(upload);
    const recording = new Recording();
    recording.duration = duration ?? 0;
    recording.user = upload.user;
    recording.outgoing = upload.outgoing;
    recording.path = target;
    // no number in the file (a messenger call): the number of the client found by name, else the name
    recording.from_number = upload.from_number ?? contacts[0]?.phone ?? upload.caller_name ?? null;
    // a call synced later keeps its own time in the lists and the analytics
    if (upload.recorded_at) recording.created_at = upload.recorded_at;
    const saved = await this.recordingRepository.save(recording);

    await this.linkToDeals(saved, upload, contacts);
    await fs.unlink(raw).catch(() => undefined);
    return saved;
  }

  private toMp3(input: string, output: string): Promise<void> {
    const bin = CallsService.ffmpegBin();
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        ['-y', '-nostdin', '-loglevel', 'error', '-i', input, '-vn', '-acodec', 'libmp3lame', '-q:a', '5', output],
        { timeout: 120_000 },
        (error, _stdout, stderr) => {
          if (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT') {
              return reject(new Error(`ffmpeg is not available (FFMPEG_BIN=${bin})`));
            }
            return reject(new Error(`ffmpeg: ${(stderr || error.message).trim().split('\n').pop()}`));
          }
          resolve();
        },
      );
    });
  }

  private probeDurationMs(file: string): Promise<number | null> {
    const bin = CallsService.ffmpegBin().replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
    return new Promise((resolve) => {
      execFile(bin, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 30_000 }, (error, stdout) => {
        if (error) return resolve(null);
        const seconds = Number(String(stdout).trim());
        resolve(Number.isFinite(seconds) ? Math.round(seconds * 1000) : null);
      });
    });
  }

  /** The client of the call: by the number, or — a messenger call — by the name (CallClientService). */
  private async contactsOf(upload: CallUpload): Promise<User[]> {
    const found = await this.callClients.find({
      managerId: upload.user.id,
      number: upload.from_number,
      name: upload.caller_name,
      fileName: upload.file_name,
    });
    return found.contacts;
  }

  /** A NEW_CALL_RECORDING event in every open deal of the client of the call. */
  private async linkToDeals(recording: Recording, upload: CallUpload, contacts: User[]): Promise<number> {
    if (contacts.length === 0) return 0;

    const deals = await this.dealRepository
      .createQueryBuilder('d')
      .innerJoin('d.ctr_agents', 'c', 'c.id IN (:...contacts)', { contacts: contacts.map((c) => c.id) })
      .leftJoinAndSelect('d.ctr_agents', 'agents')
      .where('d.closed_at IS NULL')
      .andWhere('d.deleted_at IS NULL')
      .getMany();
    // the manager's own deals first; a client without a deal of this manager still links to their open deals
    const ordered = deals.sort((a, b) => Number(b.agent?.id === upload.user.id) - Number(a.agent?.id === upload.user.id));

    for (const deal of ordered) {
      const contact = deal.ctr_agents?.find((c) => contacts.some((x) => x.id === c.id)) ?? contacts[0];
      const eventData: CallRecordingEventDto = {
        recording,
        deal,
        originated_by: contact,
        target_user: upload.user,
      };
      this.eventEmitter.emit(EventTypes.NEW_CALL_RECORDING.toString(), eventData);
    }
    return ordered.length;
  }

  // ------------------------------------------------------------------ recordings

  async recordings(query: RecordingsQueryDto): Promise<{ data: any[]; count: number; page: number; limit: number }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const qb = this.recordingRepository
      .createQueryBuilder('r')
      .leftJoinAndSelect('r.user', 'user')
      .orderBy('r.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    if (query.user_id) qb.andWhere('r.user_id = :user', { user: query.user_id });
    if (query.from) qb.andWhere('r.created_at >= :from', { from: query.from });
    if (query.till) qb.andWhere("r.created_at < (CAST(:till AS date) + interval '1 day')", { till: query.till });
    if (query.number) {
      const digits = CallsService.digits(query.number);
      if (digits) qb.andWhere("regexp_replace(COALESCE(r.from_number, ''), '[^0-9]', '', 'g') LIKE :num", { num: '%' + digits + '%' });
    }
    const [rows, count] = await qb.getManyAndCount();
    const paths = rows.map((r) => r.path).filter(Boolean);
    const links: { path: string; deal_id: number; label: string }[] = paths.length
      ? await this.dataSource.query(
          `SELECT DISTINCT ON (e.after_state->>'path') e.after_state->>'path' AS path, d.id AS deal_id, d.label
             FROM event e JOIN deal d ON d.id = e.deal_id
            WHERE e.type = $1 AND e.after_state->>'path' = ANY($2)
            ORDER BY e.after_state->>'path', e.id DESC`,
          [EventTypes.NEW_CALL_RECORDING, paths],
        )
      : [];
    const dealOf = new Map(links.map((l) => [l.path, l]));
    return {
      data: rows.map((r) => ({
        id: r.id,
        user: r.user ? { id: r.user.id, username: r.user.username } : null,
        duration: Number(r.duration),
        outgoing: r.outgoing,
        path: r.path,
        from_number: r.from_number,
        created_at: r.created_at,
        deal: dealOf.get(r.path) ? { id: dealOf.get(r.path).deal_id, label: dealOf.get(r.path).label } : null,
      })),
      count,
      page,
      limit,
    };
  }

  /** For the upload guard: the user given by the Telegram service's folder scanner. */
  async staffUser(id: number): Promise<User> {
    const user = await this.userRepository.findOne({ where: { id, role: In(STAFF) } });
    if (!user) throw new UnauthorizedException();
    return user;
  }
}
