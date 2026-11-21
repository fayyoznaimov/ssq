import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Deal } from './deal.entity';
import { AuthUser } from '../auth/auth.guard';
import { DealAccess } from './deal-access';
import { HelperService } from '../helper/helper.service';
import { DealStageService } from '../deal_stage/deal_stage.service';
import { FileService } from '../file/file.service';
import { File } from '../file/file.entity';
import { PaginationResponseDto } from '../helper/dto/pagination.dto';
import { SearchDealTrashDto } from './dto/search.deal.trash.dto';

/** What GET /deals/trash returns with every deal */
const TrashRelations = ['stage', 'agent', 'company', 'deleted_by'];

/**
 * The trash of deals.
 *
 * DELETE /deals/:id moves a deal to the trash (deal.deleted_at, deal.deleted_by): it
 * disappears from lists, the kanban, search, statistics, analytics, and so do its tasks
 * (task lists, calendar, desktop counters, bot reminders filter tasks of deals in the trash);
 * nothing linked to it is changed, so a restored deal comes back with its stage, history,
 * tasks, files and products. Its number is not given to another deal while it is in the trash.
 *
 * Seeing the trash and restoring follow the delete rule (DealAccess); deleting for good is
 * for the admin only and removes the deal with everything that belongs to it.
 */
@Injectable()
export class DealTrashService {
  private readonly logger = new Logger(DealTrashService.name);

  constructor(
    @InjectRepository(Deal)
    private dealRepository: Repository<Deal>,
    private dataSource: DataSource,
    private helperService: HelperService,
    private dealStageService: DealStageService,
    private fileService: FileService,
  ) {}

  /**
   * GET /deals/trash: deals in the trash the user may restore, recently deleted first.
   */
  async list(
    user: AuthUser,
    query: SearchDealTrashDto,
  ): Promise<PaginationResponseDto<Deal[]>> {
    const access = this.assertMayUseTrash(user);
    const condition = access.deleteCondition('t0');

    // withDeleted() before the joins: a responsible or a company deleted since is still shown
    let qb = this.dealRepository
      .createQueryBuilder('t0')
      .withDeleted()
      .where('t0.deleted_at IS NOT NULL')
      .andWhere(condition.sql, condition.params);

    const search = query.search?.trim();
    if (search) {
      const number = /^#?\d{1,9}$/.test(search) ? Number(search.replace('#', '')) : null;

      qb = qb.andWhere(
        number !== null
          ? '(t0.label ILIKE :trash_search OR t0.display_id = :trash_number)'
          : 't0.label ILIKE :trash_search',
        { trash_search: `%${search}%`, trash_number: number },
      );
    }

    // recently deleted first; id keeps the order stable for deals deleted at the same moment
    query.sort = { ...(query.sort ?? { deleted_at: '-1' }) };
    if (!('id' in query.sort)) {
      query.sort.id = '-1';
    }

    return this.helperService.withPagination(
      this.helperService.withRelations(qb, TrashRelations, 't0'),
      query,
    );
  }

  /**
   * POST /deals/trash/:id/restore: the deal is back where it was. A deal without a stage
   * (its stage cannot be deleted while a deal refers to it, so only a deal that never had
   * one) goes to the default stage.
   */
  async restore(user: AuthUser, id: number): Promise<Deal> {
    const access = this.assertMayUseTrash(user);
    const deal = await this.findInTrash(id, ['stage']);
    await this.assertInScope(access, id);

    const defaultStage = deal.stage
      ? null
      : await this.dealStageService.getDefaultStage();

    await this.dataSource.transaction(async (manager) => {
      // a purge of this deal in progress finishes first (then the deal is gone: 404)
      await manager.query('SELECT pg_advisory_xact_lock($1, $2)', [
        DealTrashService.PURGE_LOCK,
        id,
      ]);
      const locked = await manager.query(
        `SELECT id FROM deal WHERE id = $1 AND deleted_at IS NOT NULL FOR UPDATE`,
        [id],
      );

      // restored (or deleted for good) by somebody else a moment ago
      if (locked.length === 0) {
        throw new NotFoundException(`Deal with id ${id} is not in the trash`);
      }

      await manager.query(
        `UPDATE deal SET deleted_at = NULL, deleted_by = NULL WHERE id = $1`,
        [id],
      );

      if (defaultStage) {
        await manager.query(
          `UPDATE deal SET stage_id = $2, last_stage_change = $3 WHERE id = $1`,
          [id, defaultStage.id, new Date()],
        );
        await manager.query(
          `INSERT INTO deal_stage_record (deal_id, stage_id) VALUES ($1, $2)`,
          [id, defaultStage.id],
        );
      }
    });

    return this.dealRepository.findOne({
      where: { id },
      relations: ['stage'],
    });
  }

  /** DELETE /deals/trash/:id (admin) */
  async purge(id: number): Promise<void> {
    await this.findInTrash(id);
    await this.purgeDeal(id);
  }

  /** DELETE /deals/trash (admin): empties the trash */
  async purgeAll(): Promise<{ deleted: number }> {
    const rows: { id: number }[] = await this.dataSource.query(
      `SELECT id FROM deal WHERE deleted_at IS NOT NULL ORDER BY id`,
    );

    let deleted = 0;
    for (const row of rows) {
      if (await this.purgeDeal(Number(row.id))) {
        deleted++;
      }
    }

    return { deleted };
  }

  private assertMayUseTrash(user: AuthUser): DealAccess {
    const access = new DealAccess(user);

    if (access.deleteScope() === 'none') {
      throw new ForbiddenException('No right to delete deals');
    }

    return access;
  }

  private async assertInScope(access: DealAccess, id: number): Promise<void> {
    const condition = access.deleteCondition('t0');
    const allowed = await this.dealRepository
      .createQueryBuilder('t0')
      .withDeleted()
      .where('t0.id = :trash_deal_id', { trash_deal_id: id })
      .andWhere(condition.sql, condition.params)
      .getCount();

    if (allowed === 0) {
      throw new ForbiddenException(`No right to restore deal ${id}`);
    }
  }

  private async findInTrash(id: number, relations: string[] = []): Promise<Deal> {
    const deal = await this.dealRepository.findOne({
      where: { id },
      relations,
      withDeleted: true,
    });

    if (!deal || !deal.deleted_at) {
      throw new NotFoundException(`Deal with id ${id} is not in the trash`);
    }

    return deal;
  }

  /**
   * Removes a deal in the trash with everything that belongs to it: events (its history),
   * tasks with their events and reminders, stage history, links to files, custom field
   * values, products, contacts and planned trigger runs (the last four cascade).
   * Files go through FileService.deleteFileFromEntity: the row and the file on disk are
   * removed only when nothing else refers to them (another deal, in the trash too, an
   * e-mail, a Telegram message). The history of this deal is deleted before, so it does
   * not count as a reference.
   *
   * A restore of the same deal waits for this to finish and then finds nothing (404).
   *
   * @returns false when the deal was not in the trash (any more)
   */
  private async purgeDeal(dealId: number): Promise<boolean> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();

    try {
      await runner.query('SELECT pg_advisory_lock($1, $2)', [
        DealTrashService.PURGE_LOCK,
        dealId,
      ]);

      const inTrash = await runner.query(
        `SELECT 1 FROM deal WHERE id = $1 AND deleted_at IS NOT NULL`,
        [dealId],
      );
      if (inTrash.length === 0) {
        return false;
      }

      await this.dataSource.transaction(async (manager) => {
        await manager.query(
          `DELETE FROM event WHERE deal_id = $1 OR task_id IN (SELECT id FROM task WHERE deal_id = $1)`,
          [dealId],
        );
        await manager.query(`DELETE FROM task WHERE deal_id = $1`, [dealId]);
        await manager.query(`DELETE FROM deal_stage_record WHERE deal_id = $1`, [dealId]);
      });

      const files: { id: number }[] = await this.dataSource.query(
        `SELECT "fileId" AS id FROM deal_file WHERE "dealId" = $1`,
        [dealId],
      );
      for (const file of files) {
        await this.detachFile(dealId, Number(file.id));
      }

      await this.dataSource.transaction(async (manager) => {
        await manager.query(`DELETE FROM deal_file WHERE "dealId" = $1`, [dealId]);
        await manager.query(`DELETE FROM deal WHERE id = $1`, [dealId]);
      });

      return true;
    } finally {
      await runner
        .query('SELECT pg_advisory_unlock($1, $2)', [DealTrashService.PURGE_LOCK, dealId])
        .catch(() => undefined);
      await runner.release();
    }
  }

  /** Advisory lock namespace (with the deal id) shared by purge and restore */
  static readonly PURGE_LOCK = 734002;

  /**
   * Unlinks a file from a deal that is being deleted for good. The file is loaded with the
   * deals in the trash too: the deal being deleted is one of them (FileService checks it).
   */
  private async detachFile(dealId: number, fileId: number): Promise<void> {
    const file = await this.dataSource.getRepository(File).findOne({
      where: { id: fileId },
      relations: ['deals'],
      withDeleted: true,
    });

    try {
      if (file) {
        await this.fileService.deleteFileFromEntity(file, dealId);
        return;
      }
    } catch (error) {
      // the deal goes anyway; the link is dropped below, the file stays where it is
      this.logger.warn(`file ${fileId} of deal ${dealId}: ${(error as Error).message}`);
    }

    await this.dataSource.query(
      `DELETE FROM deal_file WHERE "dealId" = $1 AND "fileId" = $2`,
      [dealId, fileId],
    );
  }
}
