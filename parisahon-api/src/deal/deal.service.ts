import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Deal } from './deal.entity';
import { DataSource, In, Repository, SelectQueryBuilder } from 'typeorm';
import { CreateDealDto, LinkProductsDto } from './dto/create.deal.dto';
import { UserService } from '../user/user.service';
import { HelperService } from '../helper/helper.service';
import { User } from '../user/user.entity';
import { DealStageService } from '../deal_stage/deal_stage.service';
import { Company } from '../company/company.entity';
import { FillerService } from '../filler/filler.service';
import {
  ChildFiller,
  FillableTablesEnum,
  Filler,
} from '../filler/filler.entity';
import { DealFiller } from './deal.filler.entity';
import { UpdateDealDto, UpdateDealFillerDto } from './dto/update.deal.dto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventTypes, FieldsOf } from '../events/event.entity';
import { CtrAgentEventDto } from '../events/dto/ctr.agent.event.dto';
import { PaginationResponseDto } from '../helper/dto/pagination.dto';
import { Field, FieldValueEventDto } from '../events/dto/field.value.event.dto';
import { Request } from 'express';
import {
  FillerDto,
  getTaskDateRange,
  SearchDealDto,
  TaskTypes,
  TaskTypesToWeights,
} from './dto/search.deal.dto';
import { DealEventDto } from '../events/dto/deal.event.dto';
import { CompanyEventDto } from '../events/dto/company.event';
import { DealStage } from '../deal_stage/deal_stage.entity';
import { Product } from '../product/product.entity';
import { DealProduct } from './deal-product.entity';
import { ProductEventDto } from '../events/dto/product.event.dto';
import { DealFilter } from '../trigger/dto/assign.trigger.dto';
import { DealStageEventDto } from '../events/dto/deal.stage.event.dto';
import { TriggerService } from '../trigger/trigger.service';
import { DealStageRecord } from 'src/deal_stage/deal_stage.records.entity';
import { AuthUser } from '../auth/auth.guard';
import { DealAccess } from './deal-access';

/**
 * Relations returned by GET /deals.
 * The list is fixed: filters are applied with EXISTS sub-queries and never
 * touch these joins, so a filter cannot cut related rows out of the response.
 */
const DealListRelations = [
  'stage',
  'agent',
  'agent.user_fillers',
  'deal_fillers',
  'deal_fillers.filler',
  'ctr_agents',
  'ctr_agents.user_fillers',
  // deals from Telegram / WhatsApp have the company on the contact only
  'ctr_agents.company',
  'company',
  // the "повторный" badge of the deals list and kanban
  'repeat_of',
];

/**
 * Collects query parameters under unique names (:p0, :p1, ...).
 * Several filters used to share names like :created_before or :filler_id and
 * silently overwrote each other's values.
 */
class QueryParams {
  public readonly values: Record<string, any> = {};
  private counter = 0;

  add(value: any): string {
    const name = `p${this.counter++}`;
    this.values[name] = value;

    return `:${name}`;
  }

  addList(values: any[]): string {
    const name = `p${this.counter++}`;
    this.values[name] = values;

    return `:...${name}`;
  }
}

@Injectable()
export class DealService {
  constructor(
    @InjectRepository(Deal)
    private dealRepository: Repository<Deal>,
    @InjectRepository(DealFiller)
    private dealFillerRepository: Repository<DealFiller>,
    @InjectRepository(Company)
    private companyRepository: Repository<Company>,
    @InjectRepository(DealStageRecord)
    private dealStageRecordRepository: Repository<DealStageRecord>,
    private dataSource: DataSource,
    private userService: UserService,
    private helperService: HelperService,
    private dealStageService: DealStageService,
    private fillerService: FillerService,
    private triggerService: TriggerService,
    private eventEmitter: EventEmitter2,
  ) {}

  async fetchAll(query: SearchDealDto): Promise<PaginationResponseDto<Deal[]>> {
    const qb = this.applyFiltersToQb(
      this.dealRepository.createQueryBuilder('t0'),
      query,
    );

    return this.helperService.withPagination(
      this.helperService.withRelations(qb, DealListRelations, 't0'),
      query,
    );
  }

  /**
   * Adds WHERE conditions for every filter of SearchDealDto.
   *
   * Soft deleted deals are excluded by TypeORM itself (Deal has deleted_at).
   * Conditions on related rows (custom fields, tasks, contacts, agent,
   * company) are EXISTS sub-queries: all conditions of one group have to be
   * met by the same related row, and different groups do not interfere.
   */
  private applyFiltersToQb(
    qb: SelectQueryBuilder<Deal>,
    query: SearchDealDto,
  ): SelectQueryBuilder<Deal> {
    const params = new QueryParams();
    const where: string[] = [];

    if (query.label) {
      where.push(`t0.label ILIKE ${params.add(`%${query.label}%`)}`);
    }

    if (query.display_id) {
      where.push(`t0.display_id = ${params.add(query.display_id)}`);
    }

    where.push(
      ...this.dateRangeConditions(
        't0.created_at',
        query.created_after,
        query.created_before,
        params,
      ),
      ...this.dateRangeConditions(
        't0.closed_at',
        query.closed_after,
        query.closed_before,
        params,
      ),
    );

    if (query.stages && query.stages.length > 0) {
      where.push(`t0.stage_id IN (${params.addList(query.stages)})`);
    }

    if (query.created_by) {
      where.push(`t0.created_by = ${params.add(query.created_by)}`);
    }

    if (query.budget_from) {
      where.push(`t0.budget >= ${params.add(query.budget_from)}`);
    }

    if (query.budget_till) {
      where.push(`t0.budget <= ${params.add(query.budget_till)}`);
    }

    // Deal custom fields: every requested field has to match
    for (const filler of query.fillers ?? []) {
      where.push(
        this.fillerCondition('deal_filler', 'deal_id', 't0.id', filler, params),
      );
    }

    const taskCondition = this.taskFilterCondition(query.tasks, params);
    if (taskCondition) {
      where.push(taskCondition);
    }

    // Contacts linked to the deal: one contact has to satisfy all conditions
    if (query.ctr_agent) {
      const conditions = this.userConditions('cu', query.ctr_agent, params);

      if (conditions.length > 0) {
        where.push(
          `EXISTS (SELECT 1 FROM deal_user du INNER JOIN "user" cu ON cu.id = du."userId" ` +
            `WHERE du."dealId" = t0.id AND cu.deleted_at IS NULL AND ${conditions.join(' AND ')})`,
        );
      }
    }

    // Responsible employee
    if (query.agent) {
      const conditions = this.userConditions('au', query.agent, params);

      if (conditions.length > 0) {
        where.push(
          `EXISTS (SELECT 1 FROM "user" au WHERE au.id = t0.agent_id AND ${conditions.join(' AND ')})`,
        );
      }
    }

    // Company of the deal
    if (query.company) {
      const conditions: string[] = [];

      if (query.company.id) {
        conditions.push(`co.id = ${params.add(query.company.id)}`);
      }

      if (query.company.name) {
        conditions.push(
          `co.name ILIKE ${params.add(`%${query.company.name}%`)}`,
        );
      }

      conditions.push(
        ...this.dateRangeConditions(
          'co.created_at',
          query.company.created_after,
          query.company.created_before,
          params,
        ),
      );

      for (const filler of query.company.fillers ?? []) {
        conditions.push(
          this.fillerCondition(
            'company_filler',
            'company_id',
            'co.id',
            filler,
            params,
          ),
        );
      }

      if (conditions.length > 0) {
        where.push(
          `EXISTS (SELECT 1 FROM company co WHERE co.id = t0.company_id AND co.deleted_at IS NULL AND ${conditions.join(' AND ')})`,
        );
      }
    }

    if (where.length > 0) {
      qb = qb.andWhere(where.join(' AND '), params.values);
    }

    return qb;
  }

  /**
   * "before" given as a date without time (2025-04-30, that is what the date
   * picker sends) includes the whole day.
   */
  private dateRangeConditions(
    column: string,
    after: Date | string,
    before: Date | string,
    params: QueryParams,
  ): string[] {
    const conditions: string[] = [];

    if (after) {
      conditions.push(`${column} >= ${params.add(after)}`);
    }

    if (before) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(before))) {
        conditions.push(
          `${column} < (CAST(${params.add(before)} AS date) + 1)`,
        );
      } else {
        conditions.push(`${column} <= ${params.add(before)}`);
      }
    }

    return conditions;
  }

  /**
   * Condition "the owner has custom field <id> with a value like <value>"
   * for deal_filler / user_filler / company_filler tables.
   */
  private fillerCondition(
    table: 'deal_filler' | 'user_filler' | 'company_filler',
    ownerColumn: 'deal_id' | 'user_id' | 'company_id',
    ownerReference: string,
    filler: FillerDto,
    params: QueryParams,
  ): string {
    return (
      `EXISTS (SELECT 1 FROM ${table} fv WHERE fv.${ownerColumn} = ${ownerReference} ` +
      `AND fv.filler_id = ${params.add(filler.id)} ` +
      `AND fv.value ILIKE ${params.add(`%${filler.value}%`)})`
    );
  }

  private userConditions(
    alias: string,
    filter: SearchDealDto['agent'],
    params: QueryParams,
  ): string[] {
    const conditions: string[] = [];

    if (filter.id) {
      conditions.push(`${alias}.id = ${params.add(filter.id)}`);
    }

    if (filter.username) {
      conditions.push(
        `${alias}.username ILIKE ${params.add(`%${filter.username}%`)}`,
      );
    }

    conditions.push(
      ...this.dateRangeConditions(
        `${alias}.created_at`,
        filter.created_after,
        filter.created_before,
        params,
      ),
    );

    for (const filler of filter.fillers ?? []) {
      conditions.push(
        this.fillerCondition(
          'user_filler',
          'user_id',
          `${alias}.id`,
          filler,
          params,
        ),
      );
    }

    return conditions;
  }

  /**
   * Task filters are alternatives (OR): "no tasks" or "overdue" or
   * "has an open task in the period".
   */
  private taskFilterCondition(
    tasks: TaskTypes[],
    params: QueryParams,
  ): string | null {
    if (!tasks || tasks.length === 0) {
      return null;
    }

    const alternatives: string[] = [];
    const openTask = (condition: string): string =>
      `EXISTS (SELECT 1 FROM task tk WHERE tk.deal_id = t0.id AND tk.closed_at IS NULL AND ${condition})`;
    const overlaps = (start: Date, end: Date): string =>
      `(tk.start_time, tk.end_time) OVERLAPS (${params.add(start)}, ${params.add(end)})`;

    // Deals with no tasks
    if (tasks.includes(TaskTypes.NO_TASK)) {
      alternatives.push(
        `NOT EXISTS (SELECT 1 FROM task tk WHERE tk.deal_id = t0.id)`,
      );
    }

    // Deals with tasks that are overdue
    if (tasks.includes(TaskTypes.OVERDUE)) {
      alternatives.push(openTask(`tk.end_time < ${params.add(new Date())}`));
    }

    /**
     * If requested for tasks that has overlapping times with today and tomorrow
     * Combine the two
     */
    if (
      tasks.includes(TaskTypes.TOMORROW) &&
      tasks.includes(TaskTypes.TODAY)
    ) {
      const [start] = getTaskDateRange(TaskTypes.TODAY);
      const [, end] = getTaskDateRange(TaskTypes.TOMORROW);

      alternatives.push(openTask(overlaps(start, end)));
    }

    /**
     * Find the biggest range and apply.
     * ['today', 'this_week', 'this_month'] is the same as ['this_month']
     */
    const maxWeightTaskRangeType = this.helperService.getEnumWithMaxRange(tasks);
    if (TaskTypesToWeights.get(maxWeightTaskRangeType) > 0) {
      const [start, end] = getTaskDateRange(
        maxWeightTaskRangeType as Parameters<typeof getTaskDateRange>[0],
      );

      alternatives.push(openTask(overlaps(start, end)));
    }

    if (alternatives.length === 0) {
      return null;
    }

    return `(${alternatives.join(' OR ')})`;
  }

  /**
   * Returns null when the deal does not exist (or is deleted).
   */
  async getById(id: number, withRelations: boolean = false): Promise<Deal> {
    let relations = [];

    if (withRelations) {
      relations = [
        'stage',
        'agent',
        'agent.user_fillers',
        'agent.user_fillers.filler',
        'ctr_agents',
        'ctr_agents.user_fillers',
        'ctr_agents.user_fillers.filler',
        'ctr_agents.company',
        'company',
        'company.company_fillers',
        'company.company_fillers.filler',
        'deal_fillers',
        'deal_fillers.filler',
        'stage',
        'deal_products',
        'deal_products.product',
      ];
    }

    return this.dealRepository.findOne({
      where: { id },
      relations: relations,
    });
  }

  /**
   * Same as getById, but answers 404 for missing and deleted deals.
   */
  async getByIdOrFail(
    id: number,
    withRelations: boolean = false,
  ): Promise<Deal> {
    const deal = await this.getById(id, withRelations);

    if (!deal) {
      throw new NotFoundException(`Deal with id ${id} does not exist!`);
    }

    return deal;
  }

  async fetchDealStats(query: SearchDealDto): Promise<Record<string, any>> {
    const qb = this.applyFiltersToQb(
      this.dealRepository.createQueryBuilder('t0'),
      query,
    );

    // Deleted deals are not part of main_query: TypeORM adds "deleted_at IS NULL"
    qb.select('t0.id', 'id');

    const [sql, params] = qb.getQueryAndParameters();
    // Task times are stored in the server time zone, hence "now" comes from the app
    const now = `$${params.length + 1}`;

    const finalQuery = `
    WITH main_query AS (${sql})
    SELECT
      (SELECT COUNT(h1.id) FROM task h1 WHERE h1.deal_id IN (SELECT "id" FROM main_query) AND DATE_TRUNC('day', h1.created_at) = CURRENT_DATE) AS task_count_for_today,
      (SELECT COUNT(h2.id) FROM deal h2 WHERE NOT EXISTS(SELECT h3.id FROM task h3 WHERE h3.deal_id = h2.id) AND h2.id IN (SELECT "id" FROM main_query)) AS deals_without_tasks,
      (SELECT COUNT(DISTINCT h4.deal_id) FROM task h4 WHERE h4.deal_id IN (SELECT "id" FROM main_query) AND h4.closed_at IS NULL AND h4.end_time < ${now}) AS deals_with_overdue_tasks,
      (SELECT COUNT(h5.id) FROM deal h5 WHERE DATE_TRUNC('day', h5.created_at) = CURRENT_DATE AND h5.id IN (SELECT "id" FROM main_query)) AS new_deals_from_today,
      (SELECT COUNT(h6.id) FROM deal h6 WHERE DATE_TRUNC('day', h6.created_at) >= CURRENT_DATE - INTERVAL '1 day' AND DATE_TRUNC('day', h6.created_at) < CURRENT_DATE AND h6.id IN (SELECT "id" FROM main_query)) AS new_deals_from_yesterday
    `;

    return this.dataSource.query(finalQuery, [...params, new Date()]);
  }

  /**
   * PATCH /deals/:id/stage
   */
  async changeStage(
    id: number,
    stage_id: number,
    request: Request,
  ): Promise<void> {
    const deal = await this.helperService.getById(Deal, id, ['stage']);
    const originatedBy =
      await this.helperService.extractUserFromRequest(request);

    await this.moveDealToStage(deal, stage_id, originatedBy);
  }

  /**
   * The only place where the stage of an existing deal changes.
   * Used by PATCH /deals/:id/stage and by PATCH /deals/:id (deal_stage_id).
   *
   * Side effects: deal.last_stage_change, deal.closed_at (closing stages),
   * stage history record, triggers of the new stage, NEW_DEAL_STAGE event.
   * Does nothing at all when the deal is already in the requested stage.
   *
   * @param deal deal loaded with its `stage` relation
   * @returns true if the stage was changed
   */
  private async moveDealToStage(
    deal: Deal,
    stage_id: number,
    originatedBy: User,
  ): Promise<boolean> {
    // Do nothing if stage is the same
    if (deal.stage && deal.stage.id === stage_id) {
      return false;
    }

    const stage = await this.helperService.getById(DealStage, stage_id, [
      'triggers',
    ]);
    const oldStage = deal.stage ?? null;

    const closedStageNames = this.dealStageService.getClosedStageNames();

    // Add closed_at if the new stage is closed
    if (closedStageNames.includes(stage.name)) {
      deal.closed_at = new Date();
    }

    deal.stage = stage;
    deal.last_stage_change = new Date();
    await this.dealRepository.save(deal);

    await this.updateDealStageRecords(deal, stage);

    // immediate triggers run now, delayed and recurring ones are planned in trigger_run
    await this.triggerService.onDealEnteredStage(originatedBy, deal, stage);

    const eventData = new DealStageEventDto();
    eventData.deal = deal;
    eventData.new_stage = deal.stage;
    eventData.old_stage = oldStage;
    eventData.originated_by = originatedBy;

    this.eventEmitter.emit(EventTypes.NEW_DEAL_STAGE.toString(), eventData);

    return true;
  }

  /**
   * Closes the previous history record (how long the deal stayed in the
   * stage) and opens a new one.
   *
   * Duration is calculated by the database: created_at is filled by the
   * database clock, and comparing it with the application clock gave an
   * error equal to the time zone offset.
   */
  private async updateDealStageRecords(
    deal: Deal,
    stage: DealStage,
  ): Promise<void> {
    const lastDealStageRecord = await this.dealStageRecordRepository
      .createQueryBuilder('t0')
      .where('t0.deal_id = :deal_id', { deal_id: deal.id })
      .orderBy('t0.created_at', 'DESC')
      .addOrderBy('t0.id', 'DESC')
      .limit(1)
      .getOne();

    if (lastDealStageRecord) {
      await this.dealStageRecordRepository
        .createQueryBuilder()
        .update(DealStageRecord)
        .set({
          moved_after_minutes: () =>
            'GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - "created_at")) / 60))',
        })
        .where('id = :id', { id: lastDealStageRecord.id })
        .execute();
    }

    await this.createDealStageRecord(deal, stage);
  }

  async create(
    creator_id: number,
    data: CreateDealDto,
    // skipRequiredFields: deals that arrive from a channel (Telegram) carry no custom fields
    options: { skipRequiredFields?: boolean } = {},
  ): Promise<Deal> {
    const userIds = [data.agent_id, creator_id, ...data.ctr_agent_ids];
    const users = await this.userService.findByIds(userIds);
    // HashMap with ids linked to entities
    const usersMap = this.helperService.createHashMap<User>(users);

    // Company is optional: deals created from mail / telegram have none
    const company = data.company_id
      ? await this.findCompanyForDeal(data.company_id)
      : null;

    // Assign deal properties
    const newDeal = new Deal();
    newDeal.label = data.label;
    newDeal.budget = data.budget;
    newDeal.agent = usersMap.get(data.agent_id);
    newDeal.ctr_agents = data.ctr_agent_ids.map((ctr_agent_id) =>
      usersMap.get(ctr_agent_id),
    );
    newDeal.created_by = usersMap.get(creator_id);
    if (data.stage_id) {
      newDeal.stage = await this.helperService.getById(
        DealStage,
        data.stage_id,
      );
    } else {
      newDeal.stage = await this.dealStageService.getDefaultStage();
    }
    newDeal.company = company;

    // Create necessary deal fillers
    if (!options.skipRequiredFields) {
      await this.fillerService.assertRequiredFilled(
        FillableTablesEnum.DEAL,
        data.fillers,
      );
    }
    const fillerIdsToEntities = await this.fillerService.getFillersHashMap(
      data.fillers,
    );
    newDeal.deal_fillers = this.createDealFillers(
      fillerIdsToEntities,
      data.fillers,
    );

    newDeal.deal_products = await this.linkProductsToDeal(data);

    // the number (and "#<number>" for a deal without a name) is given while saving
    const savedDeal = await this.helperService.saveNewDeal(
      newDeal,
      data.display_id,
    );
    await this.createDealStageRecord(savedDeal, savedDeal.stage);

    this.emitNecessaryEventsForDealCreation(savedDeal);

    // "после создания в этапе": the triggers of the first stage (errors are logged, never thrown)
    await this.triggerService.onDealEnteredStage(
      savedDeal.created_by ?? savedDeal.agent,
      savedDeal,
      savedDeal.stage,
    );

    return savedDeal;
  }

  private async createDealStageRecord(
    deal: Deal,
    stage: DealStage,
  ): Promise<void> {
    if (!stage) {
      return;
    }

    const record = new DealStageRecord();
    record.deal = deal;
    record.stage = stage;

    await this.dealStageRecordRepository.save(record);
  }

  private async linkProductsToDeal(
    data: CreateDealDto,
  ): Promise<DealProduct[]> {
    if (data.products.length === 0) {
      return [];
    }

    const productsToEntities = await this.fetchProductByIds(
      data.products.map((data) => data.product_id),
    );
    const dealProductRelations: DealProduct[] = [];

    // Link Products
    data.products.forEach((productData) => {
      const newRelation = new DealProduct();
      newRelation.product = productsToEntities.get(productData.product_id);
      newRelation.quantity = productData.quantity;
      newRelation.price = productData.price;

      dealProductRelations.push(newRelation);
    });

    return dealProductRelations;
  }

  private async fetchProductByIds(
    ids: number[],
  ): Promise<Map<number, Product>> {
    const uniqueIds = [...new Set(ids)];

    if (uniqueIds.length === 0) {
      return new Map<number, Product>();
    }

    const products = await this.helperService.getByIds(Product, uniqueIds);

    return this.helperService.createHashMap(products);
  }

  /**
   * PATCH /deals/:id
   *
   * Only the fields present in the request are changed. Everything is
   * validated before the first write, so a wrong id (stage, user, company,
   * product, custom field) answers 404 and leaves the deal as it was.
   *
   * Relations that are not being changed are deliberately NOT loaded into the
   * saved entity: a relation to a soft deleted row loads as null and saving it
   * would erase the link.
   */
  async update(
    id: number,
    request: Request,
    data: UpdateDealDto,
  ): Promise<void> {
    const deal = await this.getByIdOrFail(id);
    const originatedBy =
      await this.helperService.extractUserFromRequest(request);

    /**
     * Validation / loading
     */
    if (data.deal_stage_id !== undefined) {
      await this.helperService.getById(DealStage, data.deal_stage_id);
    }

    const userIds = [
      ...(data.agent_id !== undefined ? [data.agent_id] : []),
      ...(data.ctr_agent_ids ?? []),
    ];
    const users =
      userIds.length > 0 ? await this.userService.findByIds(userIds) : [];
    const userMap = this.helperService.createHashMap<User>(users);

    const company =
      data.company_id !== undefined
        ? await this.findCompanyForDeal(data.company_id, id)
        : undefined;

    // Data that will be fed to event emitter
    const eventData: FieldValueEventDto = {
      originated_by: originatedBy,
      deal: deal,
      fields: [],
      fields_of: FieldsOf.DEAL,
    };

    let productChanges: {
      toSave: DealProduct[];
      toRemove: DealProduct[];
    } = null;

    if (data.products !== undefined) {
      const [toSave, toRemove, updatedFields] = await this.diffLinkedProducts(
        deal,
        data.products,
      );
      productChanges = { toSave, toRemove };
      eventData.fields.push(...updatedFields);
    }

    // Deal fillers that need to be updated
    const fillersToUpdate = data.fillers ?? [];
    const dealFillers =
      fillersToUpdate.length > 0
        ? await this.findDealFillersByIds(
            fillersToUpdate.map((filler) => filler.deal_filler_id),
          )
        : [];
    // Hash Map that links dealFiller ids to values
    const dealFillerIdsToValues = this.createDealFillerHashMap(fillersToUpdate);

    // Hash Map that links filler ids to entities
    const fillersToCreate = data.fillers_create ?? [];
    const fillerIdsToEntities =
      fillersToCreate.length > 0
        ? await this.fillerService.getFillersHashMap(fillersToCreate)
        : new Map<number, Filler>();

    /**
     * Assign the values
     */
    if (data.label !== undefined) {
      eventData.fields.push(new Field('label', data.label, deal.label));
      deal.label = data.label;
    }

    if (data.budget !== undefined) {
      eventData.fields.push(
        new Field('budget', `${data.budget}`, `${deal.budget}`),
      );
      deal.budget = data.budget;
    }

    if (data.agent_id !== undefined) {
      deal.agent = userMap.get(data.agent_id);
    }

    if (data.ctr_agent_ids !== undefined) {
      // Create CtrAgent array out of their ids
      deal.ctr_agents = [...new Set(data.ctr_agent_ids)].map((ctr_agent_id) =>
        userMap.get(ctr_agent_id),
      );
    }

    if (company !== undefined) {
      deal.company = company;
    }

    // Update necessary deal fillers
    dealFillers.forEach((dealFiller) => {
      const newFillerValue = dealFillerIdsToValues.get(dealFiller.id);

      if (dealFiller.value !== newFillerValue) {
        this.fillerService.assertNotBlank(dealFiller.filler, newFillerValue);
        eventData.fields.push({
          name: dealFiller.filler.field,
          old_value: dealFiller.value,
          new_value: newFillerValue,
        });

        dealFiller.value = newFillerValue;
      }
    });

    // Create necessary deal fillers
    fillersToCreate.forEach((dealFillerData) => {
      const filler = fillerIdsToEntities.get(dealFillerData.filler_id);
      const newDealFiller = new DealFiller();
      newDealFiller.filler = filler;
      newDealFiller.value = dealFillerData.value;
      newDealFiller.deal = deal;
      dealFillers.push(newDealFiller);

      eventData.fields.push({
        name: filler.field,
        old_value: null,
        new_value: dealFillerData.value,
      });
    });

    /**
     * Writes
     */
    await this.dealRepository.save(deal);

    if (dealFillers.length > 0) {
      await this.dealFillerRepository.save(dealFillers);
    }

    if (productChanges) {
      const dealProductRepository = this.dataSource.getRepository(DealProduct);

      if (productChanges.toRemove.length > 0) {
        await dealProductRepository.remove(productChanges.toRemove);
      }

      if (productChanges.toSave.length > 0) {
        await dealProductRepository.save(productChanges.toSave);
      }
    }

    this.eventEmitter.emit(EventTypes.NEW_FIELD_VALUE.toString(), eventData);

    /**
     * Stage: the same code path as PATCH /deals/:id/stage.
     * Nothing is written to the stage history if the stage is the same.
     */
    if (data.deal_stage_id !== undefined) {
      const dealWithStage = await this.helperService.getById(Deal, id, [
        'stage',
      ]);

      await this.moveDealToStage(
        dealWithStage,
        data.deal_stage_id,
        originatedBy,
      );
    }
  }

  /**
   * Compares products linked to the deal with the requested list.
   *
   * @returns relations to insert/update, relations to delete and the list of
   *          changed fields (later used to emit events)
   */
  private async diffLinkedProducts(
    deal: Deal,
    data: LinkProductsDto[],
  ): Promise<[DealProduct[], DealProduct[], Field[]]> {
    // withDeleted: a product may have been soft deleted after it was linked
    const existingRelations = await this.dataSource
      .getRepository(DealProduct)
      .find({
        where: { deal: { id: deal.id } },
        relations: ['product'],
        withDeleted: true,
        order: { id: 'ASC' },
      });

    // Maps product ids to existing DealProduct relations
    const existingByProductId = new Map<number, DealProduct[]>();
    const toRemove: DealProduct[] = [];

    existingRelations.forEach((relation) => {
      if (!relation.product) {
        toRemove.push(relation);
        return;
      }

      const list = existingByProductId.get(relation.product.id) ?? [];
      list.push(relation);
      existingByProductId.set(relation.product.id, list);
    });

    const newProductIds = data
      .map((requestedData) => requestedData.product_id)
      .filter((product_id) => !existingByProductId.has(product_id));
    const productsMap = await this.fetchProductByIds(newProductIds);

    const toSave: DealProduct[] = [];
    const updatedFields: Field[] = [];

    data.forEach((requestedData) => {
      const existingRelation = existingByProductId
        .get(requestedData.product_id)
        ?.shift();

      // If Relation exists, update it
      if (existingRelation) {
        // bigint columns are read from the database as strings
        if (Number(existingRelation.quantity) !== requestedData.quantity) {
          updatedFields.push(
            new Field(
              'quantity',
              requestedData.quantity.toString(),
              existingRelation.quantity.toString(),
            ),
          );
        }
        existingRelation.quantity = requestedData.quantity;

        if (Number(existingRelation.price) !== requestedData.price) {
          updatedFields.push(
            new Field(
              'price',
              requestedData.price.toString(),
              existingRelation.price.toString(),
            ),
          );
        }
        existingRelation.price = requestedData.price;

        toSave.push(existingRelation);
        return;
      }

      // If not create it
      const newRelation = new DealProduct();
      newRelation.deal = deal;
      newRelation.product = productsMap.get(requestedData.product_id);
      newRelation.price = requestedData.price;
      newRelation.quantity = requestedData.quantity;

      toSave.push(newRelation);
    });

    // Relations that are not in the request anymore
    existingByProductId.forEach((leftovers) => toRemove.push(...leftovers));

    return [toSave, toRemove, updatedFields];
  }

  async getDealFilters(): Promise<DealFilter[]> {
    return this.helperService.getDealColumns();
  }

  /**
   * DELETE /deals/:id moves the deal to the trash (soft delete: deleted_at, deleted_by).
   * It disappears from lists, the kanban, statistics and GET /deals/:id (404); its tasks
   * from task lists and counters. Nothing linked to the deal is removed, so restoring it
   * (DealTrashService) brings back the stage, history, tasks, files, products and fields.
   *
   * Allowed by the delete permission of the user (DealAccess): 403 for a deal out of scope.
   */
  async delete(id: number, user: AuthUser): Promise<void> {
    await this.getByIdOrFail(id);

    const condition = new DealAccess(user).deleteCondition('t0');
    const allowed = await this.dealRepository
      .createQueryBuilder('t0')
      .where('t0.id = :delete_deal_id', { delete_deal_id: id })
      .andWhere(condition.sql, condition.params)
      .getCount();

    if (allowed === 0) {
      throw new ForbiddenException(`No right to delete deal ${id}`);
    }

    await this.dealRepository
      .createQueryBuilder()
      .update(Deal)
      .set({
        deleted_at: () => 'CURRENT_TIMESTAMP',
        deleted_by: { id: user.sub },
      })
      .where('id = :id AND deleted_at IS NULL', { id })
      .execute();
  }

  async deleteDealFiller(id: number): Promise<void> {
    const result = await this.dealFillerRepository.delete(id);

    if (result.affected === 0) {
      throw new NotFoundException();
    }

    return;
  }

  private emitNecessaryEventsForDealCreation(deal: Deal): void {
    // Emit NEW_DEAL event
    const dealEventData: DealEventDto = { deal: deal };
    this.eventEmitter.emit(EventTypes.NEW_DEAL.toString(), dealEventData);

    // Emit NEW_CTR_AGENT events
    deal.ctr_agents.forEach((ctr_agent) => {
      const ctrAgentEventData: CtrAgentEventDto = {
        ctr_agent: ctr_agent,
        deal: deal,
        originated_by: deal.created_by,
      };
      this.eventEmitter.emit(
        EventTypes.NEW_CTR_AGENT.toString(),
        ctrAgentEventData,
      );
    });

    // Emit NEW_COMPANY event
    if (deal.company) {
      const companyEventData: CompanyEventDto = {
        company: deal.company,
        deal: deal,
        originated_by: deal.created_by,
      };
      this.eventEmitter.emit(
        EventTypes.NEW_COMPANY.toString(),
        companyEventData,
      );
    }

    // Emit NEW_PRODUCT event
    const productEvents: ProductEventDto[] = [];
    deal.deal_products.forEach((deal_product) => {
      const newProductEventDto = new ProductEventDto();
      // deal_product.deal is not filled by a cascade save, the event lost its deal
      newProductEventDto.deal = deal;
      newProductEventDto.originated_by = deal.created_by;
      newProductEventDto.deal_product = deal_product;

      productEvents.push(newProductEventDto);
    });

    this.eventEmitter.emit(EventTypes.NEW_PRODUCT.toString(), productEvents);
  }

  private createDealFillerHashMap(
    data: UpdateDealFillerDto[],
  ): Map<number, string> {
    const hashMap = new Map<number, string>();

    data.forEach((dealFiller) => {
      hashMap.set(dealFiller.deal_filler_id, dealFiller.value);
    });

    return hashMap;
  }

  private async findDealFillersByIds(ids: number[]): Promise<DealFiller[]> {
    const dealFillers = await this.dealFillerRepository.find({
      where: { id: In(ids) },
      relations: ['filler'],
    });

    if (dealFillers.length !== ids.length) {
      this.fillerService.throwExceptionWithNonExistingFillers(ids, dealFillers);
    }

    return dealFillers;
  }

  /**
   * A soft deleted company is accepted only when the deal is already linked
   * to it (so that such a deal can still be edited without losing the link).
   */
  private async findCompanyForDeal(
    company_id: number,
    deal_id: number = null,
  ): Promise<Company> {
    let company = await this.companyRepository.findOne({
      where: { id: company_id },
      withDeleted: true,
    });

    if (company && company.deleted_at) {
      const rows: { company_id: number }[] = deal_id
        ? await this.dataSource.query(
            'SELECT company_id FROM deal WHERE id = $1',
            [deal_id],
          )
        : [];

      if (rows.length === 0 || Number(rows[0].company_id) !== company.id) {
        company = null;
      }
    }

    if (!company) {
      throw new NotFoundException(
        `Company with id ${company_id} does not exist!`,
      );
    }

    return company;
  }

  private createDealFillers(
    fillers: Map<number, Filler>,
    data: ChildFiller[],
  ): DealFiller[] {
    const newDealFillers = [];

    data.forEach((filler) => {
      const newDealFiller = new DealFiller();
      newDealFiller.filler = fillers.get(filler.filler_id);
      newDealFiller.value = filler.value;

      newDealFillers.push(newDealFiller);
    });

    return newDealFillers;
  }
}
