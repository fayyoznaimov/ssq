import { DataSource } from 'typeorm';
import { AuthUser, AuthGuard } from '../auth/auth.guard';
import { Access, Scope } from '../auth/access';
import { RoleEnum } from '../user/user.entity';

/**
 * What a CRM user may see and do through the bot: the API's own rules (src/auth/access.ts), so the
 * bot, the web CRM and the API never disagree. The user card stores the levels (user.permissions:
 * 0 banned, 1 if responsible, 2 for the group, 3 everything). Admin and manager: everything.
 * Without stored permissions: an agent sees all companies and contacts, but only the deals where
 * they are responsible. This class only turns the scopes into SQL for the bot's raw queries.
 */
export type { Scope } from '../auth/access';

export class BotAccess {
  private readonly access: Access;

  constructor(readonly user: AuthUser) {
    this.access = new Access(user);
  }

  get id() {
    return this.user.sub;
  }

  get isAdmin() {
    return this.user.role === RoleEnum.ADMIN;
  }

  viewScope(entity: 'deal' | 'company' | 'contact'): Scope {
    return this.access.scope(entity, 'view');
  }

  /** E-mail texts in a client's history: the "mail" switch of the user card, as on the web (Access.canReadMail). */
  get canReadMail(): boolean {
    return this.access.canReadMail;
  }

  canCreateCompany(): boolean {
    return this.access.can('company', 'create');
  }

  /** May this user close a task assigned to `agentId` / group `groupId` (created by `creatorId`)? */
  canUpdateTask(agentId: number | null, groupId: number | null, creatorId: number | null = null): boolean {
    return this.access.allowsTask('update', agentId, groupId, creatorId);
  }

  /**
   * SQL condition limiting deals (alias `d`) to what the user may see.
   * Pushes its parameters to `params` and refers to them as $n.
   */
  dealCondition(params: unknown[], alias = 'd'): string {
    return this.scopedCondition(this.viewScope('deal'), params, `${alias}.agent_id`);
  }

  /** Companies (alias `c`): visible to everyone with "all", otherwise own/group deals or created by. */
  companyCondition(params: unknown[], alias = 'c'): string {
    const scope = this.viewScope('company');
    if (scope === 'all') return 'TRUE';
    if (scope === 'none') return 'FALSE';
    const who = this.scopedCondition(scope, params, 'x.agent_id');
    const creator = this.scopedCondition(scope, params, `${alias}.created_by`);
    return `(${creator} OR EXISTS (SELECT 1 FROM deal x WHERE x.company_id = ${alias}.id AND x.deleted_at IS NULL AND ${who}))`;
  }

  private scopedCondition(scope: Scope, params: unknown[], column: string): string {
    if (scope === 'all') return 'TRUE';
    if (scope === 'none') return 'FALSE';
    params.push(this.id);
    const me = `$${params.length}`;
    if (scope === 'own' || this.user.group_id === null) return `${column} = ${me}`;
    params.push(this.user.group_id);
    return `(${column} = ${me} OR ${column} IN (SELECT gu.id FROM "user" gu WHERE gu.group_id = $${params.length}))`;
  }
}

/** The current state of a staff user, like AuthGuard does for a JWT. Null if deleted or not staff. */
export async function loadStaffUser(dataSource: DataSource, userId: number): Promise<AuthUser | null> {
  const rows = await dataSource.query(
    `SELECT id, username, role, permissions, group_id FROM "user" WHERE id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  const row = rows[0];
  if (!row || !AuthGuard.AGENT_LEVEL.includes(row.role)) return null;
  return {
    sub: row.id,
    username: row.username,
    role: row.role,
    permissions: row.permissions ?? null,
    group_id: row.group_id ?? null,
  };
}
