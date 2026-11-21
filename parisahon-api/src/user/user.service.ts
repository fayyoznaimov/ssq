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
  UpdateUserDto,
  UpdateUserFillerDto,
} from './dto/update.user.dto';
import { SearchUserQueryDto } from './dto/search.user.query.dto';
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
import { Request } from 'express';
import { File } from '../file/file.entity';

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

  async fetchAll(
    query: SearchUserQueryDto,
  ): Promise<PaginationResponseDto<User[]>> {
    let qb = this.userRepository.createQueryBuilder('t0');

    if (query.username) {
      qb = qb.where('t0.username ILIKE :name', {
        name: `%${query.username}%`,
      });
    }

    if (query.role === 'agent') {
      qb = qb.where('t0.role = :role', {
        role: query.role,
      });
    }

    return this.helperService.withPagination(
      this.helperService.withRelations(qb, ['group', 'company']),
      query,
    );
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

  async checkIfUserEmailExists(email: string): Promise<User | null> {
    // findOneBy({ email: undefined }) has no condition and returns any user
    if (!email) return null;
    return this.userRepository.findOneBy({ email: email });
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
  ): Promise<void> {
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

    // the new password signs out every other device (token_version, see AuthGuard)
    await this.userRepository.update(
      { id: user.id },
      { password: await bcrypt.hash(data.new_password, 10), token_version: () => 'token_version + 1' } as any,
    );
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
    const user = await this.helperService.getById(User, id, ['linked_deals']);

    if (
      user.role !== RoleEnum.CTR_AGENT &&
      performer.role !== RoleEnum.ADMIN
    ) {
      throw new ForbiddenException('Only admin can edit staff accounts');
    }

    // If email is being changed check if it already exists
    if (
      user.email !== data.email &&
      (await this.checkIfUserEmailExists(data.email))
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
    user.phone = data.phone;

    // a new password, role or rights signs the account out everywhere (token_version, see AuthGuard)
    const signOut =
      !!data.password ||
      user.role !== data.role ||
      JSON.stringify(user.permissions ?? null) !== JSON.stringify(data.permissions ?? null);

    if (data.password) {
      user.password = await bcrypt.hash(data.password, salt);
    }

    user.role = data.role;
    user.group = await this.helperService.getById(Group, data.group_id);
    user.permissions = data.permissions;
    user.updated_by = performer;

    await this.userRepository.save(user);
    if (signOut) {
      await this.userRepository
        .createQueryBuilder()
        .update(User)
        .set({ token_version: () => 'token_version + 1' } as any)
        .where('id = :id', { id: user.id })
        .execute();
    }
    return;
  }

  /**
   * ctr_agent: any staff user. Staff account: admin only, and not oneself.
   */
  async deleteUser(id: number, performerId: number): Promise<void> {
    const user = await this.helperService.getById(User, id);
    const performer = await this.helperService.getById(User, performerId);

    if (user.role !== RoleEnum.CTR_AGENT) {
      if (performer.role !== RoleEnum.ADMIN) {
        throw new ForbiddenException('Only admin can delete staff accounts');
      }

      if (user.id === performer.id) {
        throw new BadRequestException('You cannot delete your own account');
      }
    }

    user.deleted_at = new Date();
    user.deleted_by = performer;

    await this.userRepository.save(user);

    return;
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
    const company = await this.helperService.getById(Company, data.company_id);
    await this.assertPhoneIsFree(data.phone);
    const newCtrAgent = new User();

    newCtrAgent.username = data.username;
    newCtrAgent.email = data.email;
    newCtrAgent.role = RoleEnum.CTR_AGENT;
    newCtrAgent.company = company;
    newCtrAgent.phone = data.phone;
    newCtrAgent.created_by =
      await this.helperService.extractUserFromRequest(request);

    if (data.tg_user_id) {
      newCtrAgent.tg_id = data.tg_user_id;
    }

    await this.fillerService.assertRequiredFilled(
      FillableTablesEnum.USER,
      data.fillers,
    );
    const fillers = await this.fillerService.getFillersHashMap(data.fillers, FillableTablesEnum.USER);
    newCtrAgent.user_fillers = this.createUserFillers(fillers, data.fillers);

    return this.userRepository.save(newCtrAgent);
  }

  /**
   * Telegram, WhatsApp and call recordings find the client by the digits of the phone:
   * two contacts with one number make them pick the wrong one.
   */
  async assertPhoneIsFree(phone: string | null | undefined, exceptId?: number): Promise<void> {
    const digits = String(phone ?? '').replace(/[^0-9]/g, '');
    if (digits.length < 7) return;
    const qb = this.userRepository
      .createQueryBuilder('u')
      .where('u.role = :role', { role: RoleEnum.CTR_AGENT })
      .andWhere("regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g') = :digits", { digits });
    if (exceptId) qb.andWhere('u.id <> :exceptId', { exceptId });
    const same = await qb.getOne();
    if (same) {
      throw new BadRequestException(`Контакт с таким телефоном уже есть: ${same.username} (№${same.id})`);
    }
  }

  async updateCtrAgent(
    ctrAgent: User,
    request: Request,
    data: UpdateUserDto,
  ): Promise<void> {
    const company = await this.helperService.getById(Company, data.company_id);
    if (data.phone !== ctrAgent.phone) await this.assertPhoneIsFree(data.phone, ctrAgent.id);

    /**
     * This is later used to add events that the fields were updated in deal history
     */
    const updatedFields: Field[] = [];

    updatedFields.push(new Field('username', data.username, ctrAgent.username));
    ctrAgent.username = data.username;

    updatedFields.push(new Field('email', data.email, ctrAgent.email));
    ctrAgent.email = data.email;
    updatedFields.push(new Field('phone', data.phone, ctrAgent.phone));
    ctrAgent.phone = data.phone;
    ctrAgent.company = company;

    if (data.tg_user_id) {
      updatedFields.push(
        new Field('tg_user_id', `${data.tg_user_id}`, `${ctrAgent.tg_id}`),
      );
      ctrAgent.tg_id = data.tg_user_id;
    }

    const userFillerIds = data.fillers.map(
      (userFiller) => userFiller.user_filler_id,
    );

    const userFillers = await this.getUserFillersByIds(userFillerIds);
    const requestedUserFillers = this.getUserFillerHashMap(data.fillers);

    // Update necessary user fillers
    userFillers.forEach((userFiller) => {
      const newFillerValue = requestedUserFillers.get(userFiller.id);

      if (newFillerValue !== userFiller.value) {
        this.fillerService.assertNotBlank(userFiller.filler, newFillerValue);
        updatedFields.push(
          new Field(userFiller.filler.field, newFillerValue, userFiller.value),
        );
        userFiller.value = newFillerValue;
      }
    });

    if ((data.fillers_create ?? []).length !== 0) {
      // Create necessary user fillers
      const fillers = await this.fillerService.getFillersHashMap(
        data.fillers_create,
        FillableTablesEnum.USER,
      );
      data.fillers_create.forEach((filler) => {
        const newUserFiller = new UserFiller();
        newUserFiller.filler = fillers.get(filler.filler_id);
        newUserFiller.value = filler.value;
        newUserFiller.user = ctrAgent;
        userFillers.push(newUserFiller);

        updatedFields.push(
          new Field(fillers.get(filler.filler_id).field, filler.value),
        );
      });
    }

    // Was saved only together with new fields: a changed value of an existing
    // field ("Должность") was lost when no field was added at the same time.
    if (userFillers.length) {
      await this.userFillerRepository.save(userFillers);
    }

    const originated_by =
      await this.helperService.extractUserFromRequest(request);

    ctrAgent.updated_by = originated_by;

    await this.userRepository.save(ctrAgent);

    ctrAgent.linked_deals.forEach((deal) => {
      const eventData: FieldValueEventDto = {
        originated_by: originated_by,
        deal: deal,
        fields: updatedFields,
        fields_of: FieldsOf.USER,
      };
      this.eventEmitter.emit(EventTypes.NEW_FIELD_VALUE.toString(), eventData);
    });

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

  private async getUserFillersByIds(ids: number[]): Promise<UserFiller[]> {
    const userFillers = await this.userFillerRepository.find({
      where: { id: In(ids) },
      relations: ['filler'],
    });

    if (userFillers.length !== ids.length) {
      this.fillerService.throwExceptionWithNonExistingFillers(ids, userFillers);
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
