import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Company } from './company.entity';
import { COMPANY_REQUISITE_FIELDS } from './dto/company.requisites.dto';
import { DataSource, In, Repository, SelectQueryBuilder } from 'typeorm';
import { CompanyFiller } from './company.filler.entity';
import {
  CreateCompanyDto,
  CreateCompanyFillerDto,
} from './dto/create.company.dto';
import { FillableTablesEnum, Filler } from '../filler/filler.entity';
import { FillerService } from '../filler/filler.service';
import {
  CreateCompanyFlatDto,
  FlatCompanyFillerDto,
} from './dto/update.company.dto';
import { Field, FieldValueEventDto } from '../events/dto/field.value.event.dto';
import { HelperService } from '../helper/helper.service';
import { Request } from 'express';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventTypes, FieldsOf } from '../events/event.entity';
import {
  CompareDealCountPeriod,
  RawCompanyResult,
  SearchCompanyDto,
} from './dto/search.company.dto';
import {
  PaginationRequestDto,
  PaginationResponseDto,
} from '../helper/dto/pagination.dto';
import { Deal } from '../deal/deal.entity';
import { RoleEnum, User } from 'src/user/user.entity';
import { UserService } from 'src/user/user.service';
import { FileService } from 'src/file/file.service';

@Injectable()
export class CompanyService {
  private readonly logger = new Logger(CompanyService.name);

  constructor(
    @InjectRepository(Company)
    private companyRepository: Repository<Company>,
    @InjectRepository(CompanyFiller)
    private companyFillerRepository: Repository<CompanyFiller>,
    @InjectRepository(Deal)
    private dealRepository: Repository<Deal>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private fileService: FileService,
    private userService: UserService,
    private fillerService: FillerService,
    private helperService: HelperService,
    private eventEmitter: EventEmitter2,
    private dataSource: DataSource,
  ) { }

  async search(query: SearchCompanyDto): Promise<PaginationResponseDto<any>> {
    /**
     * Setup
     */
    this.performAdditionalSearchCompanyValidation(query);
    // eslint-disable-next-line prefer-const
    let [sortBy, sortByType] = this.helperService.validateAndGetSortOptions(
      query,
      [
        'deal_count',
        'live_time_value',
        'id',
        'name',
        'email',
        'phone',
        'is_old',
        'updated_at',
        'deleted_at',
        'created_at',
        'deal_count_this_period',
        'deal_count_previous_period',
      ],
    );

    if (!query.compare_deal_count_period) {
      query.compare_deal_count_period = CompareDealCountPeriod.MONTH;
    }

    /**
     * Main query filtration logic
     */
    let qb = this.companyRepository
      .createQueryBuilder('t0')
      .where('t0.deleted_at IS NULL');

    qb = qb
      .addSelect('COUNT(t1.id)', 'deal_count')
      .addSelect('SUM(t1.budget)', 'live_time_value');

    qb = this.addPeriodCountComparisonColumns(qb, query);

    if (query.name) {
      qb = qb.where('t0.name ILIKE :name', { name: `%${query.name}%` });
    }

    if (query.is_old) {
      qb = qb.andWhere('t0.is_old = :is_old', {
        is_old: query.is_old.toLowerCase() === 'true',
      });
    }

    qb = this.addPeriodFiltersToCompanyDeals(query, qb);
    qb = qb.groupBy('t0.id');

    /**
     * Final query
     */
    let whereClause = '';
    const subquery =
      'SELECT a1.id FROM deal as a1 WHERE a1.company_id = main_query.t0_id and a1.created_at < main_query.min_created_at';

    if (query.had_deals_before) {
      if (query.had_deals_before.toLowerCase() === 'true') {
        whereClause = `WHERE EXISTS (${subquery})`;
      } else {
        whereClause = `WHERE NOT EXISTS (${subquery})`;
      }
    }

    const [sql, parameters] = qb.getQueryAndParameters();

    // Modify sort by
    if (
      ![
        'deal_count_this_period',
        'deal_count_previous_period',
        'live_time_value',
        'deal_count',
      ].includes(sortBy)
    ) {
      sortBy = `main_query.t0_${sortBy}`;
    } else {
      sortBy = `"${sortBy}"`;
    }

    const rawSql = `
      WITH main_query AS (${sql})
      SELECT *,  COUNT(*) OVER() as total_count from main_query
      ${whereClause}
      ORDER BY ${sortBy} ${sortByType}
      LIMIT $${parameters.length + 1}
      OFFSET $${parameters.length + 2}
      `;

    /**
     * Add additional parameters
     */
    parameters.push(query.limit ?? 25);
    parameters.push(query.skip ?? 0);

    const result = await this.dataSource.query<RawCompanyResult[]>(
      rawSql,
      parameters,
    );

    /**
     * Load relationships
     */
    const response = await this.prepareSearchCompanyResponse(
      result.map((row) => row.t0_id),
      query,
      result.length > 0 ? +result[0].total_count : 0,
    );

    if (response.data.length == 0) {
      return response;
    }

    return this.sendSearchCompanyResponse(response, result);
  }

  private addPeriodCountComparisonColumns(
    qb: SelectQueryBuilder<Company>,
    query: SearchCompanyDto,
  ): SelectQueryBuilder<Company> {
    switch (query.compare_deal_count_period) {
      case CompareDealCountPeriod.QUARTER:
        qb = qb
          .addSelect(
            '(SELECT COUNT(*) FROM deal WHERE company_id = t0.id AND EXTRACT(QUARTER FROM t0.created_at) = EXTRACT(QUARTER FROM CURRENT_DATE))',
            'deal_count_this_period',
          )
          .addSelect(
            '(SELECT COUNT(*) FROM deal WHERE company_id = t0.id AND EXTRACT(QUARTER FROM t0.created_at) = EXTRACT(QUARTER FROM CURRENT_DATE) - 1)',
            'deal_count_previous_period',
          );
        break;
      case CompareDealCountPeriod.YEAR:
        qb = qb
          .addSelect(
            '(SELECT COUNT(*) FROM deal WHERE company_id = t0.id AND EXTRACT(YEAR FROM t0.created_at) = EXTRACT(YEAR FROM CURRENT_DATE))',
            'deal_count_this_period',
          )
          .addSelect(
            '(SELECT COUNT(*) FROM deal WHERE company_id = t0.id AND EXTRACT(YEAR FROM t0.created_at) = EXTRACT(YEAR FROM CURRENT_DATE) - 1)',
            'deal_count_previous_period',
          );
        break;
      default:
        qb = qb
          .addSelect(
            '(SELECT COUNT(*) FROM deal WHERE company_id = t0.id AND EXTRACT(MONTH FROM t0.created_at) = EXTRACT(MONTH FROM CURRENT_DATE))',
            'deal_count_this_period',
          )
          .addSelect(
            '(SELECT COUNT(*) FROM deal WHERE company_id = t0.id AND EXTRACT(MONTH FROM t0.created_at) = EXTRACT(MONTH FROM CURRENT_DATE) - 1)',
            'deal_count_previous_period',
          );
    }

    return qb;
  }

  /**
   * Additional custom validations
   */
  private performAdditionalSearchCompanyValidation(
    query: SearchCompanyDto,
  ): void {
    if (query.had_deals_before) {
      if (
        !query.with_deals_at_period_start &&
        !query.with_deals_at_period_end
      ) {
        throw new BadRequestException([
          `had_deals_before can only be set when at least one of periods are set`,
        ]);
      }
    }
  }

  /**
   * Load relationships
   */
  private prepareSearchCompanyResponse(
    ids: number[],
    query: SearchCompanyDto,
    count: number = 0,
  ): Promise<PaginationResponseDto<Company[]>> {
    return this.helperService.withPagination(
      this.helperService.withRelations(
        this.companyRepository.createQueryBuilder('t0').whereInIds(ids),
        ['company_fillers', 'company_fillers.filler', 'created_by'],
      ),
      query,
      't0',
      count,
      true,
      true,
    );
  }

  /**
   * Fill response with additional data
   */
  private async sendSearchCompanyResponse(
    response: PaginationResponseDto<Company[]>,
    result: RawCompanyResult[],
  ): Promise<PaginationResponseDto<any>> {
    const data = [];
    const companyMap = this.helperService.createHashMap(response.data);

    for (const row of result) {
      if (!companyMap.has(row.t0_id)) {
        continue;
      }

      const company = companyMap.get(row.t0_id);

      data.push({
        id: company.id,
        name: company.name,
        email: company.email,
        phone: company.phone,
        is_old: company.is_old,
        updated_at: company.updated_at,
        deleted_at: company.deleted_at,
        created_at: company.created_at,
        company_fillers: company.company_fillers,
        created_by: company.created_by,
        deal_count: row.deal_count,
        live_time_value: row.live_time_value,
        deal_count_this_period: row.deal_count_this_period,
        deal_count_previous_period: row.deal_count_previous_period,
      });
    }
    await this.fillContactsIntoList(data);

    response.data = data;

    return response;
  }

  private addPeriodFiltersToCompanyDeals(
    query: SearchCompanyDto,
    qb: SelectQueryBuilder<Company>,
  ): SelectQueryBuilder<Company> {
    qb = qb
      .leftJoin('t0.deals', 't1')
      .addSelect('min(t1.created_at) as min_created_at');

    return this.addPeriodFiltersToDeals(query, qb, 't1');
  }

  private addPeriodFiltersToDeals<T>(
    query: SearchCompanyDto,
    qb: SelectQueryBuilder<T>,
    alias: string = 't0',
  ): SelectQueryBuilder<T> {
    if (!query.with_deals_at_period_start && !query.with_deals_at_period_end) {
      return qb;
    }

    if (query.with_deals_at_period_start && query.with_deals_at_period_end) {
      qb = qb.andWhere(
        `(${alias}.created_at, ${alias}.closed_at) OVERLAPS (:period_start, :period_end)`,
        {
          period_start: query.with_deals_at_period_start,
          period_end: query.with_deals_at_period_end,
        },
      );

      return qb;
    }

    if (query.with_deals_at_period_start && !query.with_deals_at_period_end) {
      qb = qb.andWhere(
        `(${alias}.closed_at > :period_start or ${alias}.closed_at IS NULL)`,
        {
          period_start: query.with_deals_at_period_start,
        },
      );

      return qb;
    }

    qb = qb.andWhere(`${alias}.created_at < :period_end`, {
      period_end: query.with_deals_at_period_end,
    });

    return qb;
  }

  /**
   * The primary contact of a company: the one chosen, else its only contact. When the
   * company has no phone or email of its own, the primary contact's are shown as the
   * company's (`phone_from_contact` / `email_from_contact` say so), so a company made
   * from a person's business card or a Telegram chat is not left without them.
   */
  private applyPrimaryContact(company: Company & Record<string, any>): void {
    const contacts = (company.users ?? []).filter((u) => !u.deleted_at);
    const primary =
      (company.primary_contact && contacts.find((u) => u.id === company.primary_contact.id)) ||
      (contacts.length === 1 ? contacts[0] : null);
    company.primary_contact_id = primary?.id ?? null;
    company.phone_from_contact = false;
    company.email_from_contact = false;
    if (!primary) return;
    if (!company.phone && primary.phone) {
      company.phone = primary.phone;
      company.phone_from_contact = primary.username;
    }
    if (!company.email && primary.email) {
      company.email = primary.email;
      company.email_from_contact = primary.username;
    }
  }

  /** The list: phone / email of the primary (or only) contact for companies without their own. */
  private async fillContactsIntoList(rows: { id: number; phone: string; email: string }[]): Promise<void> {
    const ids = rows.filter((r) => !r.phone || !r.email).map((r) => r.id);
    if (ids.length === 0) return;
    const found: { company_id: number; phone: string; email: string }[] = await this.dataSource.query(
      `SELECT c.id AS company_id, u.phone, u.email
         FROM company c
         JOIN "user" u ON u.deleted_at IS NULL AND u.role = 'ctr_agent' AND u.company_id = c.id
          AND (u.id = c.primary_contact_id OR (c.primary_contact_id IS NULL AND
               (SELECT count(*) FROM "user" x WHERE x.company_id = c.id AND x.role = 'ctr_agent' AND x.deleted_at IS NULL) = 1))
        WHERE c.id = ANY($1)`,
      [ids],
    );
    const byCompany = new Map(found.map((f) => [Number(f.company_id), f]));
    for (const row of rows) {
      const contact = byCompany.get(row.id);
      if (!contact) continue;
      if (!row.phone && contact.phone) row.phone = contact.phone;
      if (!row.email && contact.email) row.email = contact.email;
    }
  }

  async getById(id: number): Promise<any> {
    const company = await this.helperService.getById(Company, id, [
      'company_fillers',
      'company_fillers.filler',
      'users',
      'users.user_fillers',
      'created_by',
      'primary_contact',
    ]);

    if (company) {
      this.applyPrimaryContact(company);
      company['fillers'] = company.company_fillers.map((filler) => {
        return {
          id: filler.id,
          value: filler.value,
          filler_id: filler.filler.id,
        };
      });

      (company as any).users = company.users.map((user) => {
        return {
          id: user.id,
          username: user.username,
          email: user.email,
          phone: user.phone,
          fillers: user.user_fillers.map((filler) => {
            return {
              id: filler.id,
              value: filler.value,
            };
          }),
        };
      });

      delete company['company_fillers'];
      delete (company as any).primary_contact;

      // a company made by a channel (bot, card photo) or by a removed user has no author
      (company as any)['created_by'] = company.created_by
        ? {
            id: company.created_by.id,
            username: company.created_by.username,
            email: company.created_by.email,
          }
        : null;
    }

    return company;
  }

  async fetchSourceOfAgent(
    company_id: number,
    agent_id: number,
    query: PaginationRequestDto,
  ): Promise<Record<string, any>> {
    // A contact without a company, or of another company, used to end in a
    // 500 (`user.company.id` of null). The deals come from the ManyToMany
    // relation instead of a hand-written join on the deal_user table.
    const user = await this.userRepository.findOne({
      where: { id: agent_id },
      relations: ['company', 'linked_deals'],
    });

    if (!user || user.role !== RoleEnum.CTR_AGENT) {
      throw new NotFoundException(`Contact with id ${agent_id} does not exist!`);
    }

    if (!user.company || user.company.id !== company_id) {
      throw new HttpException(
        'Contact does not belong to this company',
        HttpStatus.BAD_REQUEST,
      );
    }

    const filesData = [];

    // All files of every deal the contact takes part in (before: one path per deal)
    for (const deal of user.linked_deals ?? []) {
      const files = await this.fileService.fetchSavedFiles(deal.id, {
        limit: query.limit,
        skip: query.skip,
      } as PaginationRequestDto);

      files.data.forEach((file) => {
        filesData.push({
          deal: deal.id,
          deal_label: deal.label,
          path: file.path,
          name: file.name,
        });
      });
    }

    // Getting call recording of agent
    const recordings = await this.dataSource
      .createQueryBuilder()
      .select('r.path AS path')
      .from('recording', 'r')
      .where('r.user_id = :userId', { userId: agent_id })
      .limit(query.limit ? query.limit : 25)
      .offset(query.skip ? query.skip : 0)
      .getRawMany();

    return { files: filesData, recordings };
  }

  /**
   * Names of the required custom fields (company and contacts) that `data`
   * leaves empty. The Telegram bot shows them as a warning: a company card has
   * no "Код Клиента", so the bot creates the company without them.
   */
  async missingRequiredFields(data: CreateCompanyDto): Promise<string[]> {
    const names = (
      await this.fillerService.missingRequired(
        FillableTablesEnum.COMPANY,
        data.fillers ?? [],
      )
    ).map((filler) => filler.field);
    for (const agent of data.users ?? []) {
      for (const filler of await this.fillerService.missingRequired(
        FillableTablesEnum.USER,
        (agent as any).fillers ?? [],
      )) {
        names.push(`${filler.field} (${agent.username})`);
      }
    }
    return names;
  }

  async create(
    data: CreateCompanyDto,
    request: Request,
    options: { skipRequiredFields?: boolean } = {},
  ): Promise<Company> {
    // Checking company if it exists
    const company = await this.companyRepository
      .createQueryBuilder('company')
      .where('company.name = :name', { name: data.name.trim() })
      .getOne();

    if (company) {
      throw new BadRequestException(
        `Company with name ${data.name} already exists!`,
      );
    }

    // We gotta iterate over agents due to creating company if we don't
    for (const agent of data.users ?? []) {
      // findOneBy({ email: undefined }) has no condition and matches any user
      if (!agent.email) continue;
      const ctr_agent = await this.userRepository.findOneBy({
        email: agent.email,
      });

      if (ctr_agent) {
        throw new BadRequestException(
          `ctr_agent with email ${ctr_agent.email} already exists!`,
        );
      }
    }

    if (!options.skipRequiredFields) {
      await this.fillerService.assertRequiredFilled(
        FillableTablesEnum.COMPANY,
        data.fillers,
      );
      for (const agent of data.users ?? []) {
        await this.fillerService.assertRequiredFilled(
          FillableTablesEnum.USER,
          (agent as any).fillers ?? [],
        );
      }
    }

    const newCompany = new Company();
    newCompany.name = data.name;
    newCompany.phone = data.phone;
    newCompany.email = data.email;
    newCompany.is_old = data.is_old;
    for (const field of COMPANY_REQUISITE_FIELDS) {
      newCompany[field] = data[field] ?? null;
    }
    newCompany.created_by =
      await this.helperService.extractUserFromRequest(request);

    if (data.fillers.length !== 0) {
      const fillers = await this.fillerService.getFillersHashMap(data.fillers);

      newCompany.company_fillers = this.createCompanyFillers(
        fillers,
        data.fillers,
      );
    }

    try {
      const result = await this.companyRepository.save(newCompany);

      const savedCompany = await this.companyRepository.findOneBy({
        id: result.id,
      });

      let primaryContact: User | null = null;
      for (const agent of data.users ?? []) {
        const newCtrAgent = new User();
        newCtrAgent.username = agent.username;
        newCtrAgent.email = agent.email;
        newCtrAgent.role = RoleEnum.CTR_AGENT;
        newCtrAgent.company = savedCompany;
        newCtrAgent.phone = agent.phone;
        newCtrAgent.created_by =
          await this.helperService.extractUserFromRequest(request);

        // The contact's own custom fields (e.g. "Должность"). This used to
        // pass the company's fields, so contacts got company values and lost theirs.
        const agentFillers = ((agent as any).fillers ?? []).filter(
          (f: { filler_id?: number; value?: string }) => f?.filler_id && f.value,
        );
        newCtrAgent.user_fillers = agentFillers.length
          ? this.userService.createUserFillers(
              await this.fillerService.getFillersHashMap(agentFillers),
              agentFillers,
            )
          : [];

        const savedContact = await this.userRepository.save(newCtrAgent);
        primaryContact = primaryContact ?? savedContact;
      }

      // the first contact is the primary one; without a phone / email of its own the
      // company takes the contact's (a card or a chat gives only the person's)
      if (primaryContact) {
        // an update by id, not save(): the contact holds the company and the company the
        // contact, and the response serializer would loop for ever on that cycle
        const changes: Partial<Company> = { primary_contact: { id: primaryContact.id } as User };
        if (!savedCompany.phone && primaryContact.phone) changes.phone = primaryContact.phone;
        if (!savedCompany.email && primaryContact.email) changes.email = primaryContact.email;
        await this.companyRepository.update(savedCompany.id, changes);
        if (changes.phone) savedCompany.phone = changes.phone;
        if (changes.email) savedCompany.email = changes.email;
      }

      // Was inside the loop: only the first contact was saved, and a company
      // without contacts was answered with an empty body.
      return savedCompany;
    } catch (error) {
      // Every error used to be reported as "already exists"
      if (error instanceof HttpException) {
        throw error;
      }
      if ((error as { code?: string })?.code === '23505') {
        throw new BadRequestException(
          `Company or contact with these details already exists: ${
            (error as { detail?: string }).detail ?? ''
          }`.trim(),
        );
      }
      this.logger.error(
        `company create failed: ${(error as Error)?.stack ?? error}`,
      );
      throw new InternalServerErrorException('Could not create the company');
    }
  }

  async getCompanyStats(): Promise<any> {
    const companyCount = await this.companyRepository
      .createQueryBuilder('t0')
      .getCount();

    const companiesWithMultipleDealsCountSql = `
     select count(t1.*) as count from (select t2.company_id from deal t2 where t2.deleted_at is null and t2.company_id is not null group by t2.company_id having count(t2.*) > 1) t1;
    `;

    const companiesWithMultipleDealsCount = await this.dataSource.query(
      companiesWithMultipleDealsCountSql,
    );

    const sumOfBudgetsExceptFirst = await this.getSumOfBudgetsExceptFirst();
    const companyWithMostDeals = await this.getCompanyWithMostDeals();
    const dealWithMaxBudget = await this.getDealWithMaxBudget();

    return {
      company_count: +companyCount,
      company_with_multiple_deals: +companiesWithMultipleDealsCount[0].count,
      sum_of_budgets_except_first: +sumOfBudgetsExceptFirst[0].result,
      company_with_most_deals: companyWithMostDeals,
      // no deals at all (every deal is in the trash): nothing to show, not a 500
      company_with_biggest_deal: dealWithMaxBudget
        ? Object.assign(
            { max_budget: +dealWithMaxBudget.budget },
            dealWithMaxBudget.company,
          )
        : null,
    };
  }

  private async getCompanyWithMostDeals(): Promise<Record<string, any>> {
    const companyWithMostDeals = await this.companyRepository
      .createQueryBuilder('t0')
      .leftJoin('t0.deals', 't1')
      .select('COUNT(t1.*)', 'deal_count')
      .addSelect('t0.id', 'id')
      .addSelect('t0.name', 'name')
      .addSelect('t0.email', 'email')
      .addSelect('t0.is_old', 'is_old')
      .addSelect('t0.updated_at', 'updated_at')
      .addSelect('t0.deleted_at', 'deleted_at')
      .addSelect('t0.created_at', 'created_at')
      .groupBy('t0.id')
      .orderBy('deal_count', 'DESC')
      .limit(1)
      .getRawOne();
    companyWithMostDeals.deal_count = +companyWithMostDeals.deal_count;

    return companyWithMostDeals;
  }

  private async getSumOfBudgetsExceptFirst(): Promise<Record<string, any>> {
    const sql = `
        SELECT SUM(total_budget_except_first) AS result 
        FROM (
        SELECT company_id, SUM(budget) AS total_budget_except_first
        FROM (
            SELECT 
                company_id,
                budget,
                ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY created_at) AS deal_rank
            FROM deal
            WHERE deleted_at IS NULL AND company_id IS NOT NULL
        ) AS ranked_deals
          WHERE deal_rank > 1
          GROUP BY company_id
        ) AS aggregated_data;
    `;

    return this.dataSource.query(sql);
  }

  private async getDealWithMaxBudget(): Promise<Deal> {
    return await this.dealRepository
      .createQueryBuilder('t0')
      .leftJoinAndSelect('t0.company', 't1')
      .orderBy('t0.budget', 'DESC')
      .limit(1)
      .getOne();
  }


  async update(
    id: number,
    request: Request,
    data: CreateCompanyFlatDto,
  ): Promise<void> {
    const company = await this.helperService.getById(Company, id, ['deals']);

    const updatedFields: Field[] = [];

    updatedFields.push(new Field('name', data.name, company.name));
    company.name = data.name;

    updatedFields.push(new Field('email', data.email, company.email));
    company.email = data.email;

    updatedFields.push(new Field('phone', data.phone, company.phone));
    company.phone = data.phone;

    updatedFields.push(
      new Field(
        'is_old',
        data.is_old ? 'true' : 'false',
        company.is_old ? 'true' : 'false',
      ),
    );
    company.is_old = data.is_old;

    // Requisites: only the fields present in the request are changed
    for (const field of COMPANY_REQUISITE_FIELDS) {
      if (data[field] === undefined) continue;
      updatedFields.push(new Field(field, data[field], company[field]));
      company[field] = data[field];
    }

    const companyFillerIds = data.fillers.map((filler) => filler.id);
    const companyFillers = await this.getCompanyFillerByIds(companyFillerIds);
    const companyFillerIdsToValues = this.getCompanyFillerHashMap(data.fillers);

    // Update necessary company fillers
    companyFillers.forEach((companyFiller) => {
      const newFillerValue = companyFillerIdsToValues.get(companyFiller.id);

      if (newFillerValue !== companyFiller.value) {
        this.fillerService.assertNotBlank(companyFiller.filler, newFillerValue);
        updatedFields.push(
          new Field(
            companyFiller.filler.field,
            newFillerValue,
            companyFiller.value,
          ),
        );
        companyFiller.value = newFillerValue;
      }
    });

    const originated_by =
      await this.helperService.extractUserFromRequest(request);

    company.updated_by = originated_by;

    // Update the contacts that were sent. A company may have no contacts at
    // all (e.g. created from a company card), so an empty list is allowed.
    for (const user of data.users ?? []) {
      if (user.role !== RoleEnum.CTR_AGENT) {
        throw new BadRequestException(
          `User with id: ${user.id}'s role must be ctr_agent`,
        );
      }

      user['company_id'] = id;
      if (user.fillers.length !== 0) {
        (user as any)['fillers'] = user.fillers.map((filler) => {
          return {
            user_filler_id: filler.id,
            value: filler.value,
          };
        });
      }

      user['fillers_create'] = [];

      const existUser = await this.helperService.getById(User, user.id, [
        'linked_deals',
      ]);

      // If email is being changed check if it already exists
      if (
        existUser.email !== user.email &&
        (await this.userService.checkIfUserEmailExists(user.email))
      ) {
        throw new BadRequestException(
          `User with email ${data.email} already exists!`,
        );
      }

      // Handle CTR_AGENT separately because the logic vastly differs
      if (existUser.role === RoleEnum.CTR_AGENT) {
        await this.userService.updateCtrAgent(existUser, request, user as any);
      }
    }

    //end Update user

    // the primary contact: one of the company's contacts, or none
    if (data.primary_contact_id !== undefined) {
      if (data.primary_contact_id === null) {
        company.primary_contact = null;
      } else {
        const contact = await this.userRepository.findOne({
          where: { id: data.primary_contact_id, role: RoleEnum.CTR_AGENT, company: { id } },
        });
        if (!contact) {
          throw new BadRequestException(`Contact ${data.primary_contact_id} is not a contact of this company`);
        }
        company.primary_contact = { id: contact.id } as User;
      }
    }

    await this.companyFillerRepository.save(companyFillers);
    await this.companyRepository.save(company);

    company.deals.forEach((deal) => {
      const eventData: FieldValueEventDto = {
        originated_by: originated_by,
        deal: deal,
        fields: updatedFields,
        fields_of: FieldsOf.COMPANY,
      };
      this.eventEmitter.emit(EventTypes.NEW_FIELD_VALUE.toString(), eventData);
    });
  }

  async deleteCompanyFiller(id: number): Promise<void> {
    const result = await this.companyFillerRepository.delete(id);

    if (result.affected === 0) {
      throw new NotFoundException(
        `Company filler with id ${id} does not exist!`,
      );
    }
  }

  async delete(id: number): Promise<void> {
    const result = await this.companyRepository.softDelete(id);

    if (result.affected === 0) {
      throw new NotFoundException(`Company with id ${id} does not exist!`);
    }
  }

  private async getCompanyFillerByIds(ids: number[]): Promise<CompanyFiller[]> {
    const companyFillers = await this.companyFillerRepository.find({
      where: { id: In(ids) },
      relations: ['filler'],
    });

    if (ids.length !== companyFillers.length) {
      this.fillerService.throwExceptionWithNonExistingFillers(
        ids,
        companyFillers,
      );
    }

    return companyFillers;
  }

  private getCompanyFillerHashMap(
    data: FlatCompanyFillerDto[],
  ): Map<number, string> {
    const hashMap = new Map<number, string>();

    data.forEach((companyFiller) => {
      hashMap.set(companyFiller.id, companyFiller.value);
    });

    return hashMap;
  }

  private createCompanyFillers(
    fillers: Map<number, Filler>,
    data: CreateCompanyFillerDto[],
  ): CompanyFiller[] {
    const newCompanyFillers = [];

    data.forEach((companyFiller) => {
      const newCompanyFiller = new CompanyFiller();
      newCompanyFiller.value = companyFiller.value;
      newCompanyFiller.filler = fillers.get(companyFiller.filler_id);

      newCompanyFillers.push(newCompanyFiller);
    });

    return newCompanyFillers;
  }
}
