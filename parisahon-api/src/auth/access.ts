import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
  SetMetadata,
  applyDecorators,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AuthUser } from './auth.guard';
import { RoleEnum } from '../user/user.entity';

/**
 * Who may see and change what. The one rule of the CRM: the API enforces it here, the bot
 * (bot/bot-access.ts) and the deal trash (deal/deal-access.ts) are built on this class, and the
 * web client gets it from GET /auth/access (describe()) to build its menu and buttons (utils/casl.ts).
 *
 * The user card stores a level per entity and action (user.permissions):
 * 0 nothing, 1 records where the user is responsible, 2 records of the user's group, 3 everything.
 * Admin and manager: everything (the matrix of the card does not apply to them; settings stay
 * admin-only through @Roles). A level that is not stored: an agent may see and change their own
 * deals and every company and contact (the bot's defaults).
 *
 * "Own" deal: the user is responsible (deal.agent_id). "Group": the responsible user is in the
 * same group. Companies and contacts at "own"/"group": created by the user (or the group), or
 * linked to a deal the user may see at that level; a contact also when its company is in reach by
 * that rule (contactSql).
 *
 * The switches "Доступ к почте" / "Доступ к файлам" (permissions.mail / .file): admin and manager
 * always; an agent unless the switch is off. A missing key counts as on, as the mail and file
 * guards have always read it (the user card always stores both).
 */
export type Scope = 'none' | 'own' | 'group' | 'all';
export type Entity = 'deal' | 'company' | 'contact' | 'task';
export type Action = 'view' | 'create' | 'update' | 'delete';

/** GET /auth/access: the rules of the signed-in user as the client needs them. */
export interface AccessSummary {
  user_id: number;
  role: RoleEnum;
  group_id: number | null;
  /** admin: settings, users, groups and the rest of the admin pages */
  admin: boolean;
  /** admin or manager: every record, analytics, the action log */
  manager: boolean;
  scopes: Record<'deal' | 'company' | 'contact', Record<Action, Scope>> & {
    task: Record<'view' | 'create' | 'update' | 'delete', Scope>;
  };
  mail: boolean;
  file: boolean;
}

const LEVEL_TO_SCOPE: Record<number, Scope> = { 0: 'none', 1: 'own', 2: 'group', 3: 'all' };

/**
 * «Стандартные права» of an employee with the role «Агент» (levels as user.permissions stores them): their own
 * deals, companies and contacts — see, create and change; their own tasks — change; nothing to delete.
 * A new employee gets them in the user card; an existing one by POST /auth/standard-rights/:id (the list
 * «Пользователи» offers it to an agent whose card forbids everything). The web client keeps the same
 * template (STANDARD_PERMISSIONS in utils/casl.ts).
 */
export const STANDARD_LEVELS = {
  deal: { view: 1, create: 3, update: 1, delete: 0, export: 0 },
  company: { view: 1, create: 3, update: 1, delete: 0, export: 0 },
  contact: { view: 1, create: 3, update: 1, delete: 0, export: 0 },
  task: { update: 1, delete: 0 },
};

let paramCounter = 0;

export class Access {
  constructor(readonly user: AuthUser) {}

  get id(): number {
    return this.user.sub;
  }

  /** Admin and manager see and change everything. */
  get isManager(): boolean {
    return this.user.role === RoleEnum.ADMIN || this.user.role === RoleEnum.MANAGER;
  }

  private level(entity: Entity, action: Action): number | undefined {
    const value = (this.user.permissions as any)?.[entity]?.[action];
    return typeof value === 'number' ? value : undefined;
  }

  scope(entity: Entity, action: Action): Scope {
    if (this.isManager) return 'all';
    const level = this.level(entity, action);
    if (level === undefined) {
      if (entity === 'deal' && action !== 'create') return 'own';
      return 'all';
    }
    if (action === 'create') return level > 0 ? 'all' : 'none';
    return LEVEL_TO_SCOPE[level] ?? 'none';
  }

  can(entity: Entity, action: Action): boolean {
    return this.scope(entity, action) !== 'none';
  }

  /** A switch of the user card: admin and manager always, an agent unless it is off (see the top). */
  private switchedOn(name: 'mail' | 'file'): boolean {
    return this.isManager || (this.user.permissions as any)?.[name] !== false;
  }

  /** Mail: the mailbox pages (MailAccessGuard) and e-mail bodies in the deal history. */
  get canReadMail(): boolean {
    return this.switchedOn('mail');
  }

  /** The list of files (Списки → Файлы, FileAccessGuard). */
  get canUseFiles(): boolean {
    return this.switchedOn('file');
  }

  /** Everything the client mirrors (GET /auth/access): the scope of every action and the switches. */
  describe(): AccessSummary {
    const actions = (entity: Entity): Record<Action, Scope> => ({
      view: this.scope(entity, 'view'),
      create: this.scope(entity, 'create'),
      update: this.scope(entity, 'update'),
      delete: this.scope(entity, 'delete'),
    });
    return {
      user_id: this.id,
      role: this.user.role,
      group_id: this.user.group_id ?? null,
      admin: this.user.role === RoleEnum.ADMIN,
      manager: this.isManager,
      scopes: {
        deal: actions('deal'),
        company: actions('company'),
        contact: actions('contact'),
        // tasks: every staff user has the section and sets tasks; which tasks the list holds the API
        // decides per task (task/task-access.ts); changing and deleting follow allowsTask()
        task: { view: 'all', create: 'all', update: this.scope('task', 'update'), delete: this.scope('task', 'delete') },
      },
      mail: this.canReadMail,
      file: this.canUseFiles,
    };
  }

  /** May the user see / change a deal whose responsible user is `agentId` (in group `agentGroupId`)? */
  allowsDeal(action: Action, agentId: number | null, agentGroupId: number | null): boolean {
    return this.allows(this.scope('deal', action), agentId, agentGroupId);
  }

  /**
   * May the user change a task assigned to `agentId` (group `groupId`) or created by `creatorId`?
   * "group": a task of the user's group, or one assigned to / created by a colleague of the group —
   * `peopleGroups` are the groups of the assignee and of the author (as a deal goes by its responsible).
   */
  allowsTask(
    action: 'update' | 'delete',
    agentId: number | null,
    groupId: number | null,
    creatorId: number | null,
    peopleGroups: (number | null | undefined)[] = [],
  ): boolean {
    const scope = this.scope('task', action);
    if (scope === 'all') return true;
    if (scope === 'none') return false;
    if (agentId === this.id || creatorId === this.id) return true;
    const mine = this.user.group_id;
    if (scope !== 'group' || mine === null || mine === undefined) return false;
    return groupId === mine || peopleGroups.some((g) => g !== null && g !== undefined && Number(g) === mine);
  }

  private allows(scope: Scope, agentId: number | null, agentGroupId: number | null): boolean {
    if (scope === 'all') return true;
    if (scope === 'none') return false;
    if (agentId !== null && agentId === this.id) return true;
    return (
      scope === 'group' &&
      this.user.group_id !== null &&
      this.user.group_id !== undefined &&
      agentGroupId !== null &&
      agentGroupId === this.user.group_id
    );
  }

  /** QueryBuilder condition (named parameters) limiting deals of `alias` to the scope. */
  dealSql(alias: string, action: Action = 'view'): { sql: string; params: Record<string, any> } {
    return this.scopedSql(this.scope('deal', action), `${alias}.agent_id`);
  }

  /** Companies of `alias`: created by the user (group) or with a deal the user may see. */
  companySql(alias: string, action: Action = 'view'): { sql: string; params: Record<string, any> } {
    const scope = this.scope('company', action);
    if (scope === 'all' || scope === 'none') return this.scopedSql(scope, '');
    const creator = this.scopedSql(scope, `${alias}.created_by`);
    const deals = this.scopedSql(scope, 'acx.agent_id');
    return {
      sql: `(${creator.sql} OR EXISTS (SELECT 1 FROM deal acx WHERE acx.company_id = ${alias}.id AND acx.deleted_at IS NULL AND ${deals.sql}))`,
      params: { ...creator.params, ...deals.params },
    };
  }

  /**
   * Contacts (ctr_agent rows of `alias`) at the contact scope: created by the user (group), linked to a
   * deal of the user (group), or of a company that is the user's (group's) by companySql()'s rule — the
   * company card shows its contacts. The lists (GET /contacts, /users) and RecordAccess('contact') use it.
   */
  contactSql(alias: string, action: Action = 'view'): { sql: string; params: Record<string, any> } {
    const scope = this.scope('contact', action);
    if (scope === 'all' || scope === 'none') return this.scopedSql(scope, '');
    const creator = this.scopedSql(scope, `${alias}.created_by`);
    const deals = this.scopedSql(scope, 'acu.agent_id');
    const companyCreator = this.scopedSql(scope, 'acco.created_by');
    const companyDeals = this.scopedSql(scope, 'acud.agent_id');
    return {
      sql: `(${creator.sql}
        OR EXISTS (SELECT 1 FROM deal_user acdu JOIN deal acu ON acu.id = acdu."dealId"
                    WHERE acdu."userId" = ${alias}.id AND acu.deleted_at IS NULL AND ${deals.sql})
        OR EXISTS (SELECT 1 FROM company acco WHERE acco.id = ${alias}.company_id AND acco.deleted_at IS NULL
                    AND (${companyCreator.sql} OR EXISTS (SELECT 1 FROM deal acud WHERE acud.company_id = acco.id
                         AND acud.deleted_at IS NULL AND ${companyDeals.sql}))))`,
      params: { ...creator.params, ...deals.params, ...companyCreator.params, ...companyDeals.params },
    };
  }

  private scopedSql(scope: Scope, column: string): { sql: string; params: Record<string, any> } {
    if (scope === 'all') return { sql: 'TRUE', params: {} };
    if (scope === 'none') return { sql: 'FALSE', params: {} };
    const me = `acc_me_${paramCounter++}`;
    if (scope === 'own' || this.user.group_id === null || this.user.group_id === undefined) {
      return { sql: `${column} = :${me}`, params: { [me]: this.id } };
    }
    const group = `acc_group_${paramCounter++}`;
    return {
      sql: `(${column} = :${me} OR ${column} IN (SELECT acg.id FROM "user" acg WHERE acg.group_id = :${group}))`,
      params: { [me]: this.id, [group]: this.user.group_id },
    };
  }
}

const DEAL_ACCESS = 'deal_access_action';

/**
 * Route guard for /deals/:id/... : the deal must exist (and not be in the trash) and be within
 * the user's scope for the action. Not visible -> 404 (do not reveal that it exists);
 * visible but not changeable -> 403. Runs before the upload interceptors, so nothing is written
 * to disk for a refused request.
 */
@Injectable()
export class DealAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.get<Action>(DEAL_ACCESS, context.getHandler());
    if (!action) return true;
    const request = context.switchToHttp().getRequest();
    const user: AuthUser | undefined = request.user;
    if (!user) return false;
    const access = new Access(user);
    if (access.isManager) return true;

    const id = Number(request.params?.id);
    if (!Number.isInteger(id)) return true; // ParseIntPipe answers 400
    const rows = await this.dataSource.query(
      `SELECT d.agent_id, a.group_id FROM deal d LEFT JOIN "user" a ON a.id = d.agent_id WHERE d.id = $1 AND d.deleted_at IS NULL`,
      [id],
    );
    const row = rows[0];
    if (!row || !access.allowsDeal('view', row.agent_id, row.group_id)) {
      throw new NotFoundException(`Deal ${id} not found`);
    }
    if (action !== 'view' && !access.allowsDeal(action, row.agent_id, row.group_id)) {
      throw new ForbiddenException('No right to change this deal');
    }
    return true;
  }
}

/** @DealAccess('view' | 'update') on a /deals/:id/... handler. */
export const DealAccess = (action: Action) =>
  applyDecorators(SetMetadata(DEAL_ACCESS, action), UseGuards(DealAccessGuard));

export type Record_ =
  | 'company'
  | 'companyFiller'
  | 'dealFiller'
  | 'contact'
  | 'staffData'
  | 'task';

const RECORD_ACCESS = 'record_access';

/**
 * Route guard for /companies/:id, /users/:id (contacts), /tasks/:id and the custom-field
 * deletions: the record must be within the user's scope for the action.
 * Not visible -> 404, visible but not changeable -> 403.
 */
@Injectable()
export class RecordAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rule = this.reflector.get<{ record: Record_; action: Action }>(RECORD_ACCESS, context.getHandler());
    if (!rule) return true;
    const request = context.switchToHttp().getRequest();
    const user: AuthUser | undefined = request.user;
    if (!user) return false;
    const access = new Access(user);
    if (access.isManager) return true;
    const id = Number(request.params?.id);
    if (!Number.isInteger(id)) return true; // ParseIntPipe answers 400
    const { record, action } = rule;

    switch (record) {
      case 'company':
        return this.company(access, id, action);
      case 'companyFiller': {
        const row = (await this.dataSource.query(`SELECT company_id FROM company_filler WHERE id = $1`, [id]))[0];
        if (!row) throw new NotFoundException();
        return this.company(access, row.company_id, 'update');
      }
      case 'dealFiller': {
        const row = (
          await this.dataSource.query(
            `SELECT d.agent_id, a.group_id FROM deal_filler f JOIN deal d ON d.id = f.deal_id
             LEFT JOIN "user" a ON a.id = d.agent_id WHERE f.id = $1 AND d.deleted_at IS NULL`,
            [id],
          )
        )[0];
        if (!row || !access.allowsDeal('view', row.agent_id, row.group_id)) throw new NotFoundException();
        if (!access.allowsDeal('update', row.agent_id, row.group_id)) throw new ForbiddenException();
        return true;
      }
      case 'contact':
        return this.contact(access, id, action);
      case 'staffData': {
        // the same routes serve the contact card (GET /users/:id/deals, /events): a contact needs the
        // right to view it, not "only your own data" (agents got 403 and an empty card)
        const target = (await this.dataSource.query(`SELECT role FROM "user" WHERE id = $1 AND deleted_at IS NULL`, [id]))[0];
        if (target?.role === RoleEnum.CTR_AGENT) return this.contact(access, id, 'view');
        // a colleague's deals, history, files and call recordings: the user's own, or admin / manager
        if (id !== access.id) throw new ForbiddenException('Only your own data');
        return true;
      }
      case 'task': {
        const row = (
          await this.dataSource.query(
            `SELECT t.agent_id, t.group_id, t."createdById" AS created_by, a.group_id AS agent_group, c.group_id AS creator_group
             FROM task t LEFT JOIN "user" a ON a.id = t.agent_id LEFT JOIN "user" c ON c.id = t."createdById"
             WHERE t.id = $1`,
            [id],
          )
        )[0];
        if (!row) throw new NotFoundException();
        const verb = action === 'delete' ? 'delete' : 'update';
        if (!access.allowsTask(verb, row.agent_id, row.group_id, row.created_by, [row.agent_group, row.creator_group])) {
          throw new ForbiddenException('No right to change this task');
        }
        return true;
      }
    }
    return true;
  }

  private async company(access: Access, id: number, action: Action): Promise<boolean> {
    const exists = (await this.dataSource.query(`SELECT 1 FROM company WHERE id = $1 AND deleted_at IS NULL`, [id]))[0];
    if (!exists) throw new NotFoundException(`Company ${id} not found`);
    if (!(await this.companyMatches(access, id, 'view'))) throw new NotFoundException(`Company ${id} not found`);
    if (action !== 'view' && !(await this.companyMatches(access, id, action))) {
      throw new ForbiddenException('No right to change this company');
    }
    return true;
  }

  private async companyMatches(access: Access, id: number, action: Action): Promise<boolean> {
    const cond = access.companySql('c', action);
    const row = await this.dataSource
      .createQueryBuilder()
      .select('1', 'ok')
      .from('company', 'c')
      .where('c.id = :company_id', { company_id: id })
      .andWhere(cond.sql, cond.params)
      .getRawOne();
    return !!row;
  }

  private async contact(access: Access, id: number, action: Action): Promise<boolean> {
    const target = (await this.dataSource.query(`SELECT role FROM "user" WHERE id = $1 AND deleted_at IS NULL`, [id]))[0];
    if (!target) throw new NotFoundException();
    if (target.role !== RoleEnum.CTR_AGENT) return true; // staff accounts: the user service's own rules
    for (const verb of action === 'view' ? (['view'] as Action[]) : (['view', action] as Action[])) {
      const scope = access.scope('contact', verb);
      if (scope === 'all') continue;
      const ok = scope !== 'none' && (await this.contactMatches(access, id, verb));
      if (!ok) {
        if (verb === 'view') throw new NotFoundException();
        throw new ForbiddenException('No right to change this contact');
      }
    }
    return true;
  }

  private async contactMatches(access: Access, id: number, action: Action): Promise<boolean> {
    // "own" contact at the level of this action (Access.contactSql). The deal part used the deal VIEW
    // scope before, so "see all deals" made every contact of a live deal "own" for update and delete.
    const cond = access.contactSql('u', action);
    const row = await this.dataSource
      .createQueryBuilder()
      .select('1', 'ok')
      .from('user', 'u')
      .where('u.id = :contact_id', { contact_id: id })
      .andWhere(cond.sql, cond.params)
      .getRawOne();
    return !!row;
  }
}

/** @RecordAccess('company', 'update') etc. on a handler with an `:id` parameter. */
export const RecordAccess = (record: Record_, action: Action) =>
  applyDecorators(SetMetadata(RECORD_ACCESS, { record, action }), UseGuards(RecordAccessGuard));
