import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import { DataSource, In, Repository } from 'typeorm';
import { CompanyFiller } from './company.filler.entity';
import {
  CompanyContactDto,
  CreateCompanyDto,
  CreateCompanyFillerDto,
} from './dto/create.company.dto';
import { FillableTablesEnum, Filler } from '../filler/filler.entity';
import { FillerService } from '../filler/filler.service';
import {
  CreateCompanyFlatDto,
  FlatCompanyFillerDto,
  FlatUserDto,
} from './dto/update.company.dto';
import { Field, FieldValueEventDto } from '../events/dto/field.value.event.dto';
import { HelperService } from '../helper/helper.service';
import { Request } from 'express';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventTypes, FieldsOf } from '../events/event.entity';
import {
  CompareDealCountPeriod,
  SearchCompanyDto,
} from './dto/search.company.dto';
import {
  PaginationRequestDto,
  PaginationResponseDto,
} from '../helper/dto/pagination.dto';
import { Deal } from '../deal/deal.entity';
import { RoleEnum, User } from 'src/user/user.entity';
import { CtrAgentChanges, UserService } from 'src/user/user.service';
import { UserFiller } from 'src/user/user.filler.entity';
import { Access } from '../auth/access';
import { AuthUser } from '../auth/auth.guard';
import { StageKind } from '../deal_stage/stage-kind';
import { normalizeEmail, normalizePhone, phoneDigits, phoneKey, phoneKeySql } from '../helper/phone';
import { AuditJournal } from '../audit/audit-journal';

/**
 * The deals of every company: its own (deal.company_id) and those of its contacts — the same rule as
 * the card's «Сделки» (COMPANY_DEALS_SQL in deal/client-history.service.ts), one row per pair.
 */
const COMPANY_DEAL_PAIRS = `
  SELECT d.company_id AS company_id, d.id AS deal_id
    FROM deal d
   WHERE d.deleted_at IS NULL AND d.company_id IS NOT NULL
  UNION
  SELECT u.company_id, d.id
    FROM deal_user du
    JOIN "user" u ON u.id = du."userId"
    JOIN deal d ON d.id = du."dealId"
   WHERE d.deleted_at IS NULL AND u.company_id IS NOT NULL`;

/** compare_deal_count_period of the list: the calendar period and one step back */
const PERIODS: Record<string, { trunc: string; step: string }> = {
  [CompareDealCountPeriod.MONTH]: { trunc: 'month', step: '1 month' },
  [CompareDealCountPeriod.QUARTER]: { trunc: 'quarter', step: '3 months' },
  [CompareDealCountPeriod.YEAR]: { trunc: 'year', step: '1 year' },
};

/** A condition with named parameters (Access) put into raw SQL with $n parameters. */
function bindNamed(sql: string, named: Record<string, any>, bind: (value: unknown) => string): string {
  return sql.replace(/:(\w+)/g, (match, name: string) => (name in named ? bind(named[name]) : match));
}

/** A field of a contact that the request may change, as updateCtrAgent() takes it. */
type ContactInput = (FlatUserDto & { id?: number }) | CompanyContactDto;

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
    private userService: UserService,
    private fillerService: FillerService,
    private helperService: HelperService,
    private eventEmitter: EventEmitter2,
    private dataSource: DataSource,
  ) { }

  // ================================================================== the list

  /**
   * GET /companies. A deal of a company is its own or one of its contacts' (as in the card), so
   * «Кол-во сделок» and LTV agree with the card: LTV is the budget of the SUCCESSFUL deals (closed in
   * the stage of kind won), not of every deal. `q` finds the name, ИНН, phone, e-mail and the
   * names, phones and e-mails of the contacts; `name` (the pickers) the name only. `requester`: only
   * the companies the user may see (Access.companySql). The response keeps its old fields.
   */
  async search(query: SearchCompanyDto, requester?: AuthUser): Promise<PaginationResponseDto<any>> {
    this.performAdditionalSearchCompanyValidation(query);
    const [sortBy, sortByType] = this.helperService.validateAndGetSortOptions(
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
    const limit = this.helperService.normalizeLimit(query.limit);
    const skip = this.helperService.normalizeSkip(query.skip);
    const period = PERIODS[query.compare_deal_count_period ?? CompareDealCountPeriod.MONTH] ?? PERIODS.month;

    const params: unknown[] = [];
    const bind = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };

    // «Сделки в периоде»: a deal that was open at some moment of the period (an open deal too;
    // OVERLAPS dropped those, as its closed_at is NULL). The end date is a whole day.
    const inPeriod: string[] = [];
    if (query.with_deals_at_period_start) {
      inPeriod.push(`(d.closed_at IS NULL OR d.closed_at >= CAST(${bind(query.with_deals_at_period_start)} AS date))`);
    }
    if (query.with_deals_at_period_end) {
      inPeriod.push(`d.created_at < CAST(${bind(query.with_deals_at_period_end)} AS date) + interval '1 day'`);
    }
    const periodSql = inPeriod.length ? `(${inPeriod.join(' AND ')})` : 'TRUE';
    const won = bind(StageKind.WON);
    const trunc = bind(period.trunc);
    const step = bind(period.step);

    const where: string[] = ['c.deleted_at IS NULL'];
    if (query.name) where.push(`c.name ILIKE ${bind(`%${query.name}%`)}`);
    if (query.q && query.q.trim()) where.push(this.searchSql(query.q.trim(), bind));
    if (query.is_old) where.push(`c.is_old = ${bind(query.is_old.toLowerCase() === 'true')}`);
    if (inPeriod.length) where.push('st.in_period');
    if (query.had_deals_before) {
      // a deal of the company before its first deal of the period: a returning client
      const earlier = `EXISTS (SELECT 1 FROM company_deal ce JOIN deal de ON de.id = ce.deal_id
                                WHERE ce.company_id = c.id AND de.created_at < st.first_in_period)`;
      where.push(query.had_deals_before.toLowerCase() === 'true' ? earlier : `NOT ${earlier}`);
    }
    if (query.no_deals === 'true') where.push('st.company_id IS NULL');
    if (requester) {
      const scope = new Access(requester).companySql('c', 'view');
      if (scope.sql !== 'TRUE') where.push(bindNamed(scope.sql, scope.params, bind));
    }

    const aggregate: Record<string, string> = {
      deal_count: 'deal_count',
      live_time_value: 'live_time_value',
      deal_count_this_period: 'deal_count_this_period',
      deal_count_previous_period: 'deal_count_previous_period',
    };
    const orderBy = aggregate[sortBy] ?? `c.${sortBy}`;
    const direction = sortByType === 'DESC' ? 'DESC' : 'ASC';

    const sql = `
      WITH company_deal AS (${COMPANY_DEAL_PAIRS}),
      stats AS (
        SELECT cd.company_id,
               COUNT(*) FILTER (WHERE ${periodSql}) AS deal_count,
               COALESCE(SUM(d.budget) FILTER (WHERE ${periodSql} AND d.closed_at IS NOT NULL AND s.kind = ${won}), 0) AS live_time_value,
               COUNT(*) FILTER (WHERE d.created_at >= date_trunc(${trunc}, now())) AS deal_count_this_period,
               COUNT(*) FILTER (WHERE d.created_at >= date_trunc(${trunc}, now()) - CAST(${step} AS interval)
                                  AND d.created_at < date_trunc(${trunc}, now())) AS deal_count_previous_period,
               bool_or(${periodSql}) AS in_period,
               MIN(d.created_at) FILTER (WHERE ${periodSql}) AS first_in_period
          FROM company_deal cd
          JOIN deal d ON d.id = cd.deal_id
          LEFT JOIN deal_stage s ON s.id = d.stage_id
         GROUP BY cd.company_id
      )
      SELECT c.id,
             COALESCE(st.deal_count, 0) AS deal_count,
             COALESCE(st.live_time_value, 0) AS live_time_value,
             COALESCE(st.deal_count_this_period, 0) AS deal_count_this_period,
             COALESCE(st.deal_count_previous_period, 0) AS deal_count_previous_period,
             COUNT(*) OVER () AS total_count
        FROM company c
        LEFT JOIN stats st ON st.company_id = c.id
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderBy} ${direction}, c.id ${direction}
       LIMIT ${bind(limit)} OFFSET ${bind(skip)}`;

    const rows: any[] = await this.dataSource.query(sql, params);

    const response = new PaginationResponseDto<any>();
    response.count = rows.length ? Number(rows[0].total_count) : 0;
    response.page_size = limit;
    response.current_page = Math.floor(skip / limit) + 1;
    response.last_page = this.helperService.calculateLastPage(response.count, limit);
    if (!rows.length) {
      response.data = [];
      return response;
    }

    const companies = await this.companyRepository.find({
      where: { id: In(rows.map((row) => Number(row.id))) },
      relations: { company_fillers: { filler: true }, created_by: true },
    });
    const byId = new Map(companies.map((company) => [company.id, company]));

    const data = [];
    for (const row of rows) {
      const company = byId.get(Number(row.id));
      if (!company) continue;
      data.push({
        id: company.id,
        name: company.name,
        email: company.email,
        phone: company.phone,
        is_old: company.is_old,
        inn: company.inn,
        updated_at: company.updated_at,
        deleted_at: company.deleted_at,
        created_at: company.created_at,
        company_fillers: company.company_fillers,
        created_by: company.created_by,
        deal_count: Number(row.deal_count),
        live_time_value: Number(row.live_time_value),
        deal_count_this_period: Number(row.deal_count_this_period),
        deal_count_previous_period: Number(row.deal_count_previous_period),
      });
    }
    await this.fillContactsIntoList(data);
    response.data = data;
    return response;
  }

  /** `q` of the list: the name, e-mail, phone, ИНН of the company, the name, e-mail, phone of a contact. */
  private searchSql(text: string, bind: (value: unknown) => string): string {
    const like = bind(`%${text}%`);
    const company = [`c.name ILIKE ${like}`, `c.email ILIKE ${like}`];
    const contact = [`u.username ILIKE ${like}`, `u.email ILIKE ${like}`];
    const digits = phoneDigits(text);
    if (digits.length >= 5) {
      // a phone typed in any format: the last 9 digits are enough (+998 or not)
      const phone = bind(`%${digits.length >= 9 ? digits.slice(-9) : digits}%`);
      company.push(`regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') LIKE ${phone}`);
      company.push(`regexp_replace(COALESCE(c.inn, ''), '[^0-9]', '', 'g') LIKE ${bind(`%${digits}%`)}`);
      contact.push(`regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g') LIKE ${phone}`);
    }
    company.push(
      `EXISTS (SELECT 1 FROM "user" u WHERE u.company_id = c.id AND u.role = '${RoleEnum.CTR_AGENT}'
                AND u.deleted_at IS NULL AND (${contact.join(' OR ')}))`,
    );
    return `(${company.join(' OR ')})`;
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

  // ================================================================== the card

  async getById(id: number): Promise<any> {
    const company = await this.helperService.getById(Company, id, [
      'company_fillers',
      'company_fillers.filler',
      'users',
      'users.user_fillers',
      'users.user_fillers.filler',
      'created_by',
      'primary_contact',
    ]);

    if (company) {
      // a removed contact is not a contact of the company any more
      company.users = (company.users ?? []).filter((user) => !user.deleted_at && user.role === RoleEnum.CTR_AGENT);
      this.applyPrimaryContact(company);
      // filler_id: which field a value belongs to (the card matched values to fields by the value's id)
      company['fillers'] = company.company_fillers.map((filler) => {
        return {
          id: filler.id,
          value: filler.value,
          filler_id: filler.filler?.id ?? null,
        };
      });

      (company as any).users = company.users.map((user) => {
        return {
          id: user.id,
          username: user.username,
          email: user.email,
          phone: user.phone,
          fillers: (user.user_fillers ?? []).map((filler) => {
            return {
              id: filler.id,
              value: filler.value,
              filler_id: filler.filler?.id ?? null,
            };
          }),
        };
      });

      delete company['company_fillers'];
      delete (company as any).primary_contact;

      (company as any).summary = await this.cardSummary(company.id);

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

  /**
   * The head of the company card: who leads the client (the responsible of its latest open deal, else
   * of its latest deal), how many deals are open and in all, when the client was last active (the
   * latest event of its deals) and the nearest open task of the company or of its deals.
   */
  private async cardSummary(companyId: number): Promise<Record<string, any>> {
    const [deals] = await this.dataSource.query(
      `WITH cd AS (SELECT DISTINCT deal_id FROM (${COMPANY_DEAL_PAIRS}) p WHERE p.company_id = $1)
       SELECT count(*) AS deal_count,
              count(*) FILTER (WHERE d.closed_at IS NULL) AS open_deal_count,
              (array_agg(a.id ORDER BY (d.closed_at IS NULL) DESC, d.created_at DESC) FILTER (WHERE a.id IS NOT NULL))[1] AS agent_id,
              (array_agg(a.username ORDER BY (d.closed_at IS NULL) DESC, d.created_at DESC) FILTER (WHERE a.id IS NOT NULL))[1] AS agent_name,
              (SELECT max(e.created_at) FROM event e WHERE e.deal_id IN (SELECT deal_id FROM cd)) AS last_activity_at
         FROM cd JOIN deal d ON d.id = cd.deal_id
         LEFT JOIN "user" a ON a.id = d.agent_id AND a.deleted_at IS NULL`,
      [companyId],
    );
    const [task] = await this.dataSource.query(
      `SELECT t.id, t.label, t.start_time
         FROM task t
        WHERE t.closed_at IS NULL
          AND (t.company_id = $1 OR t.deal_id IN (SELECT deal_id FROM (${COMPANY_DEAL_PAIRS}) p WHERE p.company_id = $1))
        ORDER BY t.start_time ASC NULLS LAST, t.id ASC
        LIMIT 1`,
      [companyId],
    );
    return {
      deal_count: Number(deals?.deal_count ?? 0),
      open_deal_count: Number(deals?.open_deal_count ?? 0),
      agent: deals?.agent_id ? { id: Number(deals.agent_id), username: deals.agent_name } : null,
      last_activity_at: deals?.last_activity_at ?? null,
      next_task: task ? { id: Number(task.id), label: task.label, start_time: task.start_time } : null,
    };
  }

  /**
   * Files and calls of ONE contact of the company (the old per-contact tabs; kept for the web client
   * that is still open). Calls: the recordings linked to the contact (the NEW_CALL_RECORDING events of
   * the contact, of its deals) or made from / to its phone. A recording belongs to the MANAGER who
   * recorded it (recording.user_id), so `r.user_id = <contact>` never matched and the tab was empty.
   */
  async fetchSourceOfAgent(
    company_id: number,
    agent_id: number,
    query: PaginationRequestDto,
    requester?: AuthUser,
  ): Promise<Record<string, any>> {
    // A contact without a company, or of another company, used to end in a
    // 500 (`user.company.id` of null).
    const user = await this.userRepository.findOne({
      where: { id: agent_id },
      relations: ['company'],
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

    const deals: { id: number }[] = await this.dataSource.query(
      `SELECT du."dealId" AS id FROM deal_user du JOIN deal d ON d.id = du."dealId"
        WHERE du."userId" = $1 AND d.deleted_at IS NULL`,
      [agent_id],
    );
    return this.collectSources(
      deals.map((d) => Number(d.id)),
      [agent_id],
      [user.phone],
      requester ? new Access(requester) : null,
      query,
    );
  }

  /**
   * GET /companies/:id/sources: the «Файлы» and «Звонки» tabs of the company as one list each,
   * newest first: files of every deal of the company (its own and its contacts'), and the call
   * recordings of the company — linked to those deals or to its contacts, or made from / to the
   * phone of a contact or of the company. Within the deals the user may see (a recording without a
   * deal: when the user, or the group, recorded it).
   */
  async fetchCompanySources(
    company_id: number,
    query: PaginationRequestDto,
    requester?: AuthUser,
  ): Promise<Record<string, any>> {
    const company = await this.helperService.getById(Company, company_id);
    const deals: { deal_id: number }[] = await this.dataSource.query(
      `SELECT DISTINCT cd.deal_id FROM (${COMPANY_DEAL_PAIRS}) cd WHERE cd.company_id = $1`,
      [company_id],
    );
    const contacts: { id: number; phone: string | null }[] = await this.dataSource.query(
      `SELECT u.id, u.phone FROM "user" u WHERE u.company_id = $1 AND u.role = 'ctr_agent' AND u.deleted_at IS NULL`,
      [company_id],
    );
    return this.collectSources(
      deals.map((d) => Number(d.deal_id)),
      contacts.map((c) => Number(c.id)),
      [company.phone, ...contacts.map((c) => c.phone)],
      requester ? new Access(requester) : null,
      query,
    );
  }

  private async collectSources(
    dealIds: number[],
    contactIds: number[],
    phones: (string | null | undefined)[],
    access: Access | null,
    query: PaginationRequestDto,
  ): Promise<{ files: any[]; recordings: any[] }> {
    const limit = this.helperService.normalizeLimit(query.limit);
    const skip = this.helperService.normalizeSkip(query.skip);
    const keys = [...new Set(phones.map((phone) => phoneKey(phone)).filter((key) => !!key))];

    // ------------------------------------------------ files
    let files: any[] = [];
    if (dealIds.length) {
      const params: unknown[] = [];
      const bind = (value: unknown) => {
        params.push(value);
        return `$${params.length}`;
      };
      const scope = access ? access.dealSql('d', 'view') : { sql: 'TRUE', params: {} };
      files = await this.dataSource.query(
        `SELECT f.id, f.name, f.path, f.size, f.created_at, d.id AS deal_id, d.label AS deal_label
           FROM deal_file df
           JOIN file f ON f.id = df."fileId"
           JOIN deal d ON d.id = df."dealId"
          WHERE df."dealId" = ANY(${bind(dealIds)}) AND d.deleted_at IS NULL
            AND ${bindNamed(scope.sql, scope.params, bind)}
          ORDER BY f.created_at DESC, f.id DESC
          LIMIT ${bind(limit)} OFFSET ${bind(skip)}`,
        params,
      );
    }

    // ------------------------------------------------ call recordings
    let recordings: any[] = [];
    if (dealIds.length || contactIds.length || keys.length) {
      const params: unknown[] = [];
      const bind = (value: unknown) => {
        params.push(value);
        return `$${params.length}`;
      };
      // recorded by the user (group) — rr.agent_id is the manager who recorded it — or of a visible deal
      const own = access ? access.dealSql('rr', 'view') : { sql: 'TRUE', params: {} };
      const visibleDeal = access ? access.dealSql('ld', 'view') : { sql: 'TRUE', params: {} };
      const people = bind(contactIds);
      recordings = await this.dataSource.query(
        `WITH linked AS (
           SELECT DISTINCT ON (e.after_state->>'path') e.after_state->>'path' AS path, e.deal_id
             FROM event e
            WHERE e.type = ${EventTypes.NEW_CALL_RECORDING} AND e.after_state->>'path' IS NOT NULL
              AND (e.deal_id = ANY(${bind(dealIds)}) OR e.user_id = ANY(${people}) OR e.target_user_id = ANY(${people}))
            ORDER BY e.after_state->>'path', e.id DESC
         )
         SELECT rr.id, rr.path, rr.created_at, rr.duration, rr.outgoing, rr.from_number,
                m.id AS manager_id, m.username AS manager_name, ld.id AS deal_id, ld.label AS deal_label
           FROM (SELECT r.*, r.user_id AS agent_id FROM recording r) rr
           LEFT JOIN linked l ON l.path = rr.path
           LEFT JOIN deal ld ON ld.id = l.deal_id AND ld.deleted_at IS NULL
           LEFT JOIN "user" m ON m.id = rr.user_id
          WHERE (l.path IS NOT NULL OR ${phoneKeySql('rr.from_number')} = ANY(${bind(keys)}))
            AND (${bindNamed(own.sql, own.params, bind)}
                 OR (ld.id IS NOT NULL AND ${bindNamed(visibleDeal.sql, visibleDeal.params, bind)}))
          ORDER BY rr.created_at DESC, rr.id DESC
          LIMIT ${bind(limit)} OFFSET ${bind(skip)}`,
        params,
      );
    }

    return {
      files: files.map((file) => ({
        id: file.id,
        deal: Number(file.deal_id),
        deal_label: file.deal_label,
        path: file.path,
        name: file.name,
        size: Number(file.size ?? 0),
        created_at: file.created_at,
      })),
      recordings: recordings.map((rec) => ({
        id: rec.id,
        path: rec.path,
        created_at: rec.created_at,
        duration: Number(rec.duration ?? 0),
        outgoing: rec.outgoing,
        from_number: rec.from_number,
        manager: rec.manager_id ? { id: rec.manager_id, username: rec.manager_name } : null,
        deal: rec.deal_id ? { id: Number(rec.deal_id), label: rec.deal_label } : null,
      })),
    };
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

  // ================================================================== duplicates

  /**
   * A company that is not deleted with this name (case and spaces around do not matter, as the unique
   * index IDX_company_name_live): 409 with the company that has it.
   */
  private async assertNameIsFree(name: string, exceptId?: number): Promise<void> {
    const qb = this.companyRepository
      .createQueryBuilder('c')
      .where('lower(btrim(c.name)) = lower(btrim(:name))', { name });
    if (exceptId) qb.andWhere('c.id <> :exceptId', { exceptId });
    const same = await qb.getOne();
    if (same) {
      throw new ConflictException(`Компания «${same.name}» уже есть (№${same.id})`);
    }
  }

  /** 409 text of a unique index hit (23505), by the index: what is taken, in Russian. */
  private duplicateMessage(error: unknown): string {
    const constraint = String((error as { constraint?: string })?.constraint ?? '');
    if (constraint.includes('inn')) return 'Компания с таким ИНН уже есть';
    if (constraint.includes('email')) return 'Контакт с такой почтой уже есть';
    return 'Компания с таким названием уже есть';
  }

  /** ИНН identifies the legal entity: one company per ИНН (9 digits and more), among those not deleted. */
  private async assertInnIsFree(inn: string | null | undefined, exceptId?: number): Promise<void> {
    const digits = phoneDigits(inn);
    if (digits.length < 9) return;
    const qb = this.companyRepository
      .createQueryBuilder('c')
      .where(`regexp_replace(COALESCE(c.inn, ''), '[^0-9]', '', 'g') = :digits`, { digits });
    if (exceptId) qb.andWhere('c.id <> :exceptId', { exceptId });
    const same = await qb.getOne();
    if (same) {
      throw new ConflictException(`Компания с ИНН ${digits} уже есть: «${same.name}» (№${same.id})`);
    }
  }

  /**
   * New contacts of a company: e-mail and phone are not taken (by another contact or by one of the
   * same request). `checkPhones`: the web form; the bot's card keeps its own duplicate warnings.
   */
  private async assertNewContactsAreFree(
    contacts: { username?: string; email?: string | null; phone?: string | null }[],
    checkPhones: boolean,
  ): Promise<void> {
    const emails = new Set<string>();
    const phones = new Set<string>();
    for (const contact of contacts) {
      const email = normalizeEmail(contact.email) ?? '';
      if (email) {
        if (emails.has(email)) throw new BadRequestException(`Два контакта с одной почтой: ${email}`);
        emails.add(email);
        await this.userService.assertEmailIsFree(email);
      }
      const key = phoneKey(contact.phone);
      if (checkPhones && key) {
        if (phones.has(key)) throw new BadRequestException(`Два контакта с одним телефоном: ${contact.phone}`);
        phones.add(key);
        await this.userService.assertPhoneIsFree(contact.phone);
      }
    }
  }

  // ================================================================== create

  async create(
    data: CreateCompanyDto,
    request: Request,
    options: { skipRequiredFields?: boolean; checkContactPhones?: boolean } = {},
  ): Promise<Company> {
    const name = data.name.trim();
    await this.assertNameIsFree(name);
    await this.assertInnIsFree(data.inn);

    // one format for every phone (helper/phone.ts); "" is no e-mail
    const contacts = (data.users ?? []).map((agent) => ({
      ...agent,
      email: normalizeEmail(agent.email),
      phone: normalizePhone(agent.phone),
    }));
    await this.assertNewContactsAreFree(contacts, !!options.checkContactPhones);

    if (!options.skipRequiredFields) {
      await this.fillerService.assertRequiredFilled(
        FillableTablesEnum.COMPANY,
        data.fillers,
      );
      for (const agent of contacts) {
        await this.fillerService.assertRequiredFilled(
          FillableTablesEnum.USER,
          (agent as any).fillers ?? [],
        );
      }
    }

    const author = await this.helperService.extractUserFromRequest(request);
    const companyFillers = (data.fillers ?? []).length
      ? this.createCompanyFillers(
          await this.fillerService.getFillersHashMap(data.fillers, FillableTablesEnum.COMPANY),
          data.fillers,
        )
      : [];
    const contactFillers: { values: any[]; definitions: Map<number, Filler> }[] = [];
    for (const agent of contacts) {
      // The contact's own custom fields (e.g. "Должность"). This used to
      // pass the company's fields, so contacts got company values and lost theirs.
      const values = ((agent as any).fillers ?? []).filter(
        (f: { filler_id?: number; value?: string }) => f?.filler_id && String(f.value ?? '').trim(),
      );
      contactFillers.push({
        values,
        definitions: values.length
          ? await this.fillerService.getFillersHashMap(values, FillableTablesEnum.USER)
          : new Map(),
      });
    }

    try {
      // one transaction: a contact that fails used to leave a company without part of its contacts,
      // and the retry answered "already exists"
      return await this.dataSource.transaction(async (manager) => {
        const newCompany = new Company();
        newCompany.name = name;
        newCompany.phone = normalizePhone(data.phone);
        newCompany.email = normalizeEmail(data.email);
        newCompany.is_old = data.is_old;
        for (const field of COMPANY_REQUISITE_FIELDS) {
          newCompany[field] = data[field] ?? null;
        }
        newCompany.created_by = author;
        newCompany.company_fillers = companyFillers;

        const result = await manager.save(newCompany);

        let primaryContact: User | null = null;
        for (let i = 0; i < contacts.length; i++) {
          const agent = contacts[i];
          const newCtrAgent = new User();
          newCtrAgent.username = agent.username;
          newCtrAgent.email = agent.email;
          newCtrAgent.role = RoleEnum.CTR_AGENT;
          newCtrAgent.company = { id: result.id } as Company;
          newCtrAgent.phone = agent.phone;
          newCtrAgent.created_by = author;
          newCtrAgent.user_fillers = contactFillers[i].values.length
            ? this.userService.createUserFillers(contactFillers[i].definitions, contactFillers[i].values)
            : [];

          const savedContact = await manager.save(newCtrAgent);
          primaryContact = primaryContact ?? savedContact;
        }

        // the first contact is the primary one; without a phone / email of its own the
        // company takes the contact's (a card or a chat gives only the person's)
        if (primaryContact) {
          // an update by id, not save(): the contact holds the company and the company the
          // contact, and the response serializer would loop for ever on that cycle
          const changes: Partial<Company> = { primary_contact: { id: primaryContact.id } as User };
          if (!newCompany.phone && primaryContact.phone) changes.phone = primaryContact.phone;
          if (!newCompany.email && primaryContact.email) changes.email = primaryContact.email;
          await manager.update(Company, result.id, changes);
        }

        // Was inside the loop: only the first contact was saved, and a company
        // without contacts was answered with an empty body.
        return manager.findOneBy(Company, { id: result.id });
      });
    } catch (error) {
      // Every error used to be reported as "already exists"
      if (error instanceof HttpException) {
        throw error;
      }
      // two requests at once got past the checks: the unique indexes answer (name, ИНН, contact e-mail)
      if ((error as { code?: string })?.code === '23505') {
        throw new ConflictException(this.duplicateMessage(error));
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
    // no company at all: nothing to show, not a 500
    if (!companyWithMostDeals) return null;
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

  // ================================================================== update

  /**
   * PATCH /companies/:id. Only the fields sent change and are logged (the deal form sent the whole
   * company and reset «Старый клиент»). Everything that can fail is checked before anything is written.
   * - custom fields: by the id of the value ({id} or {company_filler_id} — a value of THIS company;
   *   another company's id is refused) or by the field ({filler_id}, and fillers_create): set, or
   *   created when the company has none; "" removes a value that is not required;
   * - users: the contacts of THIS company are changed (another company's contact is refused), a
   *   contact without an id is created; `removed_user_ids` detaches contacts from the company (they stay
   *   in the CRM, in the history of their deals); changing contacts needs the contact rights;
   * - primary_contact_id: one of the company's contacts, or null.
   */
  async update(
    id: number,
    request: Request,
    data: CreateCompanyFlatDto,
    requester?: AuthUser,
  ): Promise<void> {
    const company = await this.helperService.getById(Company, id, ['deals']);
    const access = requester ? new Access(requester) : null;
    const updatedFields: Field[] = [];
    const changes: Partial<Company> = {};

    // ------------------------------------------------ the company's own fields
    if (data.name !== undefined && data.name !== null) {
      const name = String(data.name).trim();
      if (name !== company.name) {
        await this.assertNameIsFree(name, id);
        updatedFields.push(new Field('name', name, company.name));
        changes.name = name;
      }
    }
    if (data.email !== undefined) {
      const email = normalizeEmail(data.email);
      if (email !== (company.email ?? null)) {
        updatedFields.push(new Field('email', email, company.email));
        changes.email = email;
      }
    }
    if (data.phone !== undefined) {
      const phone = normalizePhone(data.phone);
      if (phone !== (company.phone ?? null)) {
        updatedFields.push(new Field('phone', phone, company.phone));
        changes.phone = phone;
      }
    }
    if (data.is_old !== undefined && data.is_old !== null && !!data.is_old !== !!company.is_old) {
      updatedFields.push(
        new Field('is_old', data.is_old ? 'true' : 'false', company.is_old ? 'true' : 'false'),
      );
      changes.is_old = !!data.is_old;
    }
    // Requisites: only the fields present in the request are changed
    for (const field of COMPANY_REQUISITE_FIELDS) {
      if (data[field] === undefined) continue;
      const value = data[field] ?? null;
      if (value === (company[field] ?? null)) continue;
      if (field === 'inn') await this.assertInnIsFree(value, id);
      updatedFields.push(new Field(field, value, company[field]));
      (changes as any)[field] = value;
    }

    // ------------------------------------------------ custom fields (checked, written below)
    const fillerChanges = await this.collectCompanyFillerChanges(
      id,
      data.fillers ?? [],
      (data as any).fillers_create ?? [],
      updatedFields,
    );

    // ------------------------------------------------ contacts
    const sent = (data.users ?? []) as (FlatUserDto & { id?: number })[];
    const removedIds = [...new Set((data.removed_user_ids ?? []).map(Number))];
    const mine = await this.userRepository.find({
      where: { company: { id }, role: RoleEnum.CTR_AGENT },
      relations: ['linked_deals', 'company', 'user_fillers', 'user_fillers.filler'],
    });
    const mineById = new Map(mine.map((contact) => [contact.id, contact]));

    for (const user of sent) {
      if (user.role && user.role !== RoleEnum.CTR_AGENT) {
        throw new BadRequestException(
          `User with id: ${user.id}'s role must be ctr_agent`,
        );
      }
      // only this company's own contacts: any other contact used to be moved here and rewritten
      if (user.id && !mineById.has(Number(user.id))) {
        throw new BadRequestException(`Контакт №${user.id} — не контакт этой компании`);
      }
    }
    for (const removedId of removedIds) {
      if (!mineById.has(removedId)) {
        throw new BadRequestException(`Контакт №${removedId} — не контакт этой компании`);
      }
    }
    const updates = sent.filter((user) => user.id && !removedIds.includes(Number(user.id)));
    const created = sent.filter((user) => !user.id);
    const changed = updates.filter((user) => this.contactChanged(mineById.get(Number(user.id)), user));

    // rights: new contacts need «Создание контактов», a change or a removal the right to change that contact
    if (access) {
      if (created.length && !access.can('contact', 'create')) {
        throw new ForbiddenException('No right to create contacts');
      }
      await this.assertContactsChangeable(access, [...changed.map((user) => Number(user.id)), ...removedIds]);
    }

    // e-mails and phones of the changed and the new contacts are not taken
    for (const user of changed) {
      const stored = mineById.get(Number(user.id));
      if (user.email !== undefined) {
        const email = normalizeEmail(user.email);
        if (email && email !== normalizeEmail(stored.email)) await this.userService.assertEmailIsFree(email, stored.id);
      }
      if (user.phone !== undefined && phoneKey(user.phone) !== phoneKey(stored.phone)) {
        await this.userService.assertPhoneIsFree(normalizePhone(user.phone), stored.id);
      }
    }
    const newContacts = created.map((user) => ({
      ...user,
      email: normalizeEmail(user.email),
      phone: normalizePhone(user.phone),
    }));
    await this.assertNewContactsAreFree(newContacts, true);
    const newContactFillers: { values: any[]; definitions: Map<number, Filler> }[] = [];
    for (const user of newContacts) {
      const values = (user.fillers ?? [])
        .map((f: any) => ({ filler_id: Number(f.filler_id ?? f.id), value: String(f.value ?? '').trim() }))
        .filter((f) => f.filler_id && f.value);
      await this.fillerService.assertRequiredFilled(FillableTablesEnum.USER, values);
      newContactFillers.push({
        values,
        definitions: values.length
          ? await this.fillerService.getFillersHashMap(values, FillableTablesEnum.USER)
          : new Map(),
      });
    }

    // the primary contact: one of the company's contacts (not one being removed), or none
    if (data.primary_contact_id !== undefined) {
      if (data.primary_contact_id === null) {
        changes.primary_contact = null;
      } else if (!mineById.has(Number(data.primary_contact_id)) || removedIds.includes(Number(data.primary_contact_id))) {
        throw new BadRequestException(`Contact ${data.primary_contact_id} is not a contact of this company`);
      } else {
        changes.primary_contact = { id: Number(data.primary_contact_id) } as User;
      }
    }

    // ------------------------------------------------ writes
    const originated_by =
      await this.helperService.extractUserFromRequest(request);

    if (fillerChanges.remove.length) await this.companyFillerRepository.remove(fillerChanges.remove);
    if (fillerChanges.save.length) await this.companyFillerRepository.save(fillerChanges.save);

    for (const user of changed) {
      await this.userService.updateCtrAgent(mineById.get(Number(user.id)), request, this.contactChanges(user));
    }
    for (const removedId of removedIds) {
      const contact = mineById.get(removedId);
      // the contact stays in the CRM without a company: its card and its deals say so
      await this.userService.updateCtrAgent(contact, request, { company_id: null });
      updatedFields.push(new Field('contact', null, contact.username));
    }
    for (let i = 0; i < newContacts.length; i++) {
      const user = newContacts[i];
      const contact = new User();
      contact.username = String(user.username ?? '').trim();
      contact.email = user.email;
      contact.phone = user.phone;
      contact.role = RoleEnum.CTR_AGENT;
      contact.company = { id } as Company;
      contact.created_by = originated_by;
      contact.user_fillers = newContactFillers[i].values.length
        ? this.userService.createUserFillers(newContactFillers[i].definitions, newContactFillers[i].values)
        : [];
      await this.userRepository.save(contact);
      updatedFields.push(new Field('contact', contact.username, null));
    }

    changes.updated_by = { id: originated_by.id } as User;
    try {
      // update by id, not save(): the company holds its deals and contacts (see create)
      await this.companyRepository.update(id, changes);
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') {
        throw new ConflictException(this.duplicateMessage(error));
      }
      throw error;
    }

    if (!updatedFields.length) return;
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

  /**
   * The custom field values a PATCH changes, checked before anything is written: an id must be a
   * value of this company (another company's value was overwritten before), a field by its
   * definition is set or created; "" removes a value that is not required.
   */
  private async collectCompanyFillerChanges(
    companyId: number,
    items: FlatCompanyFillerDto[],
    create: CreateCompanyFillerDto[],
    updatedFields: Field[],
  ): Promise<{ save: CompanyFiller[]; remove: CompanyFiller[] }> {
    const save: CompanyFiller[] = [];
    const remove: CompanyFiller[] = [];
    if (!items.length && !create.length) return { save, remove };

    const existing = await this.companyFillerRepository.find({
      where: { company: { id: companyId } },
      relations: { filler: true },
      order: { id: 'ASC' },
    });
    const byRowId = new Map(existing.map((row) => [row.id, row]));
    const touched = new Set<CompanyFiller>();
    const set = (row: CompanyFiller, raw: unknown) => {
      const value = String(raw ?? '').trim();
      if (value === row.value || touched.has(row)) return;
      touched.add(row);
      this.fillerService.assertNotBlank(row.filler, value);
      updatedFields.push(new Field(row.filler.field, value || null, row.value));
      if (value) {
        row.value = value;
        save.push(row);
      } else {
        remove.push(row);
      }
    };

    const byDefinition: { filler_id: number; value: string }[] = [];
    const foreign: number[] = [];
    for (const item of items) {
      if (item.filler_id) {
        byDefinition.push({ filler_id: Number(item.filler_id), value: item.value });
        continue;
      }
      const rowId = Number(item.id ?? item.company_filler_id);
      const row = byRowId.get(rowId);
      if (!row) {
        foreign.push(rowId);
        continue;
      }
      set(row, item.value);
    }
    if (foreign.length) {
      throw new BadRequestException(
        `Значения доп. полей ${foreign.join(', ')} не относятся к этой компании`,
      );
    }
    for (const item of create) {
      if (item?.filler_id) byDefinition.push({ filler_id: Number(item.filler_id), value: item.value });
    }

    if (byDefinition.length) {
      const definitions = await this.fillerService.getFillersHashMap(byDefinition, FillableTablesEnum.COMPANY);
      const added = new Map<number, CompanyFiller>();
      for (const item of byDefinition) {
        const row = existing.find((e) => e.filler?.id === item.filler_id);
        if (row) {
          set(row, item.value);
          continue;
        }
        const value = String(item.value ?? '').trim();
        if (!value || added.has(item.filler_id)) continue;
        const fresh = new CompanyFiller();
        fresh.value = value;
        fresh.filler = definitions.get(item.filler_id);
        fresh.company = { id: companyId } as Company;
        updatedFields.push(new Field(fresh.filler.field, value, null));
        added.set(item.filler_id, fresh);
        save.push(fresh);
      }
    }

    return { save, remove };
  }

  /** Does the request change anything of this contact (name, e-mail, phone, a custom field)? */
  private contactChanged(stored: User, sent: ContactInput): boolean {
    if (sent.username !== undefined && String(sent.username ?? '').trim() !== stored.username) return true;
    if (sent.email !== undefined && normalizeEmail(sent.email) !== (stored.email ?? null)) return true;
    if (sent.phone !== undefined && normalizePhone(sent.phone) !== (stored.phone ?? null)) return true;
    const rows: UserFiller[] = stored.user_fillers ?? [];
    for (const item of ((sent as any).fillers ?? []) as { id?: number; filler_id?: number; value?: string }[]) {
      const value = String(item.value ?? '').trim();
      const row = item.filler_id
        ? rows.find((r) => r.filler?.id === Number(item.filler_id))
        : rows.find((r) => r.id === Number(item.id));
      if (row ? row.value !== value : !!value) return true;
    }
    return false;
  }

  /** A contact of the company card as updateCtrAgent() takes it (the company does not change). */
  private contactChanges(sent: FlatUserDto & { id?: number }): CtrAgentChanges {
    const fillers = ((sent as any).fillers ?? []) as { id?: number; filler_id?: number; value?: string }[];
    return {
      username: sent.username !== undefined ? String(sent.username ?? '').trim() : undefined,
      email: sent.email,
      phone: sent.phone,
      // the card has one input per field: by its definition (the old card sent the definition's id
      // as `id` and as `filler_id`); a value id alone is a value of this contact
      fillers_set: fillers
        .filter((f) => f.filler_id)
        .map((f) => ({ filler_id: Number(f.filler_id), value: String(f.value ?? '') })),
      fillers: fillers
        .filter((f) => !f.filler_id && f.id)
        .map((f) => ({ user_filler_id: Number(f.id), value: String(f.value ?? '') })),
    };
  }

  /** The contacts must be within the user's contact update right (Access.contactSql). */
  private async assertContactsChangeable(access: Access, ids: number[]): Promise<void> {
    if (!ids.length || access.scope('contact', 'update') === 'all') return;
    if (access.scope('contact', 'update') === 'none') {
      throw new ForbiddenException('No right to change contacts');
    }
    const cond = access.contactSql('u', 'update');
    const rows: { id: number }[] = await this.dataSource
      .createQueryBuilder()
      .select('u.id', 'id')
      .from('user', 'u')
      .where('u.id IN (:...contact_ids)', { contact_ids: ids })
      .andWhere(cond.sql, cond.params)
      .getRawMany();
    const allowed = new Set(rows.map((row) => Number(row.id)));
    const refused = ids.filter((contactId) => !allowed.has(contactId));
    if (refused.length) {
      throw new ForbiddenException(`No right to change the contacts ${refused.join(', ')}`);
    }
  }

  async deleteCompanyFiller(id: number): Promise<void> {
    const result = await this.companyFillerRepository.delete(id);

    if (result.affected === 0) {
      throw new NotFoundException(
        `Company filler with id ${id} does not exist!`,
      );
    }
  }

  /**
   * DELETE /companies/:id: the company goes to the trash together with its contacts (DB-11: a contact of a
   * deleted company used to stay in the lists, the search and the matching of calls and messages, and
   * the tasks of a company or contact in the trash are hidden like those of a deal). One moment for all
   * of them (the transaction's now()), so restore() brings back exactly these contacts. The deals stay
   * where they are (the trash shows how many) and are the company's again when it comes back.
   */
  async delete(id: number, performer?: AuthUser | null): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const [company] = await manager.query(
        `SELECT id FROM company WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [id],
      );
      if (!company) {
        throw new NotFoundException(`Company with id ${id} does not exist!`);
      }
      // the journal (src/audit): «Удаление в корзину» of each contact, in this transaction
      await AuditJournal.around(
        manager,
        'user',
        `t.company_id = $1 AND t.role = 'ctr_agent' AND t.deleted_at IS NULL`,
        [id],
        () =>
          manager.query(
            `UPDATE "user" SET deleted_at = now(), deleted_by = $2
              WHERE company_id = $1 AND role = 'ctr_agent' AND deleted_at IS NULL`,
            [id, performer?.sub ?? null],
          ),
      );
      // CURRENT_TIMESTAMP of the same transaction: the same moment as the contacts'
      await manager.softDelete(Company, id);
    });
  }

  /**
   * GET /companies/trash: deleted companies, the latest deletion first, with how many contacts and
   * own deals they have — a company deleted by mistake can be found and restored (there was no way).
   */
  async trash(query: SearchCompanyDto): Promise<PaginationResponseDto<any>> {
    const limit = this.helperService.normalizeLimit(query.limit);
    const skip = this.helperService.normalizeSkip(query.skip);
    const params: unknown[] = [];
    const bind = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = ['c.deleted_at IS NOT NULL'];
    const text = String(query.q ?? query.name ?? '').trim();
    if (text) where.push(`c.name ILIKE ${bind(`%${text}%`)}`);
    const rows: any[] = await this.dataSource.query(
      `SELECT c.id, c.name, c.phone, c.email, c.inn, c.deleted_at, c.created_at,
              (SELECT count(*) FROM "user" u WHERE u.company_id = c.id AND u.role = 'ctr_agent'
                  AND (u.deleted_at IS NULL OR u.deleted_at = c.deleted_at)) AS contact_count,
              (SELECT count(*) FROM deal d WHERE d.company_id = c.id AND d.deleted_at IS NULL) AS deal_count,
              COUNT(*) OVER () AS total_count
         FROM company c
        WHERE ${where.join(' AND ')}
        ORDER BY c.deleted_at DESC, c.id DESC
        LIMIT ${bind(limit)} OFFSET ${bind(skip)}`,
      params,
    );
    const response = new PaginationResponseDto<any>();
    response.count = rows.length ? Number(rows[0].total_count) : 0;
    response.page_size = limit;
    response.current_page = Math.floor(skip / limit) + 1;
    response.last_page = this.helperService.calculateLastPage(response.count, limit);
    response.data = rows.map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      inn: row.inn,
      deleted_at: row.deleted_at,
      created_at: row.created_at,
      contact_count: Number(row.contact_count),
      deal_count: Number(row.deal_count),
    }));
    return response;
  }

  /** PATCH /companies/:id/restore: the company is back in the lists, unless a live company took its name meanwhile. */
  async restore(id: number): Promise<void> {
    const rows: { id: number; name: string; inn: string | null }[] = await this.dataSource.query(
      `SELECT id, name, inn FROM company WHERE id = $1 AND deleted_at IS NOT NULL`,
      [id],
    );
    if (!rows.length) throw new NotFoundException(`Deleted company ${id} not found`);
    // the name and the ИНН are unique among the live companies (IDX_company_name_live, IDX_company_inn_live)
    await this.assertNameIsFree(rows[0].name, id);
    await this.assertInnIsFree(rows[0].inn, id);
    try {
      await this.dataSource.transaction(async (manager) => {
        // the contacts that went to the trash with the company (the same moment, see delete) come back with it;
        // a contact deleted on its own before stays deleted
        const withCompany = (a: string) =>
          `${a}.company_id = $1 AND ${a}.role = 'ctr_agent' AND ${a}.deleted_at = (SELECT c.deleted_at FROM company c WHERE c.id = $1)`;
        await AuditJournal.around(manager, 'user', withCompany('t'), [id], () =>
          manager.query(`UPDATE "user" u SET deleted_at = NULL, deleted_by = NULL WHERE ${withCompany('u')}`, [id]),
        );
        await manager.restore(Company, id);
      });
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') throw new ConflictException(this.duplicateMessage(error));
      throw error;
    }
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
