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
 * Who may see and change what — enforced by the API, the same rules the client shows
 * (utils/casl.ts) and the bot uses (bot/bot-access.ts).
 *
 * The user card stores a level per entity and action (user.permissions):
 * 0 nothing, 1 records where the user is responsible, 2 records of the user's group, 3 everything.
 * Admin and manager: everything. A level that is not stored: an agent may see and change
 * their own deals and every company and contact (the bot's defaults).
 *
 * "Own" deal: the user is responsible (deal.agent_id). "Group": the responsible user is in the
 * same group. Companies and contacts at "own"/"group": created by the user (or the group), or
 * linked to a deal the user may see at that level.
 */
export type Scope = 'none' | 'own' | 'group' | 'all';
export type Entity = 'deal' | 'company' | 'contact' | 'task';
export type Action = 'view' | 'create' | 'update' | 'delete';

const LEVEL_TO_SCOPE: Record<number, Scope> = { 0: 'none', 1: 'own', 2: 'group', 3: 'all' };

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

  /** E-mail bodies in deal history: the "mail" switch of the user card (admin and manager always). */
  get canReadMail(): boolean {
    return this.isManager || (this.user.permissions as any)?.mail === true;
  }

  /** May the user see / change a deal whose responsible user is `agentId` (in group `agentGroupId`)? */
  allowsDeal(action: Action, agentId: number | null, agentGroupId: number | null): boolean {
    return this.allows(this.scope('deal', action), agentId, agentGroupId);
  }

  /** May the user change a task assigned to `agentId` (group `groupId`) or created by `creatorId`? */
  allowsTask(action: 'update' | 'delete', agentId: number | null, groupId: number | null, creatorId: number | null): boolean {
    const scope = this.scope('task', action);
    if (scope === 'all') return true;
    if (scope === 'none') return false;
    if (agentId === this.id || creatorId === this.id) return true;
    return scope === 'group' && groupId !== null && groupId === this.user.group_id;
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
      case 'staffData':
        // a colleague's deals, history, files and call recordings: the user's own, or admin / manager
        if (id !== access.id) throw new ForbiddenException('Only your own data');
        return true;
      case 'task': {
        const row = (
          await this.dataSource.query(`SELECT agent_id, group_id, "createdById" AS created_by FROM task WHERE id = $1`, [id])
        )[0];
        if (!row) throw new NotFoundException();
        const verb = action === 'delete' ? 'delete' : 'update';
        if (!access.allowsTask(verb, row.agent_id, row.group_id, row.created_by)) {
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
    // "own" contact: created by the user (group) or on a deal of the user (group)
    const deals = access.dealSql('acd', 'view');
    const scope = access.scope('contact', action);
    const creator = scope === 'group' && access.user.group_id != null
      ? `(u.created_by = :acc_c_me OR u.created_by IN (SELECT g.id FROM "user" g WHERE g.group_id = :acc_c_group))`
      : `u.created_by = :acc_c_me`;
    const row = await this.dataSource
      .createQueryBuilder()
      .select('1', 'ok')
      .from('user', 'u')
      .where('u.id = :contact_id', { contact_id: id })
      .andWhere(
        `(${creator} OR EXISTS (SELECT 1 FROM deal_user du JOIN deal acd ON acd.id = du."dealId"
           WHERE du."userId" = u.id AND acd.deleted_at IS NULL AND ${deals.sql}))`,
        { ...deals.params, acc_c_me: access.id, acc_c_group: access.user.group_id },
      )
      .getRawOne();
    return !!row;
  }
}

/** @RecordAccess('company', 'update') etc. on a handler with an `:id` parameter. */
export const RecordAccess = (record: Record_, action: Action) =>
  applyDecorators(SetMetadata(RECORD_ACCESS, { record, action }), UseGuards(RecordAccessGuard));
