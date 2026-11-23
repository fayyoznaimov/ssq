import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface';
import { InjectRepository } from '@nestjs/typeorm';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import { diskStorage, memoryStorage } from 'multer';
import { basename, extname, join } from 'path';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { AuthUser } from '../auth/auth.guard';
import { Access } from '../auth/access';
import { Deal } from '../deal/deal.entity';
import { Event, EventTypes } from '../events/event.entity';
import {
  PaginationRequestDto,
  PaginationResponseDto,
} from '../helper/dto/pagination.dto';
import { HelperService } from '../helper/helper.service';
import { WhichFiles } from '../trigger/dto/assign.trigger.dto';
import { User } from '../user/user.entity';
import { SearchFileDto } from './dto/search.file.dto';
import { File } from './file.entity';

/**
 * Extensions a browser opens as a page, with scripts running in the CRM origin
 * (the token is in localStorage). Such uploads are stored on disk as ".bin" and
 * are served as a download; the row keeps the original name and extension.
 */
const ACTIVE_EXTENSIONS = new Set(
  '.html .htm .xhtml .xht .shtml .svg .svgz .xml .xsl .xslt .js .mjs'.split(
    ' ',
  ),
);

@Injectable()
export class FileService {
  /** Served at /uploads and /api/v1/uploads (main.ts); in production nginx serves /api/v1/uploads. */
  static readonly UPLOADS_DIR = join(__dirname, '../../public/uploads');
  /**
   * Per file (was 2 MB: a phone photo did not fit). nginx in front of the API
   * takes 10 MB per request (client_max_body_size): raise both together.
   */
  static readonly MAX_FILE_SIZE = 10 * 1024 * 1024;
  static readonly MAX_FILES = 10;

  private readonly logger = new Logger(FileService.name);

  constructor(
    @InjectRepository(File)
    private fileRepository: Repository<File>,
    @InjectRepository(Event)
    private eventRepository: Repository<Event>,
    private helperService: HelperService,
  ) {}

  // ------------------------------------------------------------ multer

  /** Deals (files tab, comments, messages) and Telegram: files go straight to UPLOADS_DIR */
  static getUploadOptions(): MulterOptions {
    return {
      storage: diskStorage({
        destination: FileService.UPLOADS_DIR,
        filename: (_req, file, callback) =>
          callback(
            null,
            FileService.generateFileNameFromOriginalFileName(file.originalname),
          ),
      }),
      fileFilter: FileService.fixNameEncoding,
      limits: {
        fileSize: FileService.MAX_FILE_SIZE,
        files: FileService.MAX_FILES,
      },
    };
  }

  /** Outgoing email attachments: kept in memory, the email service writes them itself */
  static getMemoryUploadOptions(): MulterOptions {
    return {
      storage: memoryStorage(),
      fileFilter: FileService.fixNameEncoding,
      limits: {
        fileSize: FileService.MAX_FILE_SIZE,
        files: FileService.MAX_FILES,
      },
    };
  }

  /**
   * Browsers send the file name as UTF-8 bytes and multer (busboy) reads them
   * as latin1: "Договор.pdf" was saved as "Ð”Ð¾Ð³Ð¾Ð²Ð¾Ñ€.pdf".
   */
  static fixNameEncoding(
    _req: unknown,
    file: { originalname: string },
    callback: (error: Error | null, acceptFile: boolean) => void,
  ): void {
    const name = file.originalname ?? '';
    if (!/[^\u0000-\u00ff]/.test(name)) {
      const decoded = Buffer.from(name, 'latin1').toString('utf8');
      if (!decoded.includes('\uFFFD')) file.originalname = decoded;
    }
    callback(null, true);
  }

  /** Random name on disk (64 hex chars) with a harmless extension */
  static generateFileNameFromOriginalFileName(originalName: string): string {
    const extension = File.extensionOf(originalName) ?? '';
    const onDisk = ACTIVE_EXTENSIONS.has(extension) ? '.bin' : extension;
    return randomBytes(32).toString('hex') + onDisk;
  }

  static generateFileName(file: Express.Multer.File): string {
    return FileService.generateFileNameFromOriginalFileName(file.originalname);
  }

  /** main.ts: a page-like file uploaded before the ".bin" rule must not run scripts */
  static isActiveContent(path: string): boolean {
    return ACTIVE_EXTENSIONS.has(extname(path).toLowerCase());
  }

  // ------------------------------------------------------------ lists

  /**
   * «Списки → Файлы». Admin and manager: every file. Anybody else (`user` given, an agent with the
   * "files" switch, FileAccessGuard): the files of the deals they may see (deal "view" rights: own,
   * group, all) and the files they uploaded themselves; attachments of e-mails only with the "mail"
   * switch, and then those of their own mailboxes (as the mail list shows them) or of those deals.
   * The deals of a row are the ones the user may see, with their id and label only. Before, an agent
   * got every file of every deal and every attachment, whatever their rights.
   */
  async fetchFiles(
    query: SearchFileDto,
    user?: AuthUser,
  ): Promise<PaginationResponseDto<File[]>> {
    const access = user ? new Access(user) : null;
    const limited = !!access && !access.isManager;
    // light relations: the list shows the deals and the uploader's name; the
    // email (body, subject) stays behind the mail switch, the uploader's account
    // (permissions, phone) behind GET /users
    const qb = this.fileRepository.createQueryBuilder('t0');
    if (limited) {
      const deals = access.dealSql('deal');
      qb.leftJoin('t0.deals', 'deal', `deal.deleted_at IS NULL AND ${deals.sql}`, deals.params).addSelect(['deal.id', 'deal.label']);
    } else {
      qb.leftJoinAndSelect('t0.deals', 'deal');
    }
    qb.leftJoin('t0.uploaded_by', 'uploader')
      .addSelect(['uploader.id', 'uploader.username'])
      .leftJoin('t0.email', 'email')
      .addSelect(['email.id'])
      .orderBy('t0.id', 'DESC');
    if (limited) {
      await this.limitToUser(qb, access);
    }

    if (query.from_bytes) {
      qb.andWhere('t0.size >= :from_bytes', { from_bytes: query.from_bytes });
    }
    if (query.till_bytes) {
      qb.andWhere('t0.size <= :till_bytes', { till_bytes: query.till_bytes });
    }
    if (query.name) {
      qb.andWhere('t0.name ILIKE :name', { name: `%${query.name}%` });
    }
    if (query.created_at_from) {
      qb.andWhere('t0.created_at > :created_at_from', {
        created_at_from: query.created_at_from,
      });
    }
    if (query.created_at_till) {
      qb.andWhere('t0.created_at < :created_at_till', {
        created_at_till: query.created_at_till,
      });
    }
    if (query.uploaded_by) {
      qb.andWhere('t0.uploaded_by = :uploaded_by', {
        uploaded_by: query.uploaded_by,
      });
    }
    if (query.uploaded_from) {
      qb.andWhere('t0.from = :from', { from: query.uploaded_from });
    }
    // ".PNG", "png", "jpg pdf" -> .png .jpg .pdf (rows store ".png"; older ones ".PNG")
    const extensions = (query.with_extensions ?? [])
      .flatMap((value) =>
        String(value)
          .toLowerCase()
          .split(/[\s,]+/),
      )
      .filter(Boolean)
      .map((value) => (value.startsWith('.') ? value : '.' + value));
    if (extensions.length > 0) {
      qb.andWhere('LOWER(t0.extension) IN (:...extensions)', { extensions });
    }

    return this.helperService.withPagination(qb, query);
  }

  /** fetchFiles for a user who does not see everything: see there. */
  private async limitToUser(qb: SelectQueryBuilder<File>, access: Access): Promise<void> {
    const visible = access.dealSql('vd');
    const inVisibleDeal = `EXISTS (SELECT 1 FROM deal_file vdf JOIN deal vd ON vd.id = vdf."dealId"
      WHERE vdf."fileId" = t0.id AND vd.deleted_at IS NULL AND ${visible.sql})`;
    const params: Record<string, any> = { ...visible.params, files_me: access.id };
    const allowed = [`(t0.email_id IS NULL AND (${inVisibleDeal} OR t0.uploaded_by = :files_me))`];
    if (access.canReadMail) {
      const own = await this.ownAddresses(access.id);
      allowed.push(`(t0.email_id IS NOT NULL AND (${inVisibleDeal} OR EXISTS (
        SELECT 1 FROM email fe WHERE fe.id = t0.email_id AND (
          fe.sent_by_id = :files_me
          OR LOWER(fe."from") IN (:...files_own)
          OR EXISTS (SELECT 1 FROM email_to fet WHERE fet.email_id = fe.id AND fet.value ~* :files_own_re)
          OR EXISTS (SELECT 1 FROM email_cc fec WHERE fec.email_id = fe.id AND fec.value ~* :files_own_re)))))`);
      // IN () is a syntax error; the pattern of no address never matches
      params.files_own = own.length ? own : [''];
      params.files_own_re = FileService.addressPattern(own);
    }
    qb.andWhere(`(${allowed.join(' OR ')})`, params);
  }

  /** Lower-cased addresses of a staff member: their own and their checked sender accounts (as the mail list counts them). */
  private async ownAddresses(userId: number): Promise<string[]> {
    const rows: { address: string }[] = await this.fileRepository.query(
      `SELECT lower(u.email) AS address FROM "user" u WHERE u.id = $1 AND COALESCE(u.email, '') <> ''
       UNION
       SELECT lower(t.email) FROM email_transporter t
        WHERE t.user_id = $1 AND COALESCE(t.email, '') <> '' AND t.verified_at IS NOT NULL`,
      [userId],
    );
    return rows.map((row) => row.address).filter(Boolean);
  }

  /** A regex finding one of the addresses in a To / Cc header as stored ("Name" <a@b>, c@d), not xa@b for a@b. */
  static addressPattern(addresses: string[]): string {
    const escaped = addresses.map((address) => address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (escaped.length === 0) return '(?!x)x';
    return `(^|[^A-Za-z0-9._%+-])(${escaped.join('|')})($|[^A-Za-z0-9._-])`;
  }

  /** Files tab of a deal (oldest first, new uploads are appended) */
  async fetchSavedFiles(
    deal_id: number,
    query: PaginationRequestDto,
  ): Promise<PaginationResponseDto<File[]>> {
    return this.helperService.withPagination(this.dealFiles(deal_id), query);
  }

  async fetchSingleSavedFile(deal_id: number, file_id: number): Promise<File> {
    const file = await this.dealFiles(deal_id)
      .andWhere('t0.id = :file_id', { file_id })
      .getOne();
    if (!file) {
      throw new NotFoundException(
        `File ${file_id} is not attached to deal ${deal_id}`,
      );
    }
    return file;
  }

  private dealFiles(deal_id: number): SelectQueryBuilder<File> {
    return this.fileRepository
      .createQueryBuilder('t0')
      .innerJoin('t0.deals', 'deal', 'deal.id = :deal_id', { deal_id })
      .leftJoin('t0.uploaded_by', 'uploader')
      .addSelect(['uploader.id', 'uploader.username'])
      .orderBy('t0.id', 'ASC');
  }

  // ------------------------------------------------------------ upload

  /**
   * Rows for the files multer has just written, linked to the deal.
   * 404 for a missing or deleted deal (also without files: a comment to it);
   * DiscardFailedUploadsInterceptor then removes the written files.
   */
  async attachUploads(
    deal_id: number,
    uploads: Express.Multer.File[] | undefined,
    from: WhichFiles,
    user: AuthUser,
  ): Promise<File[]> {
    await this.helperService.getById(Deal, deal_id);

    if (!uploads?.length) {
      return [];
    }

    const uploader = { id: user.sub, username: user.username } as User;
    const saved = await this.fileRepository.save(
      uploads.map((upload) =>
        this.fileRepository.create({
          name: upload.originalname,
          path: upload.filename,
          size: upload.size,
          from,
          uploaded_by: uploader,
          deals: [{ id: deal_id } as Deal],
        }),
      ),
    );

    // what the files tab and the comment history show: no deal list
    for (const file of saved) {
      file.deals = undefined;
      file.uploaded_by = uploader;
    }
    return saved;
  }

  /** After a failed upload request: files on disk that no row took */
  async discardUploads(
    uploads: Express.Multer.File[] | undefined,
  ): Promise<void> {
    for (const upload of Array.isArray(uploads) ? uploads : []) {
      if (!upload?.filename) continue; // memory storage: nothing on disk
      const rows = await this.fileRepository.count({
        where: { path: upload.filename },
      });
      if (rows === 0) await this.unlink(upload.filename);
    }
  }

  // ------------------------------------------------------------ delete

  async deleteUploadedFile(deal_id: number, file_id: number): Promise<void> {
    const file = await this.helperService.getById(File, file_id, ['deals']);
    await this.deleteFileFromEntity(file, deal_id);
  }

  /**
   * Takes the file off the deal and out of that deal's history (comments,
   * messages, emails). The row and the file on disk go only when nothing refers
   * to the file any more. `file.deals` must be loaded (trigger "delete files").
   */
  async deleteFileFromEntity(file: File, deal_id: number): Promise<void> {
    if (!(file.deals ?? []).some((deal) => deal.id === deal_id)) {
      throw new BadRequestException(
        `File: ${file.id} does not belong to deal: ${deal_id}!`,
      );
    }

    await this.fileRepository
      .createQueryBuilder()
      .relation(File, 'deals')
      .of(file.id)
      .remove(deal_id);
    file.deals = file.deals.filter((deal) => deal.id !== deal_id);
    await this.removeFromHistory(deal_id, file.id);
    await this.removeIfUnused(file);
  }

  private async removeFromHistory(
    deal_id: number,
    file_id: number,
  ): Promise<void> {
    const events = await this.eventRepository
      .createQueryBuilder('e')
      .where('e.deal_id = :deal_id', { deal_id })
      .andWhere(
        `e.after_state -> 'data' -> 'files' @> CAST(:needle AS jsonb)`,
        {
          needle: JSON.stringify([{ id: file_id }]),
        },
      )
      .getMany();

    // the entry says a file was taken off (name and when), the history is not silently rewritten (AUDIT-12)
    const removedAt = new Date().toISOString();
    for (const event of events) {
      const files: { id?: number; name?: string }[] = event.after_state.data.files;
      const removed = files.filter((file) => file?.id === file_id);
      event.after_state.data.files = files.filter((file) => file?.id !== file_id);
      event.after_state.data.removed_files = [
        ...(Array.isArray(event.after_state.data.removed_files) ? event.after_state.data.removed_files : []),
        ...removed.map((file) => ({ id: file_id, name: file?.name ?? null, removed_at: removedAt })),
      ];
    }
    await this.eventRepository.save(events);
  }

  /**
   * Still referenced: another deal (a deleted one too: it can be restored) or
   * an email. Otherwise the row goes, and the file on disk unless another row
   * or a Telegram / WhatsApp message (its history links the file by path) still uses it.
   */
  private async removeIfUnused(file: File): Promise<void> {
    const [row] = await this.fileRepository.query(
      `SELECT EXISTS (SELECT 1 FROM deal_file WHERE "fileId" = $1) AS linked,
              EXISTS (SELECT 1 FROM file WHERE id = $1 AND email_id IS NOT NULL) AS emailed`,
      [file.id],
    );
    if (row.linked || row.emailed) {
      return;
    }

    await this.fileRepository.delete(file.id);

    const [disk] = await this.fileRepository.query(
      `SELECT EXISTS (SELECT 1 FROM file WHERE path = $1) AS in_rows,
              EXISTS (SELECT 1 FROM event WHERE type = ANY($2::int[])
                      AND after_state -> 'files' @> jsonb_build_array(jsonb_build_object('path', $1::text))) AS telegram`,
      [file.path, [EventTypes.NEW_TELEGRAM_MESSAGE, EventTypes.NEW_WHATSAPP_MESSAGE]],
    );
    if (!disk.in_rows && !disk.telegram) {
      await this.unlink(file.path);
    }
  }

  /**
   * Where a row's file is on disk. basename(): rows of old versions hold
   * "uploads/<name>"; never a path outside UPLOADS_DIR.
   */
  getFilePath(path: string): string {
    return join(FileService.UPLOADS_DIR, basename(path));
  }

  private async unlink(path: string): Promise<void> {
    if (!path) return;
    try {
      await fs.promises.unlink(this.getFilePath(path));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger.warn(
          `cannot delete upload ${basename(path)}: ${error?.message}`,
        );
      }
    }
  }
}
