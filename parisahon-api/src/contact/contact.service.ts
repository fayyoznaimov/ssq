import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { RoleEnum } from '../user/user.entity';
import { DataSource, In, Repository } from 'typeorm';
import { Company } from '../company/company.entity';
import {
  PaginationRequestDto,
  PaginationResponseDto,
} from '../helper/dto/pagination.dto';
import {
  ContactCompanyDto,
  ContactDto,
  ContactRowDto,
  ContactTypes,
} from './dto/contact.dto';
import { UserFiller } from '../user/user.filler.entity';
import { CompanyFiller } from '../company/company.filler.entity';
import { SearchContactDto } from './dto/search.contact.dto';
import {
  TaskTypeDateRange,
  TaskTypes,
  TaskTypesToWeights,
} from '../deal/dto/search.deal.dto';
import { HelperService } from '../helper/helper.service';

@Injectable()
export class ContactService {
  constructor(
    @InjectRepository(UserFiller)
    private userFillerRepository: Repository<UserFiller>,
    @InjectRepository(CompanyFiller)
    private companyFillerRepository: Repository<CompanyFiller>,
    @InjectRepository(Company)
    private dataSource: DataSource,
    private helperService: HelperService,
  ) {}

  async fetchAll(
    query: SearchContactDto,
  ): Promise<PaginationResponseDto<ContactDto[]>> {
    const [sortBy, sortByType] = this.performAdditionalValidations(query);

    const [filtrationQuery, argumentToValuesMap] =
      this.createFiltrationQueryString(query, 4);

    const [userQuery, companyQuery] =
      this.createUserAndCompanyFiltrationQueries(query.tasks, query.stages);

    /**
     * Using RAW sql for better control over the query!
     */
    const unionQuery = `
      WITH union_results_with_count AS (
        SELECT 'user' AS type, u.id, u.username AS name, u.email, u.company_id, c.name AS company_name, u.phone,
        u.updated_at, u.created_at, u.created_by, u.updated_by
        FROM public.user u
        LEFT JOIN public.company c ON u.company_id = c.id AND c.deleted_at IS NULL
        ${userQuery ? userQuery + ' AND ' : ' WHERE '}
        u.role = $1 AND u.deleted_at IS NULL
        UNION
        SELECT 'company' AS type, cmpn.id, cmpn.name, cmpn.email, NULL AS company_id, NULL AS company_name, cmpn.phone,
        cmpn.updated_at, cmpn.created_at, cmpn.created_by, cmpn.updated_by
        FROM public.company cmpn
        ${companyQuery ? companyQuery + ' AND ' : ' WHERE '}
        cmpn.deleted_at IS NULL
      )
      SELECT *, COUNT(*) OVER() as total_count
      FROM union_results_with_count
      ${filtrationQuery}
      ORDER BY ${sortBy === 'company' ? 'company_name' : sortBy} ${sortByType}
      LIMIT $2
      OFFSET $3;
    `;

    const parameters: any[] = [
      RoleEnum.CTR_AGENT,
      query.limit ?? 25,
      query.skip ?? 0,
    ];

    if (argumentToValuesMap.size > 0) {
      argumentToValuesMap.forEach((value, index) => {
        parameters[Number(index) - 1] = value;
      });
    }

    const result: ContactRowDto[] = await this.dataSource.query(
      unionQuery,
      parameters,
    );

    const totalCount = result.length > 0 ? result[0]['total_count'] : 0;

    /**
     * Extract ids and fetch entities!
     */
    const [userIds, companyIds] = this.gatherCompanyAndUserIds(result);
    const [userFillers, companyFillers] = await this.fetchEntities(
      userIds,
      companyIds,
    );

    /**
     * Create necessary hash maps!
     *
     * These are used to structure the data
     * to make it convenient and faster to build final response data!
     */
    const additionalHashMaps = this.createNecessaryHashMaps(
      companyFillers,
      userFillers,
    );

    /**
     * Prepare the response!
     */
    const responseData: ContactDto[] = this.prepareResponseData(
      result,
      additionalHashMaps,
    );

    /**
     * Appending the response data to pagination data!
     */
    const response = new PaginationResponseDto<ContactDto[]>();
    // `employees` is now a SQL condition (see createFiltrationQueryString):
    // filtering the page after LIMIT gave short pages and a wrong total.
    response.data = responseData;

    response.count = Number(totalCount);
    response.page_size = Number(query.limit ?? 25);
    response.current_page = Math.floor(query.skip / query.limit + 1);
    response.last_page = Math.floor(response.count / query.limit + 1);

    return response;
  }

  private createUserAndCompanyFiltrationQueries(
    tasks: TaskTypes[],
    stages: number[],
  ): (string | null)[] {
    let userQuery = null;
    let companyQuery = null;

    const userWhereQueries: string[] = [];
    const companyWhereQueries: string[] = [];

    if ((tasks && tasks.length > 0) || (stages && stages.length > 0)) {
      userQuery = `LEFT JOIN deal_user AS dlusr ON dlusr."userId" = u.id LEFT JOIN deal AS dl ON dlusr."dealId" = dl.id`;
      companyQuery = 'LEFT JOIN deal AS dl1 ON dl1.company_id = cmpn.id';

      if (tasks && tasks.length > 0) {
        userQuery += ' LEFT JOIN task AS tsk ON tsk.deal_id = dl.id';
        companyQuery += ' LEFT JOIN task AS tsk1 ON tsk1.deal_id = dl1.id';

        // Deals with no tasks
        if (tasks.includes(TaskTypes.NO_TASK)) {
          userWhereQueries.push('tsk.id IS NULL');
          companyWhereQueries.push('tsk1.id IS NULL');
        }

        // Deals with tasks that are overdue
        if (tasks.includes(TaskTypes.OVERDUE)) {
          userWhereQueries.push(
            `tsk.end_time < '${new Date().toISOString()}' AND tsk.closed_at IS NULL`,
          );
          companyWhereQueries.push(
            `tsk1.end_time < '${new Date().toISOString()}' AND tsk1.closed_at IS NULL`,
          );
        }

        /**
         * If requested for tasks that has overlapping times with today and tomorrow
         * Combine the two
         */
        if (
          tasks.includes(TaskTypes.TOMORROW) &&
          tasks.includes(TaskTypes.TODAY)
        ) {
          const start = new Date();
          start.setUTCHours(0, 0, 0, 0);

          const end = new Date(+new Date() + 86400000);
          end.setUTCHours(23, 59, 59, 999);

          userWhereQueries.push(
            `(tsk.start_time, tsk.end_time) OVERLAPS ('${start.toUTCString()}', '${end.toUTCString()}') AND tsk.closed_at IS NULL`,
          );
          companyWhereQueries.push(
            `(tsk1.start_time, tsk1.end_time) OVERLAPS ('${start.toUTCString()}', '${end.toUTCString()}') AND tsk1.closed_at IS NULL`,
          );
        }

        /**
         * Find the biggest range and apply.
         * ['today', 'this_week', 'this_month'] is the same as ['this_month']
         */
        const maxWeightTaskRangeType =
          this.helperService.getEnumWithMaxRange(tasks);
        if (TaskTypesToWeights.get(maxWeightTaskRangeType) > 0) {
          const [startTime, endTime] =
            TaskTypeDateRange[maxWeightTaskRangeType]();

          userWhereQueries.push(
            `(tsk.start_time, tsk.end_time) OVERLAPS ('${startTime}', '${endTime}') AND tsk.closed_at IS NULL`,
          );
          companyWhereQueries.push(
            `(tsk1.start_time, tsk1.end_time) OVERLAPS ('${startTime}', '${endTime}') AND tsk1.closed_at IS NULL`,
          );
        }
      }
    }

    if (userWhereQueries.length > 0 || (stages && stages.length > 0)) {
      userQuery += ' WHERE ';
      if (userWhereQueries.length > 0) {
        userQuery +=
          '(' +
          userWhereQueries.map((whereQuery) => `(${whereQuery})`).join(' OR ') +
          ')';
        if (stages && stages.length > 0) {
          userQuery += ' AND ';
        }
      }
      if (stages && stages.length > 0) {
        userQuery += `dl.stage_id IN (${stages.join(',')})`;
      }
    }

    if (companyWhereQueries.length > 0 || (stages && stages.length > 0)) {
      companyQuery += ' WHERE ';
      if (companyWhereQueries.length > 0) {
        companyQuery +=
          '(' +
          companyWhereQueries
            .map((whereQuery) => `(${whereQuery})`)
            .join(' OR ') +
          ')';
        if (stages && stages.length > 0) {
          companyQuery += ' AND ';
        }
      }
      if (stages && stages.length > 0) {
        companyQuery += `dl1.stage_id IN (${stages.join(',')})`;
      }
    }

    return [userQuery, companyQuery];
  }

  private createFiltrationQueryString(
    data: SearchContactDto,
    shift: number = 0,
  ): [string, Map<number, any>] {
    const queries = [];
    let argumentNumber = shift;
    const argumentToValues = new Map<number, any>();

    if (data.name) {
      queries.push(`name ILIKE $${argumentNumber}`);
      argumentToValues.set(argumentNumber, `%${data.name}%`);
      argumentNumber++;
    }

    if (data.phone) {
      // "+998 90 111 00 03" finds "+998901110003": digits are compared
      const digits = String(data.phone).replace(/[^0-9]/g, '');
      if (digits) {
        queries.push(`regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE $${argumentNumber}`);
        argumentToValues.set(argumentNumber, `%${digits}%`);
      } else {
        queries.push(`phone ILIKE $${argumentNumber}`);
        argumentToValues.set(argumentNumber, `%${data.phone}%`);
      }
      argumentNumber++;
    }

    if (data.email) {
      queries.push(`email ILIKE $${argumentNumber}`);
      argumentToValues.set(argumentNumber, `%${data.email}%`);
      argumentNumber++;
    }

    if (data.created_by) {
      queries.push(`created_by = $${argumentNumber}`);
      argumentToValues.set(argumentNumber, data.created_by);
      argumentNumber++;
    }

    if (data.updated_by) {
      queries.push(`updated_by = $${argumentNumber}`);
      argumentToValues.set(argumentNumber, data.updated_by);
      argumentNumber++;
    }

    if (data.created_before) {
      queries.push(`created_at < $${argumentNumber}`);
      argumentToValues.set(argumentNumber, data.created_before);
      argumentNumber++;
    }

    if (data.created_after) {
      queries.push(`created_at > $${argumentNumber}`);
      argumentToValues.set(argumentNumber, data.created_after);
      argumentNumber++;
    }

    if (data.updated_before) {
      queries.push(`updated_at < $${argumentNumber}`);
      argumentToValues.set(argumentNumber, data.updated_before);
      argumentNumber++;
    }

    if (data.updated_after) {
      queries.push(`updated_at > $${argumentNumber}`);
      argumentToValues.set(argumentNumber, data.updated_after);
      argumentNumber++;
    }

    // employees=true: contacts attached to a (live) company;
    // employees=false: companies and contacts without a company
    if (data.employees === 'true') {
      queries.push(`type = 'user' AND company_name IS NOT NULL`);
    } else if (data.employees === 'false') {
      queries.push(`company_name IS NULL`);
    }

    return [
      queries.length ? `WHERE ${queries.join(' AND ')}` : '',
      argumentToValues,
    ];
  }

  /**
   * I'm including this validation here to keep the compatibility with other
   * endpoint sorting options.
   *
   * Possibly was better to do it using validation pipes,
   * but this way is just easier;)
   *
   * Also get sort by option while at it!
   */
  private performAdditionalValidations(query: PaginationRequestDto): string[] {
    let sortBy = 'id';
    let sortByType = 'ASC';

    if (query.sort) {
      if (Object.keys(query.sort).length > 1) {
        throw new BadRequestException({
          message: ['You can only sort by one field at a time!'],
          error: 'Bad Request',
          statusCode: 400,
        });
      }

      if (Object.keys(query.sort).length != 0) {
        if (
          !['name', 'email', 'phone', 'company', 'id'].includes(
            Object.keys(query.sort)[0],
          )
        ) {
          throw new BadRequestException({
            message: [
              'each value in sort must be one of the following values: id, name, email, phone, company',
            ],
            error: 'Bad Request',
            statusCode: 400,
          });
        }
        sortBy = Object.keys(query.sort)[0];
        if (query.sort[sortBy].includes('-')) {
          sortByType = 'DESC';
        }
      }
    }

    return [sortBy, sortByType];
  }

  private gatherCompanyAndUserIds(result: ContactRowDto[]): number[][] {
    const userIds = [];
    const companyIds = [];

    result.forEach((record) => {
      if (record.type === 'user') {
        userIds.push(record.id);
      } else {
        companyIds.push(record.id);
      }
    });

    return [userIds, companyIds];
  }

  private async fetchEntities(
    userIds: number[],
    companyIds: number[],
  ): Promise<[UserFiller[], CompanyFiller[]]> {
    const companyFillers = await this.companyFillerRepository.find({
      where: { company: In(companyIds) },
      relations: ['filler', 'company'],
    });

    const userFillers = await this.userFillerRepository.find({
      where: { user: In(userIds) },
      relations: ['filler', 'user'],
    });

    return [userFillers, companyFillers];
  }

  /**
   * Prepare the response data before appending it to pagination data!
   */
  private prepareResponseData(
    result: ContactRowDto[],
    hashMaps: Map<number, string[]>[],
  ): ContactDto[] {
    const responseData: ContactDto[] = [];
    const [
      userIdToEmailsMap,
      userIdToPhoneNumbersMap,
      companyIdToEmailsMap,
      companyIdToPhoneNumbersMap,
    ] = hashMaps;

    /**
     * Transform and append each row!
     */
    result.forEach((row) => {
      const newContactRowDto = new ContactDto();

      newContactRowDto.type =
        row.type === 'user' ? ContactTypes.CTR_AGENT : ContactTypes.COMPANY;

      newContactRowDto.id = row.id;
      newContactRowDto.name = row.name;
      newContactRowDto.phones = [];
      newContactRowDto.emails = [];
      newContactRowDto.company = null;

      /**
       * Append phone number from entity itself!
       */
      if (row.phone) {
        newContactRowDto.phones.push(row.phone);
      }

      /**
       * Append email from entity itself!
       */
      if (row.email) {
        newContactRowDto.emails.push(row.email);
      }

      /**
       * Append additional phone numbers and emails from Fillers!
       */
      if (row.type === 'user') {
        if (userIdToPhoneNumbersMap.get(row.id)) {
          newContactRowDto.phones.push(...userIdToPhoneNumbersMap.get(row.id));
        }

        if (userIdToEmailsMap.get(row.id)) {
          newContactRowDto.emails.push(...userIdToEmailsMap.get(row.id));
        }
      }
      if (row.type === 'company') {
        if (companyIdToPhoneNumbersMap.get(row.id)) {
          newContactRowDto.phones.push(
            ...companyIdToPhoneNumbersMap.get(row.id),
          );
        }

        if (companyIdToEmailsMap.get(row.id)) {
          newContactRowDto.emails.push(...companyIdToEmailsMap.get(row.id));
        }
      }

      /**
       * Append custom company information if exists!
       */
      if (row.company_name) {
        const newContactCompanyDto = new ContactCompanyDto();

        newContactCompanyDto.name = row.company_name;
        newContactCompanyDto.id = row.company_id;

        newContactRowDto.company = newContactCompanyDto;
      }

      responseData.push(newContactRowDto);
    });

    return responseData;
  }

  /**
   * Appending any other additional phone or email information that are linked
   * to companies or users in a form of Fillers.
   *
   * Reminder: Fillers are just additional fields!
   */
  private createNecessaryHashMaps(
    companyFillers: CompanyFiller[],
    userFillers: UserFiller[],
  ): Map<number, string[]>[] {
    const userIdToPhoneNumbersMap = new Map<number, string[]>();
    const userIdToEmailsMap = new Map<number, string[]>();
    const companyIdToPhoneNumbersMap = new Map<number, string[]>();
    const companyIdToEmailsMap = new Map<number, string[]>();

    // Append data from company fillers
    companyFillers.forEach((companyFiller) => {
      if (companyFiller.filler.field === 'phone') {
        const phoneNumbers =
          companyIdToPhoneNumbersMap.get(companyFiller.company.id) ?? [];

        companyIdToPhoneNumbersMap.set(companyFiller.company.id, [
          ...phoneNumbers,
          companyFiller.value,
        ]);
        return;
      }

      if (companyFiller.filler.field === 'email') {
        const emails = companyIdToEmailsMap.get(companyFiller.company.id) ?? [];

        companyIdToEmailsMap.set(companyFiller.company.id, [
          ...emails,
          companyFiller.value,
        ]);
      }
    });

    // Append data from user fillers
    userFillers.forEach((userFiller) => {
      if (userFiller.filler.field === 'phone') {
        const phoneNumbers =
          userIdToPhoneNumbersMap.get(userFiller.user.id) ?? [];

        userIdToPhoneNumbersMap.set(userFiller.user.id, [
          ...phoneNumbers,
          userFiller.value,
        ]);
        return;
      }

      if (userFiller.filler.field === 'email') {
        const emails = userIdToEmailsMap.get(userFiller.user.id) ?? [];

        userIdToEmailsMap.set(userFiller.user.id, [
          ...emails,
          userFiller.value,
        ]);
      }
    });

    return [
      userIdToEmailsMap,
      userIdToPhoneNumbersMap,
      companyIdToEmailsMap,
      companyIdToPhoneNumbersMap,
    ];
  }
}
