import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { RoleEnum, User } from './user.entity';
import { DataSource, In, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { CreateUserDto, CreateUserFillerDto } from './dto/create.user.dto';
import * as bcrypt from 'bcryptjs';
import { UserFiller } from './user.filler.entity';
import { FillableTablesEnum, Filler } from '../filler/filler.entity';
import { FillerService } from '../filler/filler.service';
import {
  ChangeOwnPasswordDto,
  UpdateOwnProfileDto,
  UpdateUserDto,
  UpdateUserFillerDto,
} from './dto/update.user.dto';
import { SearchUserQueryDto, StaffQueryDto } from './dto/search.user.query.dto';
import { HelperService } from '../helper/helper.service';
import {
  PaginationRequestDto,
  PaginationResponseDto,
} from '../helper/dto/pagination.dto';
import { Company } from '../company/company.entity';
import { Group } from '../group/group.entity';
import { Field, FieldValueEventDto } from '../events/dto/field.value.event.dto';
import { EventTypes, FieldsOf } from '../events/event.entity';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { File } from '../file/file.entity';
import { SIGNED_OUT_EVENT, signOutEverywhere } from '../auth/sign-out';
import { Access } from '../auth/access';
import { AuthUser } from '../auth/auth.guard';
import { normalizePhone, phoneKey, phoneKeySql } from '../helper/phone';

/** Staff accounts; ctr_agent rows are customer contacts. */
export const STAFF_ROLES = [RoleEnum.ADMIN, RoleEnum.MANAGER, RoleEnum.AGENT];

/** TypeORM answers [rows, count] to UPDATE ... RETURNING on Postgres. */
function returnedRows(result: any): any[] {
  return Array.isArray(result?.[0]) ? result[0] : Array.isArray(result) ? result : [];
}

/** What updateCtrAgent() accepts: the contact card's PATCH, or a contact of the company card. */
export type CtrAgentChanges = Partial<UpdateUserDto> & {
  // a custom field by its definition (the company card shows one input per field): set or cleared
  fillers_set?: { filler_id: number; value: string }[];
};

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(UserFiller)
    private userFillerRepository: Repository<UserFiller>,
    @InjectRepository(File)
    private fileRepository: Repository<File>,
    private fillerService: FillerService,
    private helperService: HelperService,
    private eventEmitter: EventEmitter2,
    private dataSource: DataSource,
    private jwtService: JwtService,
  ) {}

  async findById(id: number, withRelations: boolean = false): Promise<User> {
    const options = { where: { id } };
    if (withRelations) {
      options['relations'] = [
        'user_fillers',
        'user_fillers.filler',
        'company',
        'group',
      ];
    }
    const user = await this.userRepository.findOne(options);

    if (!user) {
      throw new NotFoundException(`User with id ${id} does not exist!`);
    }

    return user;
  }

  async fetchUserFiles(
    id: number,
    query: PaginationRequestDto,
  ): Promise<PaginationResponseDto<File[]>> {
    const qb = this.fileRepository
      .createQueryBuilder('t0')
      .where('t0.uploaded_by = :user_id', { user_id: id });

    return this.helperService.withPagination(
      this.helperService.withRelations(qb, ['deals', 'uploaded_by']),
      query,
    );
  }

  async findByIds(ids: number[]): Promise<User[]> {
    // Filter out duplicate ids
    ids = [...new Set(ids)];

    const users = await this.userRepository.findBy({ id: In(ids) });

    if (ids.length !== users.length) {
      this.throwExceptionWithNonExistingUsers(ids, users);
    }

    return users;
  }

  /**
   * GET /users: staff accounts and customer contacts. `requester` limits the contacts to the
   * user's contact view scope (Access.contactSql); staff accounts are always listed.
   */
  async fetchAll(
    query: SearchUserQueryDto,
    requester?: AuthUser,
  ): Promise<PaginationResponseDto<User[]>> {
    let qb = this.userRepository.createQueryBuilder('t0');

    // andWhere: a second .where() replaced the first, so role=agent dropped the name filter
    if (query.username) {
      qb = qb.andWhere('t0.username ILIKE :name', {
        name: `%${query.username}%`,
      });
    }

    if (query.role && (Object.values(RoleEnum) as string[]).includes(query.role)) {
      qb = qb.andWhere('t0.role = :role', {
        role: query.role,
      });
    }

    if (query.staff === 'true') {
      qb = qb.andWhere('t0.role IN (:...staff_roles)', { staff_roles: STAFF_ROLES });
    }

    if (requester) {
      const scope = new Access(requester).contactSql('t0', 'view');
      if (scope.sql !== 'TRUE') {
        qb = qb.andWhere(`(t0.role <> :contact_role OR ${scope.sql})`, {
          contact_role: RoleEnum.CTR_AGENT,
          ...scope.params,
        });
      }
    }

    // a stable order when none is asked for: by name, as the pickers show it
    if (!query.sort) {
      qb = qb.orderBy('t0.username', 'ASC').addOrderBy('t0.id', 'ASC');
    }

    return this.helperService.withPagination(
      this.helperService.withRelations(qb, ['group', 'company']),
      query,
    );
  }

  /**
   * GET /users/staff: the staff accounts (admin, manager, agent) for the pickers and filters of the
   * responsible user and the assignee: by name, without a page limit. GET /users mixes them with the
   * contacts that Telegram, WhatsApp and calls keep adding, and pages them by at most 1000 rows.
   * with_deleted=true adds removed employees (deleted_at is set) for the filters of their old records.
   */
  async fetchStaff(query: StaffQueryDto): Promise<PaginationResponseDto<User[]>> {
    const qb = this.userRepository
      .createQueryBuilder('t0')
      .leftJoinAndSelect('t0.group', 'group')
      .where('t0.role IN (:...staff_roles)', { staff_roles: STAFF_ROLES })
      .orderBy('t0.username', 'ASC')
      .addOrderBy('t0.id', 'ASC');
    if (query.with_deleted === 'true') qb.withDeleted();
    if (query.username) qb.andWhere('t0.username ILIKE :name', { name: `%${query.username}%` });

    const data = await qb.getMany();
    const response = new PaginationResponseDto<User[]>();
    response.data = data;
    response.count = data.length;
    response.page_size = Math.max(1, data.length);
    response.current_page = 1;
    response.last_page = 1;
    return response;
  }

  /**
   * According to business logic there will not be too many managers.
   * So no need for pagination!
   */
  async getManagerStatistics(
    query: PaginationRequestDto,
  ): Promise<Record<string, any>> {
    const [orderBy, orderByType] = this.helperService.validateAndGetSortOptions(
      query,
      [
        'id',
        'phone',
        'username',
        'created_at',
        'deal_count',
        'average_budget',
        'new_client_count',
        'total_call_duration',
        'average_telegram_response_time',
        'average_email_response_time',
      ],
    );

    const qb = this.userRepository
      .createQueryBuilder('t0')
      .leftJoin('t0.created_deals', 't1')
      .select('t0.id', 'id')
      .addSelect('t0.phone', 'phone')
      .addSelect('t0.email', 'email')
      .addSelect('t0.username', 'username')
      .addSelect('t0.created_at', 'created_at')
      .addSelect('COUNT(t1.id)', 'deal_count')
      .addSelect('AVG(t1.budget)', 'average_budget')
      .addSelect(
        '(select count(a1.id) from company a1 where a1.created_by = t0.id and a1.is_old = false)',
        'new_client_count',
      )
      .addSelect(
        `(select COALESCE(SUM(a2.duration), 0) from event a2 
        where a2.type IN (${EventTypes.NEW_CALL_RECORDING}, ${EventTypes.NEW_TELEGRAM_CALL}) AND 
        (a2.user_id = t0.id or
        a2.target_user_id = t0.id) AND
        a2.duration is not null
        )`,
        'total_call_duration',
      )
      .addSelect(
        `(select AVG(EXTRACT(EPOCH FROM (a3.replied_at - a3.created_at))) from event a3 
        left join deal a4 on a4.id = a3.deal_id
        where a3.type = ${EventTypes.NEW_TELEGRAM_MESSAGE} and
        a3.replied_at IS NOT NULL and
        a4.created_by = t0.id
        )`,
        'average_telegram_response_time',
      )
      .addSelect(
        `(select AVG(EXTRACT(EPOCH FROM (a3.replied_at - a3.created_at))) from event a3 
        left join deal a4 on a4.id = a3.deal_id
        where a3.type = ${EventTypes.NEW_EMAIL} and
        a3.replied_at IS NOT NULL and
        a4.created_by = t0.id
        )`,
        'average_email_response_time',
      )
      .groupBy('t0.id')
      .orderBy(orderBy, orderByType)
      .where('t0.role = :role', { role: RoleEnum.MANAGER });

    const result = await qb.getRawMany();

    const response = [];

    if (result.length === 0) {
      return [];
    }

    result.forEach((row) => {
      response.push({
        id: row.id,
        username: row.username,
        email: row.email,
        phone: row.phone,
        created_at: row.created_at,
        deal_count: +row.deal_count,
        average_budget: +row.average_budget,
        new_client_count: +row.new_client_count,
        total_call_duration: +row.total_call_duration,
        average_telegram_response_time: +row.average_telegram_response_time,
        average_email_response_time: +row.average_email_response_time,
      });
    });

    return response;
  }

  /**
   * ctr_agent (a customer contact) may be created by any staff user,
   * a staff account (admin / manager / agent) only by an admin.
   */
  async createUser(
    role: RoleEnum,
    data: CreateUserDto,
    request: Request,
  ): Promise<User> {
    if (data.role !== RoleEnum.CTR_AGENT && role !== RoleEnum.ADMIN) {
      throw new ForbiddenException('Only admin can create staff accounts');
    }

    if (await this.checkIfUserEmailExists(data.email)) {
      throw new BadRequestException(
        `User with email ${data.email} already exists!`,
      );
    }

    // Handle CTR_AGENT separately because the logic vastly differs
    if (data.role === RoleEnum.CTR_AGENT) {
      return this.createCtrAgent(data, request);
    }

    const salt = await bcrypt.genSalt(10);

    const newUser = new User();
    newUser.username = data.username;
    newUser.email = data.email;
    newUser.password = await bcrypt.hash(data.password, salt);
    newUser.role = data.role;
    newUser.group = await this.helperService.getById(Group, data.group_id);
    newUser.permissions = data.permissions;
    newUser.phone = data.phone;
    newUser.created_by =
      await this.helperService.extractUserFromRequest(request);

    return this.userRepository.save(newUser);
  }

  /**
   * Who of the users that are not deleted has this e-mail already (as the unique index
   * IDX_user_email_active; case does not matter: "Ivan@Mail.ru" is "ivan@mail.ru").
   * `exceptId`: the user being edited.
   */
  async checkIfUserEmailExists(email: string, exceptId?: number): Promise<User | null> {
    // findOneBy({ email: undefined }) has no condition and returns any user
    if (!email || !String(email).trim()) return null;
    const qb = this.userRepository
      .createQueryBuilder('u')
      .where('lower(u.email) = lower(:email)', { email: String(email).trim() });
    if (exceptId) qb.andWhere('u.id <> :exceptId', { exceptId });
    return qb.getOne();
  }

  /**
   * The password column is `select: false`, so it has to be asked for explicitly.
   * Soft-deleted users are not returned.
   */
  async findForLogin(email: string): Promise<User | null> {
    if (typeof email !== 'string' || !email) {
      return null;
    }

    return this.userRepository
      .createQueryBuilder('t0')
      .addSelect('t0.password')
      .where('t0.email = :email', { email })
      .getOne();
  }

  /**
   * Any staff user changes their own password, and nothing else:
   * the id comes from the token, role / permissions / group are not touched.
   */
  async changeOwnPassword(
    userId: number,
    data: ChangeOwnPasswordDto,
  ): Promise<{ access_token: string }> {
    const user = await this.userRepository
      .createQueryBuilder('t0')
      .addSelect('t0.password')
      .where('t0.id = :id', { id: userId })
      .getOne();

    if (!user || user.role === RoleEnum.CTR_AGENT || !user.password) {
      throw new ForbiddenException();
    }

    // 400 and not 401: 401 means "token is not valid" to the clients
    if (!(await bcrypt.compare(data.old_password, user.password))) {
      throw new BadRequestException('Current password is incorrect');
    }

    if (data.old_password === data.new_password) {
      throw new BadRequestException(
        'New password must differ from the current one',
      );
    }

    // the new password signs out every other device and unlinks the CRM bot (auth/sign-out.ts) ...
    const hash = await bcrypt.hash(data.new_password, 10);
    const signedOut = await this.dataSource.transaction(async (manager) => {
      await manager.update(User, { id: user.id }, { password: hash });
      return signOutEverywhere(manager, user.id);
    });
    this.eventEmitter.emit(SIGNED_OUT_EVENT, signedOut);
    // ... while this one stays signed in with a fresh token (same claims as AuthService.signIn)
    return { access_token: await this.jwtService.signAsync({ sub: user.id, tv: signedOut.tokenVersion }) };
  }

  /**
   * - ctr_agent (customer contact): any staff user may edit, role stays ctr_agent.
   * - staff account: admin only. This also covers every role change, so a
   *   manager can no longer promote somebody (or themselves) to admin.
   * Own password is changed through changeOwnPassword().
   */
  async updateUser(
    id: number,
    request: Request,
    data: UpdateUserDto,
  ): Promise<void> {
    const performer = await this.helperService.extractUserFromRequest(request);
    const user = await this.helperService.getById(User, id, ['linked_deals', 'company']);

    if (
      user.role !== RoleEnum.CTR_AGENT &&
      performer.role !== RoleEnum.ADMIN
    ) {
      throw new ForbiddenException('Only admin can edit staff accounts');
    }

    // If email is being changed check if it already exists
    if (
      data.email !== undefined &&
      (data.email ?? null) !== (user.email ?? null) &&
      (await this.checkIfUserEmailExists(data.email, user.id))
    ) {
      throw new BadRequestException(
        `User with email ${data.email} already exists!`,
      );
    }

    // Handle CTR_AGENT separately because the logic vastly differs
    if (user.role === RoleEnum.CTR_AGENT) {
      return this.updateCtrAgent(user, request, data);
    }

    if (data.role === RoleEnum.CTR_AGENT) {
      throw new BadRequestException(
        'A staff account cannot be turned into ctr_agent',
      );
    }

    if (user.role === RoleEnum.ADMIN && data.role !== RoleEnum.ADMIN) {
      await this.assertNotLastAdmin(user.id);
    }

    const salt = await bcrypt.genSalt(10);

    user.username = data.username;
    user.email = data.email;
    // not sent: unchanged; otherwise one format for every phone (helper/phone.ts)
    if (data.phone !== undefined) user.phone = normalizePhone(data.phone);

    // a new password signs the account out everywhere (token_version, see AuthGuard). A new role or new
    // rights need no new login: AuthGuard reads both from the database on every request, so they apply at once.
    const signOut = !!data.password;

    if (data.password) {
      user.password = await bcrypt.hash(data.password, salt);
    }

    user.role = data.role;
    user.group = await this.helperService.getById(Group, data.group_id);
    user.permissions = data.permissions;
    user.updated_by = performer;

    await this.userRepository.save(user);
    if (signOut) {
      // every device of the account and its CRM bot (auth/sign-out.ts)
      this.eventEmitter.emit(SIGNED_OUT_EVENT, await signOutEverywhere(this.dataSource, user.id));
    }
    return;
  }

  /**
   * ctr_agent: any staff user. Staff account: admin only, and not oneself.
   * A staff account: `successorId` (another live employee) takes over the open deals and the open
   * tasks, so they do not stay on an account nobody can pick any more (each deal's history says so);
   * the removed employee is signed out everywhere and the CRM bot is unlinked.
   */
  async deleteUser(
    id: number,
    performerId: number,
    successorId?: number,
  ): Promise<{ deals: number; tasks: number }> {
    const user = await this.helperService.getById(User, id);
    const performer = await this.helperService.getById(User, performerId);
    const staff = user.role !== RoleEnum.CTR_AGENT;

    if (staff) {
      if (performer.role !== RoleEnum.ADMIN) {
        throw new ForbiddenException('Only admin can delete staff accounts');
      }

      if (user.id === performer.id) {
        throw new BadRequestException('You cannot delete your own account');
      }
    }

    let successor: User | null = null;
    if (staff && successorId) {
      successor = await this.userRepository.findOne({ where: { id: successorId, role: In(STAFF_ROLES) } });
      if (!successor || successor.id === user.id) {
        throw new BadRequestException('Преемник — другой действующий сотрудник');
      }
    }

    const moved = await this.dataSource.transaction(async (manager) => {
      let deals: any[] = [];
      let tasks: any[] = [];
      if (successor) {
        deals = returnedRows(
          await manager.query(
            `UPDATE deal SET agent_id = $1 WHERE agent_id = $2 AND closed_at IS NULL AND deleted_at IS NULL RETURNING id`,
            [successor.id, user.id],
          ),
        );
        tasks = returnedRows(
          await manager.query(`UPDATE task SET agent_id = $1 WHERE agent_id = $2 AND closed_at IS NULL RETURNING id`, [
            successor.id,
            user.id,
          ]),
        );
      }
      await manager.update(User, { id: user.id }, { deleted_at: new Date(), deleted_by: { id: performer.id } as User });
      return { deals: deals.map((row) => Number(row.id)), tasks: tasks.length };
    });

    for (const dealId of moved.deals) {
      const eventData: FieldValueEventDto = {
        originated_by: performer,
        deal: { id: dealId } as any,
        fields: [new Field('agent', successor.username, user.username)],
        fields_of: FieldsOf.DEAL,
      };
      this.eventEmitter.emit(EventTypes.NEW_FIELD_VALUE.toString(), eventData);
    }
    if (staff) {
      // a removed employee: no token and no bot chat keeps acting as them
      this.eventEmitter.emit(SIGNED_OUT_EVENT, await signOutEverywhere(this.dataSource, user.id));
    }

    return { deals: moved.deals.length, tasks: moved.tasks };
  }

  /**
   * PATCH /users/me: a staff user changes their own name and phone (the phone is needed to connect
   * Telegram and goes into the e-mail signature); role, rights, group and e-mail stay with the admin.
   * The change is written to the journal.
   */
  async updateOwnProfile(
    userId: number,
    data: UpdateOwnProfileDto,
  ): Promise<{ id: number; username: string; phone: string | null }> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user || user.role === RoleEnum.CTR_AGENT) {
      throw new ForbiddenException();
    }

    const fields: Field[] = [];
    const changes: Partial<User> = {};
    if (data.username !== undefined && data.username !== user.username) {
      fields.push(new Field('username', data.username, user.username));
      changes.username = data.username;
    }
    if (data.phone !== undefined) {
      const phone = normalizePhone(data.phone);
      if ((phone ?? null) !== (user.phone ?? null)) {
        fields.push(new Field('phone', phone, user.phone));
        changes.phone = phone;
      }
    }

    if (fields.length) {
      await this.userRepository.update(user.id, { ...changes, updated_by: { id: user.id } as User });
      const eventData = {
        originated_by: user,
        target_user: user,
        deal: undefined,
        fields,
        fields_of: FieldsOf.USER,
      } as FieldValueEventDto;
      this.eventEmitter.emit(EventTypes.NEW_FIELD_VALUE.toString(), eventData);
    }

    return {
      id: user.id,
      username: changes.username ?? user.username,
      phone: (changes.phone !== undefined ? changes.phone : user.phone) ?? null,
    };
  }

  private async assertNotLastAdmin(adminId: number): Promise<void> {
    const otherAdmins = await this.userRepository
      .createQueryBuilder('t0')
      .where('t0.role = :role', { role: RoleEnum.ADMIN })
      .andWhere('t0.id != :id', { id: adminId })
      .getCount();

    if (otherAdmins === 0) {
      throw new BadRequestException('The last admin cannot be demoted');
    }
  }

  private throwExceptionWithNonExistingUsers(
    requestedUserIds: number[],
    existingUsers: User[],
  ): void {
    const existingUserIds = [
      ...new Set(existingUsers.map((existingUser: User) => existingUser.id)),
    ];

    // Find IDs that does not exist in database
    const nonExistingIds = requestedUserIds.filter(
      (id) => !existingUserIds.includes(id),
    );

    throw new NotFoundException(
      `Users ids: ${nonExistingIds.join(', ')} does not exist!`,
    );
  }

  /**
   * UserFillers are only for users with role CTR_AGENT
   */
  private async createCtrAgent(
    data: CreateUserDto,
    request: Request,
  ): Promise<User> {
    // a contact may have no company: it is attached later (or never)
    const company =
      data.company_id != null ? await this.helperService.getById(Company, data.company_id) : null;
    const phone = normalizePhone(data.phone);
    await this.assertPhoneIsFree(phone);
    const newCtrAgent = new User();

    newCtrAgent.username = data.username;
    newCtrAgent.email = data.email || null;
    newCtrAgent.role = RoleEnum.CTR_AGENT;
    newCtrAgent.company = company;
    newCtrAgent.phone = phone;
    newCtrAgent.created_by =
      await this.helperService.extractUserFromRequest(request);

    if (data.tg_user_id) {
      newCtrAgent.tg_id = data.tg_user_id;
    }

    const fillerValues = (data.fillers ?? []).filter((f) => f?.filler_id && String(f.value ?? '').trim());
    await this.fillerService.assertRequiredFilled(
      FillableTablesEnum.USER,
      fillerValues,
    );
    newCtrAgent.user_fillers = fillerValues.length
      ? this.createUserFillers(
          await this.fillerService.getFillersHashMap(fillerValues, FillableTablesEnum.USER),
          fillerValues,
        )
      : [];

    return this.userRepository.save(newCtrAgent);
  }

  /**
   * Telegram, WhatsApp and call recordings find the client by the phone: two contacts with one number
   * make them pick the wrong one. Compared as everywhere (helper/phone.ts): the last 9 digits, so
   * "90 123 45 67" and "+998 90 123-45-67" are the same number.
   */
  async assertPhoneIsFree(phone: string | null | undefined, exceptId?: number): Promise<void> {
    const key = phoneKey(phone);
    if (!key) return;
    const qb = this.userRepository
      .createQueryBuilder('u')
      .where('u.role = :role', { role: RoleEnum.CTR_AGENT })
      .andWhere(`${phoneKeySql('u.phone')} = :key`, { key });
    if (exceptId) qb.andWhere('u.id <> :exceptId', { exceptId });
    const same = await qb.getOne();
    if (same) {
      throw new BadRequestException(`Контакт с таким телефоном уже есть: ${same.username} (№${same.id})`);
    }
  }

  /**
   * A contact's card (PATCH /users/:id) and a contact of the company card (PATCH /companies/:id).
   * Only what is sent changes:
   * - `email` / `phone` not sent stay; "" or null clears them; the phone is stored normalized;
   * - `company_id` not sent keeps the company, null detaches the contact, a number moves it: the move is
   *   in the history, the old company drops it as its primary contact, and the contact's deals without
   *   a company get the new one (they belong to the client's company now);
   * - custom fields: `fillers` change values OF THIS CONTACT by their id ("" removes a value that is not
   *   required; an id of another contact's value is refused), `fillers_create` adds values,
   *   `fillers_set` sets a field by its definition (the company card has one input per field).
   * The change goes to the history of every deal of the contact; a contact without deals keeps it in
   * its own history (the event points at the contact).
   */
  async updateCtrAgent(
    ctrAgent: User,
    request: Request,
    data: CtrAgentChanges,
  ): Promise<void> {
    /**
     * This is later used to add events that the fields were updated in deal history
     */
    const updatedFields: Field[] = [];
    // the columns that change: written with update() — save() of a loaded contact also wrote back its
    // loaded relations (custom field values: cascade), which could restore values changed below
    const columns: Partial<User> = {};

    if (data.username !== undefined && data.username !== ctrAgent.username) {
      updatedFields.push(new Field('username', data.username, ctrAgent.username));
      ctrAgent.username = data.username;
      columns.username = data.username;
    }

    if (data.email !== undefined) {
      const email = data.email ? String(data.email).trim() : null;
      if (email !== (ctrAgent.email ?? null)) {
        if (email && (await this.checkIfUserEmailExists(email, ctrAgent.id))) {
          throw new BadRequestException(`User with email ${email} already exists!`);
        }
        updatedFields.push(new Field('email', email, ctrAgent.email));
        ctrAgent.email = email;
        columns.email = email;
      }
    }

    if (data.phone !== undefined) {
      const phone = normalizePhone(data.phone);
      if (phone !== (ctrAgent.phone ?? null)) {
        if (phoneKey(phone) !== phoneKey(ctrAgent.phone)) await this.assertPhoneIsFree(phone, ctrAgent.id);
        updatedFields.push(new Field('phone', phone, ctrAgent.phone));
        ctrAgent.phone = phone;
        columns.phone = phone;
      }
    }

    if (data.tg_user_id) {
      updatedFields.push(
        new Field('tg_user_id', `${data.tg_user_id}`, `${ctrAgent.tg_id}`),
      );
      ctrAgent.tg_id = data.tg_user_id;
      columns.tg_id = data.tg_user_id;
    }

    // the company: a move is a change of the client's company, so it is logged
    let movedFrom: Company | null = null;
    let movedTo: Company | null | undefined; // undefined: the company did not change
    if (data.company_id !== undefined) {
      const current = ctrAgent.company ?? null;
      const next =
        data.company_id === null ? null : await this.helperService.getById(Company, data.company_id);
      if ((next?.id ?? null) !== (current?.id ?? null)) {
        updatedFields.push(new Field('company', next?.name ?? null, current?.name ?? null));
        ctrAgent.company = next;
        columns.company = next ? ({ id: next.id } as Company) : null;
        movedFrom = current;
        movedTo = next;
      }
    }

    // custom fields
    const toSave: UserFiller[] = [];
    const toRemove: UserFiller[] = [];
    const change = (row: UserFiller, raw: unknown) => {
      const value = String(raw ?? '').trim();
      if (value === row.value) return;
      this.fillerService.assertNotBlank(row.filler, value);
      updatedFields.push(new Field(row.filler.field, value || null, row.value));
      if (value) {
        row.value = value;
        toSave.push(row);
      } else {
        toRemove.push(row);
      }
    };

    const byId = data.fillers ?? [];
    const rows = await this.getUserFillersByIds(
      byId.map((userFiller) => userFiller.user_filler_id),
      ctrAgent.id,
    );
    const requestedUserFillers = this.getUserFillerHashMap(byId);
    rows.forEach((row) => change(row, requestedUserFillers.get(row.id)));

    const toSet = (data.fillers_set ?? []).filter((f) => f?.filler_id);
    if (toSet.length) {
      const definitions = await this.fillerService.getFillersHashMap(toSet, FillableTablesEnum.USER);
      const existing = await this.userFillerRepository.find({
        where: { user: { id: ctrAgent.id } },
        relations: { filler: true },
        order: { id: 'ASC' },
      });
      for (const item of toSet) {
        const row = existing.find((e) => e.filler?.id === item.filler_id);
        if (row) {
          change(row, item.value);
          continue;
        }
        const value = String(item.value ?? '').trim();
        if (!value) continue;
        const created = new UserFiller();
        created.filler = definitions.get(item.filler_id);
        created.value = value;
        created.user = { id: ctrAgent.id } as User;
        toSave.push(created);
        updatedFields.push(new Field(created.filler.field, value));
      }
    }

    const toCreate = (data.fillers_create ?? []).filter(
      (f) => f?.filler_id && String(f.value ?? '').trim(),
    );
    if (toCreate.length !== 0) {
      // Create necessary user fillers
      const fillers = await this.fillerService.getFillersHashMap(
        toCreate,
        FillableTablesEnum.USER,
      );
      toCreate.forEach((filler) => {
        const newUserFiller = new UserFiller();
        newUserFiller.filler = fillers.get(filler.filler_id);
        newUserFiller.value = String(filler.value).trim();
        newUserFiller.user = { id: ctrAgent.id } as User;
        toSave.push(newUserFiller);

        updatedFields.push(
          new Field(fillers.get(filler.filler_id).field, newUserFiller.value),
        );
      });
    }

    // Was saved only together with new fields: a changed value of an existing
    // field ("Должность") was lost when no field was added at the same time.
    if (toRemove.length) {
      await this.userFillerRepository.remove(toRemove);
    }
    if (toSave.length) {
      await this.userFillerRepository.save(toSave);
    }

    const originated_by =
      await this.helperService.extractUserFromRequest(request);

    ctrAgent.updated_by = originated_by;

    await this.userRepository.update(ctrAgent.id, {
      ...columns,
      updated_by: { id: originated_by.id } as User,
    });

    if (movedTo !== undefined) {
      // the old company does not keep as its primary contact a person who is not its contact any more
      if (movedFrom) {
        await this.dataSource.query(
          `UPDATE company SET primary_contact_id = NULL WHERE id = $1 AND primary_contact_id = $2`,
          [movedFrom.id, ctrAgent.id],
        );
      }
      // the contact's deals without a company (Telegram, WhatsApp, calls) are the new company's now
      if (movedTo) {
        await this.dataSource.query(
          `UPDATE deal SET company_id = $1
            WHERE company_id IS NULL AND deleted_at IS NULL
              AND id IN (SELECT "dealId" FROM deal_user WHERE "userId" = $2)`,
          [movedTo.id, ctrAgent.id],
        );
      }
    }

    if (!updatedFields.length) return;
    const deals = ctrAgent.linked_deals ?? [];
    deals.forEach((deal) => {
      const eventData: FieldValueEventDto = {
        originated_by: originated_by,
        deal: deal,
        fields: updatedFields,
        fields_of: FieldsOf.USER,
      };
      this.eventEmitter.emit(EventTypes.NEW_FIELD_VALUE.toString(), eventData);
    });
    if (deals.length === 0) {
      const eventData: FieldValueEventDto = {
        originated_by: originated_by,
        target_user: { id: ctrAgent.id } as User,
        deal: undefined,
        fields: updatedFields,
        fields_of: FieldsOf.USER,
      };
      this.eventEmitter.emit(EventTypes.NEW_FIELD_VALUE.toString(), eventData);
    }

    return;
  }

  async getAgentCallRecordings(
    id: number,
    query: PaginationRequestDto,
  ): Promise<Record<string, any>> {
    // Getting call recording of agent
    const recordings = await this.dataSource
      .createQueryBuilder()
      .select([
        'r.id AS id',
        'r.path AS path',
        'r.from_number AS from_number',
        'r.created_at AS created_at',
      ]) // make sure to prefix created_at
      .from('recording', 'r')
      .where('r.user_id = :userId', { userId: id })
      .orderBy('r.created_at', 'DESC') // <-- order by latest first
      .limit(query.limit ? query.limit : 25)
      .offset(query.skip ? query.skip : 0)
      .getRawMany();

    return recordings;
  }

  /**
   * Values of custom fields by their ids, and only of this contact: the ids come from the request, and
   * an id of another contact's value used to change that contact's field without a trace.
   */
  private async getUserFillersByIds(ids: number[], userId: number): Promise<UserFiller[]> {
    const wanted = [...new Set(ids.filter((id) => id != null))];
    if (wanted.length === 0) return [];
    const userFillers = await this.userFillerRepository.find({
      where: { id: In(wanted), user: { id: userId } },
      relations: ['filler'],
    });

    if (userFillers.length !== wanted.length) {
      const found = new Set(userFillers.map((row) => row.id));
      throw new BadRequestException(
        `Значения доп. полей ${wanted.filter((id) => !found.has(id)).join(', ')} не относятся к этому контакту`,
      );
    }

    return userFillers;
  }

  private getUserFillerHashMap(
    data: UpdateUserFillerDto[],
  ): Map<number, string> {
    const hashMap = new Map<number, string>();

    data.forEach((userFiller) => {
      hashMap.set(userFiller.user_filler_id, userFiller.value);
    });

    return hashMap;
  }

  createUserFillers(
    fillers: Map<number, Filler>,
    data: CreateUserFillerDto[],
  ): UserFiller[] {
    const userFillers = [];

    data.forEach((userFillerData) => {
      const userFiller = new UserFiller();
      userFiller.filler = fillers.get(userFillerData.filler_id);
      userFiller.value = userFillerData.value;

      userFillers.push(userFiller);
    });

    return userFillers;
  }
}
