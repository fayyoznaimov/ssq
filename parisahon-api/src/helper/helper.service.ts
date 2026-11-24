import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Type,
  UnauthorizedException,
} from '@nestjs/common';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  PaginationRequestDto,
  PaginationResponseDto,
  SortOptions,
} from './dto/pagination.dto';
import { DataSource, EntityManager, SelectQueryBuilder } from 'typeorm';
import { Request } from 'express';
import { RoleEnum, User } from '../user/user.entity';
import { TaskTypes, TaskTypesToWeights } from '../deal/dto/search.deal.dto';
import { OrderBy } from './dto/order.by';
import { Deal } from '../deal/deal.entity';
import { DealStage } from '../deal_stage/deal_stage.entity';
import { StageKind } from '../deal_stage/stage-kind';
import * as process from 'process';
import { DealFilter } from '../trigger/dto/assign.trigger.dto';
import { Filler } from '../filler/filler.entity';
import { AuditJournal } from '../audit/audit-journal';

@Injectable()
export class HelperService {
  constructor(private dataSource: DataSource) {}

  /**
   * This methods purpose is to avoid unnecessary dependency injections
   * in services
   */
  async getById<T>(
    entityType: Type<T>,
    id: number,
    relations: string[] = [],
  ): Promise<T> {
    let qb = this.dataSource.getRepository(entityType).createQueryBuilder('t0');

    if (relations.length !== 0) {
      qb = this.withRelations(qb, relations);
    }

    const entity = await qb.where('t0.id = :id', { id: id }).getOne();

    if (!entity) {
      throw new NotFoundException(
        `${entityType.name} with id ${id} does not exist!`,
      );
    }

    return entity;
  }

  async getByIds<T extends { id: number }>(
    entityType: Type<T>,
    ids: number[],
    relations: string[] = [],
  ): Promise<T[]> {
    let qb = this.dataSource.getRepository(entityType).createQueryBuilder('t0');

    if (relations.length !== 0) {
      qb = this.withRelations(qb, relations);
    }

    const data = await qb.where('t0.id IN (:...ids)', { ids: ids }).getMany();

    if (data.length !== ids.length) {
      this.throwNotFoundErrorWithNonExistingIds(entityType, ids, data);
    }

    return data;
  }

  private throwNotFoundErrorWithNonExistingIds<T extends { id: number }>(
    entityType: Type<T>,
    requested_ids: number[],
    entities: T[],
  ): void {
    const non_existing_ids: number[] = [];
    const idsToEntities = this.createHashMap(entities);

    requested_ids.forEach((id) => {
      if (!idsToEntities.has(id)) {
        non_existing_ids.push(id);
      }
    });

    throw new NotFoundException(
      `${entityType.name}s with ids: ${non_existing_ids.join(', ')} does not exist!`,
    );
  }

  async generateNewDeals(amount: number): Promise<Deal[]> {
    const unknownDealStage = await this.getActiveStageOfKind(StageKind.NEW);
    const admin = await this.getAdmin();

    return this.dataSource.transaction(async (manager) => {
      await this.lockDealNumbers(manager);
      const first = await this.nextDealNumber(manager);
      const deals: Deal[] = [];

      for (let i = 0; i < amount; i++) {
        const newDeal = new Deal();
        newDeal.display_id = first + i;
        newDeal.label = `#${newDeal.display_id}`;
        newDeal.stage = unknownDealStage;
        newDeal.created_by = admin;

        deals.push(newDeal);
      }

      return manager.save(deals);
    });
  }

  async getAdmin(): Promise<User> {
    const admin = await this.dataSource
      .getRepository(User)
      .findOneBy({ role: RoleEnum.ADMIN });

    // The code should never reach this part.
    if (!admin) {
      throw new NotFoundException(
        `Not a single user with admin role has been setup`,
      );
    }

    return admin;
  }

  /** The stage of a kind (deal_stage/stage-kind.ts) of the active pipeline; it used to be found by name in any pipeline. */
  async getActiveStageOfKind(kind: StageKind): Promise<DealStage> {
    const stage = await this.dataSource
      .getRepository(DealStage)
      .createQueryBuilder('s')
      .innerJoin('s.collection', 'c')
      .where('s.kind = :kind AND c.is_active = true', { kind })
      .orderBy('s.id', 'ASC')
      .getOne();

    if (!stage) {
      throw new NotFoundException(`The active pipeline has no stage of kind ${kind}`);
    }

    return stage;
  }

  async getDealColumns(): Promise<DealFilter[]> {
    const query =
      'SELECT column_name FROM information_schema.columns WHERE table_name = $1';
    const result = await this.dataSource.query<{ column_name: string }[]>(
      query,
      ['deal'],
    );

    const columns: DealFilter[] = [];

    // Append native column names
    for (const row of result) {
      // technical columns of the trash (soft delete), not deal properties
      if (row.column_name === 'deleted_at' || row.column_name === 'deleted_by') {
        continue;
      }

      const newColumn = new DealFilter();
      newColumn.field = row.column_name;
      newColumn.is_filler = false;

      columns.push(newColumn);
    }

    const fillers = await this.dataSource
      .getRepository(Filler)
      .createQueryBuilder('t0')
      .where('t0.target = :target', { target: 'deal' })
      .getMany();

    // Append fillers' field names
    for (const filler of fillers) {
      const newColumn = new DealFilter();
      newColumn.is_filler = true;
      newColumn.field = filler.field;

      columns.push(newColumn);
    }

    return columns;
  }

  /**
   * Saves a NEW deal and gives it its number (display_id) in the same transaction.
   *
   * Numbers are sequential: max(display_id) + 1 over all deals, the ones in the trash
   * included (a number is not given out again while its deal exists). Creations are
   * serialised by a transaction-level advisory lock held until the deal row is committed,
   * so concurrent requests (the form, the Telegram inbox, the "create deal" trigger) never
   * compute the same number. The unique index on display_id stays as the last line of defence.
   *
   * A number asked for explicitly (CreateDealDto.display_id) is accepted when it is free;
   * the next automatic number then continues after it. A deal without a name is called
   * "#<number>".
   *
   * @param manager an outer transaction to save in (optional)
   */
  async saveNewDeal(
    deal: Deal,
    requested: number = null,
    manager: EntityManager = null,
  ): Promise<Deal> {
    const save = async (m: EntityManager): Promise<Deal> => {
      await this.lockDealNumbers(m);

      if (requested) {
        const taken = await m
          .getRepository(Deal)
          .createQueryBuilder('t0')
          .withDeleted()
          .where('t0.display_id = :display_id', { display_id: requested })
          .getCount();

        if (taken > 0) {
          throw new BadRequestException(
            `Deal with display_id ${requested} already exists!`,
          );
        }

        deal.display_id = requested;
      } else {
        deal.display_id = await this.nextDealNumber(m);
      }

      if (!deal.label) {
        deal.label = `#${deal.display_id}`;
      }

      try {
        return await m.save(deal);
      } catch (error) {
        if (error?.code === '23505' && /display_id/.test(String(error?.detail))) {
          throw new BadRequestException(
            `Deal with display_id ${deal.display_id} already exists!`,
          );
        }

        throw error;
      }
    };

    return manager ? save(manager) : this.dataSource.transaction(save);
  }

  /** Lock key of deal numbering (pg_advisory_xact_lock), any constant shared by all callers */
  static readonly DEAL_NUMBER_LOCK = 734001;

  private async lockDealNumbers(manager: EntityManager): Promise<void> {
    await manager.query('SELECT pg_advisory_xact_lock($1)', [
      HelperService.DEAL_NUMBER_LOCK,
    ]);
  }

  /** max(display_id) + 1 over all deals, deals in the trash included */
  private async nextDealNumber(manager: EntityManager): Promise<number> {
    const rows: { next: string }[] = await manager.query(
      'SELECT COALESCE(MAX(display_id), 0) + 1 AS next FROM deal',
    );

    return Number(rows[0].next);
  }

  async deleteById<T>(entityType: Type<T>, id: number): Promise<void> {
    // the journal (src/audit): a deleted task or note keeps its last state there, with who deleted it
    const table = this.dataSource.getMetadata(entityType).tableName;
    const result = await AuditJournal.around(this.dataSource, table, 't.id = $1', [id], () =>
      this.dataSource
        .createQueryBuilder()
        .delete()
        .from(entityType)
        .where('id = :id', { id })
        .execute(),
    );

    if (result.affected === 0) {
      throw new NotFoundException(
        `${entityType.name} with id ${id} does not exist!`,
      );
    }
  }

  /**
   *  While using TypeORM repositories, save method does not return
   *  relations/properties that are undefined, in resulting object.
   *  This methods purpose is to add them.
   */
  addUndefinedRelations<T extends Record<string, any>>(
    obj: T,
    relations: string[],
  ): T {
    relations.forEach((relation) => {
      if (!(relation in obj)) {
        (obj as any)[relation] = null;
      }
    });

    return obj;
  }

  async extractUserFromRequest(request: Request): Promise<User> {
    return this.getById(User, this.extractUserIdFromRequest(request));
  }

  extractUserIdFromRequest(request: Request): number {
    const id = request['user']?.sub;

    if (!id) {
      throw new UnauthorizedException();
    }

    return id;
  }

  getEnumWithMaxRange(enums: TaskTypes[]): TaskTypes | undefined {
    let maxEnum: TaskTypes | undefined;
    let maxWeight = Number.NEGATIVE_INFINITY;

    for (const enumValue of enums) {
      const weight = TaskTypesToWeights.get(enumValue);
      if (weight && weight > maxWeight) {
        maxEnum = enumValue;
        maxWeight = weight;
      }
    }

    return maxEnum;
  }

  createHashMap<T extends { id: number }>(data: T[]): Map<number, T> {
    const hashMap = new Map<number, T>();

    data.forEach((item) => {
      hashMap.set(item.id, item);
    });

    return hashMap;
  }

  /**
   * TypeORM offers convenient way to load relations using
   * repositories. However, it does not provide functionality
   * to fetch relations alongside with count information
   * in a single query. QueryBuilder does.
   *
   * This method combines the two!
   */
  withRelations<T>(
    qb: SelectQueryBuilder<T>,
    relations: string[],
    alias: string = 't0',
    shift: number = 0, // Shift is used to avoid duplicate aliases from outer scope
  ): SelectQueryBuilder<T> {
    const relationToAlias = new Map<string, string>();

    /**
     * Although this logic could be simplified by just changing the input,
     * keeping the input the same with how relations are loaded in repositories
     * will make it easier for use.
     */
    for (let i = 0; i < relations.length; i++) {
      const nestedRelations = relations[i].split('.');

      for (let j = 0; j < nestedRelations.length; j++) {
        const relationLevel = nestedRelations.slice(0, j + 1).join('.');
        if (relationToAlias.has(relationLevel)) {
          continue;
        }

        if (j > 0) {
          shift++;
        }

        const localAlias =
          j === 0
            ? alias
            : relationToAlias.get(nestedRelations.slice(0, j).join('.'));

        qb = qb.leftJoinAndSelect(
          `${localAlias}.${nestedRelations[j]}`,
          `t${i + 1 + shift}`,
        );

        relationToAlias.set(relationLevel, `t${i + 1 + shift}`);
      }
    }

    return qb;
  }

  async withPagination<T>(
    qb: SelectQueryBuilder<T>,
    query: PaginationRequestDto,
    alias: string = 't0',
    total_count: number = null,
    ignore_limits: boolean = false,
    ignore_sorting: boolean = false,
  ): Promise<PaginationResponseDto<T[]>> {
    /**
     * The DTO validates limit/skip for HTTP requests. Values are normalised
     * here once more, because this method is also called with hand-made
     * query objects.
     */
    const limit = this.normalizeLimit(query.limit);
    const skip = this.normalizeSkip(query.skip);
    query.limit = limit;
    query.skip = skip;

    if (!ignore_limits) {
      qb = qb.skip(skip).take(limit);
    }

    if (!ignore_sorting && query.sort) {
      qb = qb.orderBy(
        this.parseSortOptions(
          query.sort,
          alias,
          this.getSortableColumns(qb, alias),
        ),
      );
    }

    const [data, count] = await qb.getManyAndCount();

    const response = new PaginationResponseDto<T[]>();
    response.data = data;
    response.count = total_count ?? count;
    response.page_size = limit;
    response.current_page = Math.floor(skip / limit) + 1;
    response.last_page = this.calculateLastPage(response.count, limit);

    return response;
  }

  normalizeLimit(limit: unknown): number {
    const value = Number(limit ?? DEFAULT_PAGE_SIZE);

    if (!Number.isInteger(value) || value < 1) {
      return DEFAULT_PAGE_SIZE;
    }

    return Math.min(value, MAX_PAGE_SIZE);
  }

  normalizeSkip(skip: unknown): number {
    const value = Number(skip ?? 0);

    if (!Number.isInteger(value) || value < 0) {
      return 0;
    }

    return value;
  }

  /**
   * 0 rows -> 1 page, 25 rows by 25 -> 1 page, 26 rows by 25 -> 2 pages
   */
  calculateLastPage(count: number, limit: number): number {
    return Math.max(1, Math.ceil(Number(count) / limit));
  }

  /**
   * Whitelist of columns a list can be sorted by: columns of the entity
   * the query is built on (relations are addressed by their property name,
   * e.g. sort[stage] sorts by stage_id).
   */
  getSortableColumns<T>(qb: SelectQueryBuilder<T>, alias: string): string[] {
    const aliasData = qb.expressionMap.aliases.find(
      (item) => item.name === alias,
    );

    if (!aliasData || !aliasData.hasMetadata) {
      return [];
    }

    /**
     * propertyName, not propertyPath: for a relation the path is "stage.id",
     * while ORDER BY (and the client) address it as "stage".
     */
    const columns = aliasData.metadata.columns
      // hidden columns (select: false, e.g. user.password) are not sortable
      .filter((column) => !column.embeddedMetadata && column.isSelect)
      .map((column) => column.propertyName);

    return [...new Set(columns)];
  }

  public validateAndGetSortOptions(
    query: PaginationRequestDto,
    fields: string[],
  ): [string, OrderBy] {
    let sortBy = 'id';
    let sortByType = OrderBy.ASC;

    if (query.sort) {
      if (Object.keys(query.sort).length > 1) {
        throw new BadRequestException({
          message: ['You can only sort by one field at a time!'],
          error: 'Bad Request',
          statusCode: 400,
        });
      }

      if (Object.keys(query.sort).length != 0) {
        if (!fields.includes(Object.keys(query.sort)[0])) {
          throw new BadRequestException({
            message: [
              'each value in sort must be one of the following values: ' +
                fields.join(', '),
            ],
            error: 'Bad Request',
            statusCode: 400,
          });
        }
        sortBy = Object.keys(query.sort)[0];
        if (String(query.sort[sortBy]).includes('-')) {
          sortByType = OrderBy.DESC;
        }
      }
    }

    return [sortBy, sortByType];
  }

  /**
   * Converts sort[<column>]=1|-1 into TypeORM order options.
   *
   * The column name ends up in ORDER BY, so it is never taken from the
   * request as is: it has to be one of `allowedColumns`. Unknown columns and
   * unknown directions are answered with 400 instead of a broken query.
   */
  public parseSortOptions(
    sortingOptions: SortOptions,
    alias: string = 't0',
    allowedColumns: string[] = null,
  ): {
    [key: string]: 'ASC' | 'DESC';
  } {
    const convertedSortingOptions = {};

    if (
      typeof sortingOptions !== 'object' ||
      sortingOptions === null ||
      Array.isArray(sortingOptions)
    ) {
      this.throwSortError('sort must be an object: sort[<column>]=1 or -1');
    }

    for (const key of Object.keys(sortingOptions)) {
      const isSafeName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
      const isAllowed = allowedColumns === null || allowedColumns.includes(key);

      if (!isSafeName || !isAllowed) {
        this.throwSortError(
          allowedColumns && allowedColumns.length > 0
            ? `cannot sort by "${key.slice(0, 50)}", allowed columns: ${allowedColumns.join(', ')}`
            : `cannot sort by "${key.slice(0, 50)}"`,
        );
      }

      const direction = String(sortingOptions[key]).trim().toLowerCase();

      if (direction === '1' || direction === 'asc') {
        convertedSortingOptions[`${alias}.${key}`] = 'ASC';
      } else if (direction === '-1' || direction === 'desc') {
        convertedSortingOptions[`${alias}.${key}`] = 'DESC';
      } else {
        this.throwSortError(
          `sort direction of "${key}" must be 1 (ASC) or -1 (DESC)`,
        );
      }
    }

    return convertedSortingOptions;
  }

  private throwSortError(message: string): never {
    throw new BadRequestException({
      message: [message],
      error: 'Bad Request',
      statusCode: 400,
    });
  }
}
