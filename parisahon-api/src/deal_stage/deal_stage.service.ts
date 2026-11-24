import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, Not, Repository } from 'typeorm';
import { DealStage } from './deal_stage.entity';
import { CreateDealStageDto } from './dto/create.deal.stage.dto';
import { InjectRepository } from '@nestjs/typeorm';
import * as process from 'process';
import { Setting } from '../setting/setting.entity';
import { HelperService } from 'src/helper/helper.service';
import { DealStageCollection } from './deal_stage.collection.entity';
import { CreateCollectionDto } from './dto/create.collection.dto';
import { FetchQueryDto } from './dto/fetch.query.dto';
import {
  CLOSING_STAGE_KINDS,
  defaultStageName,
  isClosingStage,
  isSystemStage,
  StageKind,
  SYSTEM_STAGE_KINDS,
} from './stage-kind';
import { AuditJournal } from '../audit/audit-journal';

/**
 * What references a set of stages. Deals reference their current stage,
 * deal_stage_record keeps the history of stage changes. Both are foreign
 * keys, so a stage that is referenced cannot simply be deleted.
 */
type StageUsage = {
  deals: number;
  deleted_deals: number;
  history_records: number;
  is_default_stage: boolean;
};

/**
 * Stages and pipelines (collections). What a stage means is its kind (stage-kind.ts): the
 * names are labels only.
 */
@Injectable()
export class DealStageService {
  constructor(
    @InjectRepository(DealStage)
    private dealStageRepository: Repository<DealStage>,
    @InjectRepository(DealStageCollection)
    private collectionRepository: Repository<DealStageCollection>,
    @InjectRepository(Setting)
    private settingRepository: Repository<Setting>,
    private helperService: HelperService,
    private dataSource: DataSource,
  ) {}

  async fetchAll(query: FetchQueryDto): Promise<DealStage[]> {
    let qb = this.dealStageRepository
      .createQueryBuilder('t0')
      .leftJoinAndSelect('t0.triggers', 't1')
      .leftJoin('t0.collection', 't2');

    if (query.collection_id) {
      qb = qb.andWhere('t0.collection_id = :collection_id', {
        collection_id: query.collection_id,
      });
    } else {
      qb = qb.andWhere('t2.is_active = true');
    }

    const stages = await qb
      .orderBy('t0.order', 'ASC', 'NULLS LAST')
      .addOrderBy('t0.id', 'ASC')
      .getMany();

    // the kanban and the settings page tell the closing columns apart (won / lost) and the system
    // stages (no delete, no move to another pipeline); `kind` itself is a column of the stage
    for (const stage of stages) {
      const extra = stage as DealStage & { is_closing?: boolean; is_system?: boolean };
      extra.is_closing = this.isClosingStage(stage);
      extra.is_system = isSystemStage(stage);
    }

    return stages;
  }

  /**
   * Stage for deals created without an explicit stage (Telegram, WhatsApp, calls, mail, the bot):
   * the one chosen in «Настроить воронку» when it belongs to the active collection; a stage of a
   * collection that is not active any more is replaced by its counterpart in the active one (same
   * kind for a system stage, same name for another); otherwise (and instead of a closing stage) the
   * stage of kind `new` («Неразобранное») of the active collection.
   * Null when nothing fits (no active collection and nothing chosen).
   */
  async findDefaultStage(): Promise<DealStage | null> {
    const settings = await this.settingRepository.find({
      relations: ['default_stage', 'default_stage.collection'],
      order: {
        id: 'DESC',
      },
      take: 1,
    });
    const chosen = settings[0]?.default_stage ?? null;
    const usable = chosen && !this.isClosingStage(chosen) ? chosen : null;

    if (usable?.collection?.is_active) {
      return usable;
    }

    const active = await this.collectionRepository.findOneBy({ is_active: true });
    if (!active) {
      return usable;
    }

    return (
      (usable ? await this.counterpartIn(this.dataSource.manager, active.id, usable) : null) ??
      (await this.stageOfKind(active.id, StageKind.NEW, this.dataSource.manager))
    );
  }

  async getDefaultStage(): Promise<DealStage> {
    const stage = await this.findDefaultStage();

    if (!stage) {
      throw new BadRequestException(
        'Не задан этап для новых сделок: выберите его в «Сделки → Настроить» или передайте stage_id',
      );
    }

    return stage;
  }

  /**
   * PATCH /stages/default: the stage new deals without an explicit stage go to.
   * Only a working (not closing) stage of the active collection.
   */
  async setDefaultStage(stageId: number): Promise<DealStage> {
    const stage = await this.helperService.getById(DealStage, stageId, ['collection']);

    if (!stage.collection?.is_active) {
      throw new BadRequestException(
        `Этап «${stage.name}» не из активной воронки: этап для новых сделок выбирается из неё`,
      );
    }

    if (this.isClosingStage(stage)) {
      throw new BadRequestException(
        `Этап «${stage.name}» закрывает сделку: новые сделки в него не ставятся`,
      );
    }

    const settings = await this.settingRepository.find({ order: { id: 'DESC' }, take: 1 });
    if (settings[0]) {
      await this.settingRepository.update(settings[0].id, {
        default_stage: { id: stage.id } as DealStage,
      });
    } else {
      await this.settingRepository.save(
        this.settingRepository.create({ default_stage: { id: stage.id } as DealStage }),
      );
    }

    stage.collection = undefined;
    return stage;
  }

  /**
   * The stage of a kind in a pipeline (null when it has none). Without a pipeline: in the active one.
   * The helper other modules use instead of the old DEAL_STAGE_* names.
   */
  async stageOfKind(
    collectionId: number | null,
    kind: StageKind,
    manager: EntityManager = this.dataSource.manager,
  ): Promise<DealStage | null> {
    const qb = manager
      .createQueryBuilder(DealStage, 't0')
      .where('t0.kind = :kind', { kind })
      .orderBy('t0.id', 'ASC');
    if (collectionId) {
      qb.andWhere('t0.collection_id = :collection_id', { collection_id: collectionId });
    } else {
      qb.innerJoin('t0.collection', 'c').andWhere('c.is_active = true');
    }
    return qb.getOne();
  }

  /**
   * The stage of another pipeline that stands for `stage`: of the same kind for a system stage,
   * of the same name for a stage of an admin (null when there is none).
   */
  private async counterpartIn(
    manager: EntityManager,
    collectionId: number,
    stage: Pick<DealStage, 'name' | 'kind'> | null | undefined,
  ): Promise<DealStage | null> {
    if (!stage) {
      return null;
    }
    if (isSystemStage(stage)) {
      return this.stageOfKind(collectionId, stage.kind, manager);
    }
    if (!stage.name) {
      return null;
    }

    return manager
      .createQueryBuilder(DealStage, 't0')
      .where('t0.collection_id = :collection_id', { collection_id: collectionId })
      .andWhere('t0.name = :name', { name: stage.name })
      .orderBy('t0.id', 'ASC')
      .getOne();
  }

  async getById(id: number): Promise<DealStage> {
    const dealStage = await this.dealStageRepository.findOne({
      where: { id },
      relations: ['triggers'],
    });

    if (!dealStage) {
      throw new NotFoundException(`Deal Stage with id ${id} does not exist!`);
    }

    return dealStage;
  }

  async createCollection(
    data: CreateCollectionDto,
  ): Promise<DealStageCollection> {
    const collectionExists = await this.collectionRepository.findOneBy({
      name: data.name,
    });

    if (collectionExists) {
      throw new BadRequestException('Collection with that name already exist!');
    }

    const collection = new DealStageCollection();
    collection.name = data.name;

    collection.deal_stages = this.createDefaultStageEntities();

    return this.collectionRepository.save(collection);
  }

  async updateCollection(id: number, data: CreateCollectionDto): Promise<void> {
    const collection = await this.helperService.getById(
      DealStageCollection,
      id,
    );

    if (collection.name === process.env.DEFAULT_COLLECTION_NAME) {
      throw new BadRequestException('Cannot modify default collection');
    }

    const collectionExists = await this.collectionRepository.findOneBy({
      name: data.name,
      id: Not(id),
    });

    if (collectionExists) {
      throw new BadRequestException('Collection with that name already exist!');
    }

    collection.name = data.name;

    await this.collectionRepository.save(collection);
    return;
  }

  async getCollections(): Promise<DealStageCollection[]> {
    return this.collectionRepository.find({ order: { id: 'ASC' } });
  }

  async getCollectionById(id: number): Promise<DealStageCollection> {
    return this.helperService.getById(DealStageCollection, id);
  }

  /**
   * A collection can be deleted only when nothing depends on it:
   * it is not the active one, not the default one, and its stages are not
   * referenced by deals (including deleted ones), by the stage history or by
   * the "default stage" setting. Otherwise the database would refuse the
   * delete with a foreign key error (it used to be a 500).
   */
  async deleteCollection(id: number): Promise<void> {
    const collection = await this.helperService.getById(
      DealStageCollection,
      id,
    );

    if (collection.name === process.env.DEFAULT_COLLECTION_NAME) {
      throw new BadRequestException('Cannot delete default collection');
    }

    if (collection.is_active) {
      throw new BadRequestException(
        `Cannot delete collection "${collection.name}": it is the active collection. Activate another collection first.`,
      );
    }

    const stages = await this.getCollectionStages(id);
    const usage = await this.getStageUsage(stages.map((stage) => stage.id));
    const reasons = this.describeStageUsage(usage);

    if (usage.is_default_stage) {
      reasons.push(
        'one of its stages is the default stage for new deals (settings)',
      );
    }

    if (reasons.length > 0) {
      throw new BadRequestException(
        `Cannot delete collection "${collection.name}": ${reasons.join('; ')}. ` +
          `Move the deals to stages of another collection first; a collection with stage history cannot be deleted.`,
      );
    }

    // Stages and their triggers are removed by ON DELETE CASCADE (the journal keeps their last state)
    await AuditJournal.around(this.dataSource, 'stage', 't.collection_id = $1', [collection.id], () =>
      AuditJournal.around(
        this.dataSource,
        'trigger',
        't.deal_stage_id IN (SELECT s.id FROM deal_stage s WHERE s.collection_id = $1)',
        [collection.id],
        () => this.collectionRepository.delete(collection.id),
      ),
    );
  }

  async getCollectionStages(id: number): Promise<DealStage[]> {
    return this.dealStageRepository
      .createQueryBuilder('t0')
      .where('t0.collection_id = :id', { id })
      .getMany();
  }

  /**
   * Makes the collection the only active one.
   *
   * Existing deals are NOT moved: they stay in the stages of the collection
   * they were created in.
   *
   * The stage for new deals (settings) moves along: to the stage of the same
   * name of the new collection, otherwise to its "unknown" stage. Before, the
   * deals from Telegram, WhatsApp, calls and mail kept going to the stage of
   * the old collection and were not on the board.
   */
  async activateCollection(id: number): Promise<void> {
    const targetCollection = await this.helperService.getById(
      DealStageCollection,
      id,
    );

    await this.dataSource.transaction(async (manager) => {
      await manager
        .createQueryBuilder()
        .update(DealStageCollection)
        .set({ is_active: false })
        .where('id != :id AND is_active = true', { id: targetCollection.id })
        .execute();

      await manager
        .createQueryBuilder()
        .update(DealStageCollection)
        .set({ is_active: true })
        .where('id = :id', { id: targetCollection.id })
        .execute();

      const settings = await manager.find(Setting, {
        relations: ['default_stage', 'default_stage.collection'],
        order: { id: 'DESC' },
        take: 1,
      });
      const setting = settings[0];
      if (!setting || setting.default_stage?.collection?.id === targetCollection.id) {
        return;
      }

      const next =
        (await this.counterpartIn(manager, targetCollection.id, setting.default_stage)) ??
        (await this.stageOfKind(targetCollection.id, StageKind.NEW, manager));
      await manager.update(Setting, setting.id, {
        default_stage: next ? ({ id: next.id } as DealStage) : null,
      });
    });
  }

  /** The system stages of a new pipeline (named by DEAL_STAGE_* of .env or the usual names). */
  createDefaultStageEntities(): DealStage[] {
    const stages = [];

    let counter = 1;
    for (const kind of SYSTEM_STAGE_KINDS) {
      const newStage = new DealStage();
      newStage.name = defaultStageName(kind);
      newStage.kind = kind;
      newStage.order = counter++;

      stages.push(newStage);
    }

    return stages;
  }

  /**
   * Name and order are unique inside a collection, other collections do not
   * matter.
   *
   * order is the position of the stage:
   *  - not sent: the stage is appended after the last one;
   *  - free:     used as is;
   *  - taken:    the stage is inserted at that position, the stages from that
   *              position on move one step further.
   */
  async create(data: CreateDealStageDto): Promise<DealStage> {
    const collection = await this.helperService.getById(
      DealStageCollection,
      data.collection_id,
    );

    const stageWithSameName = await this.dealStageRepository
      .createQueryBuilder('t0')
      .where('t0.name = :name', { name: data.name })
      .andWhere('t0.collection_id = :collection_id', {
        collection_id: collection.id,
      })
      .getOne();

    if (stageWithSameName) {
      throw new BadRequestException('Stage with this name already exists!');
    }

    return this.dataSource.transaction(async (manager) => {
      let order = data.order;

      if (order === undefined || order === null) {
        const result = await manager
          .createQueryBuilder(DealStage, 't0')
          .select('MAX(t0.order)', 'max_order')
          .where('t0.collection_id = :collection_id', {
            collection_id: collection.id,
          })
          .getRawOne<{ max_order: number | null }>();

        order = Number(result?.max_order ?? 0) + 1;
      } else {
        const isTaken = await manager
          .createQueryBuilder(DealStage, 't0')
          .where('t0.collection_id = :collection_id', {
            collection_id: collection.id,
          })
          .andWhere('t0.order = :order', { order })
          .getCount();

        if (isTaken > 0) {
          await manager.query(
            `UPDATE deal_stage SET "order" = "order" + 1 WHERE collection_id = $1 AND "order" >= $2`,
            [collection.id, order],
          );
        }
      }

      // a stage of an admin; the system kinds come with the pipeline
      const newDealStage = new DealStage();
      newDealStage.name = data.name;
      newDealStage.kind = StageKind.WORK;
      newDealStage.order = order;
      newDealStage.description = data.description;
      newDealStage.color = data.color;
      newDealStage.collection = collection;

      return manager.save(newDealStage);
    });
  }

  async update(id: number, data: CreateDealStageDto): Promise<void> {
    const targetDealStage = await this.helperService.getById(DealStage, id, [
      'collection',
    ]);

    const dealStage = await this.dealStageRepository
      .createQueryBuilder('t0')
      .where('t0.name = :name AND t0.id != :stage_id', {
        name: data.name,
        stage_id: id,
      })
      .andWhere('t0.collection_id = :collection_id', {
        collection_id: data.collection_id,
      })
      .getOne();

    if (dealStage) {
      throw new BadRequestException('Stage with this name already exists!');
    }

    // a system stage stays in its pipeline (every pipeline needs one of each kind); its name is
    // only a label and can be changed: the code goes by the kind
    if (
      targetDealStage.collection?.id !== data.collection_id &&
      !isSystemStage(targetDealStage)
    ) {
      targetDealStage.collection = await this.helperService.getById(
        DealStageCollection,
        data.collection_id,
      );
    }
    targetDealStage.name = data.name;
    /**
     * Order is not checked for uniqueness here on purpose: the settings page
     * reorders stages by sending a new order for every stage of the collection.
     */
    if (data.order !== undefined && data.order !== null) {
      targetDealStage.order = data.order;
    }
    targetDealStage.description = data.description;
    targetDealStage.color = data.color;

    await this.dealStageRepository.save(targetDealStage);
  }

  /**
   * DELETE /stages/:id[?move_to=<stage id>]
   *
   * A stage that is not referenced by anything is simply deleted.
   *
   * A stage with deals or with stage history cannot be deleted as is (foreign
   * keys, it used to be a 500): the answer is 400 with the reason. When
   * `move_to` is given, the stage is merged into that stage of the same
   * collection: its deals (deleted ones too) and its history records are
   * moved there, then the stage is deleted. This is an administrative merge:
   * no triggers are run and no events are written for the moved deals.
   */
  async delete(id: number, moveToStageId: number = null): Promise<void> {
    const stage = await this.helperService.getById(DealStage, id, [
      'collection',
    ]);

    this.throwIfDefaultStage(stage);

    const usage = await this.getStageUsage([stage.id]);

    if (usage.is_default_stage) {
      throw new BadRequestException(
        `Cannot delete stage "${stage.name}": it is the default stage for new deals. Choose another default stage in settings first.`,
      );
    }

    const reasons = this.describeStageUsage(usage);

    if (reasons.length === 0) {
      // its triggers go by ON DELETE CASCADE: the journal keeps their last state
      await AuditJournal.around(this.dataSource, 'trigger', 't.deal_stage_id = $1', [stage.id], () =>
        this.dealStageRepository.delete(stage.id),
      );
      return;
    }

    if (!moveToStageId) {
      throw new BadRequestException(
        `Cannot delete stage "${stage.name}": ${reasons.join('; ')}. ` +
          `To delete it, repeat the request with ?move_to=<id of another stage of the same collection>: ` +
          `the deals and their stage history will be moved to that stage.`,
      );
    }

    if (moveToStageId === stage.id) {
      throw new BadRequestException(
        'move_to must be a different stage than the one being deleted',
      );
    }

    const targetStage = await this.helperService.getById(
      DealStage,
      moveToStageId,
      ['collection'],
    );

    if (targetStage.collection?.id !== stage.collection?.id) {
      throw new BadRequestException(
        `Stage "${targetStage.name}" (id ${targetStage.id}) belongs to another collection, deals can be moved only inside one collection`,
      );
    }

    const closing = this.isClosingStage(targetStage);

    await this.dataSource.transaction(async (manager) => {
      // the journal (src/audit): every moved deal gets its row «Этап: … → …» in this transaction
      await AuditJournal.around(manager, 'deal', 't.stage_id = $1', [stage.id], async () => {
        if (closing) {
          // closed_at is written by the application clock everywhere else
          await manager.query(
            `UPDATE deal SET stage_id = $1, closed_at = COALESCE(closed_at, $3) WHERE stage_id = $2`,
            [targetStage.id, stage.id, new Date()],
          );
        } else {
          // a working stage: its deals are open (closed_at means closed everywhere)
          await manager.query(
            `UPDATE deal SET stage_id = $1, closed_at = NULL WHERE stage_id = $2`,
            [targetStage.id, stage.id],
          );
        }
      });

      await manager.query(
        `UPDATE deal_stage_record SET stage_id = $1 WHERE stage_id = $2`,
        [targetStage.id, stage.id],
      );
      await manager.query(
        `UPDATE deal_stage_record SET from_stage_id = $1 WHERE from_stage_id = $2`,
        [targetStage.id, stage.id],
      );

      // Triggers of the stage are removed by ON DELETE CASCADE (the journal keeps their last state)
      await AuditJournal.around(manager, 'trigger', 't.deal_stage_id = $1', [stage.id], () =>
        manager.delete(DealStage, stage.id),
      );
    });
  }

  private throwIfDefaultStage(stage: DealStage): void {
    if (isSystemStage(stage)) {
      throw new BadRequestException(
        `Этап «${stage.name}» системный: он нужен каждой воронке, удалить его нельзя (переименовать можно)`,
      );
    }
  }

  private async getStageUsage(stageIds: number[]): Promise<StageUsage> {
    if (stageIds.length === 0) {
      return {
        deals: 0,
        deleted_deals: 0,
        history_records: 0,
        is_default_stage: false,
      };
    }

    const [row] = await this.dataSource.query(
      `SELECT
        (SELECT COUNT(*) FROM deal WHERE stage_id = ANY($1::int[]) AND deleted_at IS NULL) AS deals,
        (SELECT COUNT(*) FROM deal WHERE stage_id = ANY($1::int[]) AND deleted_at IS NOT NULL) AS deleted_deals,
        (SELECT COUNT(*) FROM deal_stage_record WHERE stage_id = ANY($1::int[]) OR from_stage_id = ANY($1::int[])) AS history_records,
        (SELECT COUNT(*) FROM setting WHERE default_stage_id = ANY($1::int[])) AS default_stage_settings`,
      [stageIds],
    );

    return {
      deals: Number(row.deals),
      deleted_deals: Number(row.deleted_deals),
      history_records: Number(row.history_records),
      is_default_stage: Number(row.default_stage_settings) > 0,
    };
  }

  private describeStageUsage(usage: StageUsage): string[] {
    const reasons: string[] = [];

    if (usage.deals > 0) {
      reasons.push(`${usage.deals} deal(s) are in it now`);
    }

    if (usage.deleted_deals > 0) {
      reasons.push(
        `${usage.deleted_deals} deleted deal(s) are still linked to it`,
      );
    }

    if (usage.history_records > 0) {
      reasons.push(
        `${usage.history_records} record(s) of deal stage history reference it`,
      );
    }

    return reasons;
  }

  /**
   * A deal in this stage is closed (deal.closed_at is set); in any other one it is open:
   * kind won («успешно реализовано») or lost («закрыто и не реализовано»).
   */
  isClosingStage(stage: Pick<DealStage, 'kind'> | null | undefined): boolean {
    return isClosingStage(stage);
  }

  /** Ids of the closing stages of all collections. */
  async closingStageIds(): Promise<number[]> {
    const rows: { id: number }[] = await this.dataSource.query(
      `SELECT id FROM deal_stage WHERE kind = ANY($1::text[])`,
      [CLOSING_STAGE_KINDS],
    );

    return rows.map((row) => Number(row.id));
  }
}
