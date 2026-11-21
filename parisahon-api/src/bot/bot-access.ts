import { DataSource } from 'typeorm';
import { AuthUser, AuthGuard } from '../auth/auth.guard';
import { RoleEnum, UserPermissions } from '../user/user.entity';

/**
 * What a CRM user may see and do through the bot. The web CRM stores these
 * rights in the user card (user.permissions: 0 banned, 1 if responsible,
 * 2 for the group, 3 everything); the bot enforces them on the server.
 *
 * Without stored permissions: admin and manager see everything, an agent sees
 * all companies and contacts, but only the deals where they are responsible.
 */
export type Scope = 'none' | 'own' | 'group' | 'all';

const LEVEL_TO_SCOPE: Record<number, Scope> = { 0: 'none', 1: 'own', 2: 'group', 3: 'all' };

export class BotAccess {
  constructor(readonly user: AuthUser) {}

  get id() {
    return this.user.sub;
  }

  get isAdmin() {
    return this.user.role === RoleEnum.ADMIN;
  }

  private level(entity: keyof UserPermissions, action: string): number | undefined {
    const value = (this.user.permissions as any)?.[entity]?.[action];
    return typeof value === 'number' ? value : undefined;
  }

  viewScope(entity: 'deal' | 'company' | 'contact'): Scope {
    if (this.isAdmin) return 'all';
    const level = this.level(entity, 'view');
    if (level === undefined) {
      if (this.user.role === RoleEnum.MANAGER) return 'all';
      return entity === 'deal' ? 'own' : 'all';
    }
    return LEVEL_TO_SCOPE[level] ?? 'none';
  }

  canCreateCompany(): boolean {
    if (this.isAdmin) return true;
    const level = this.level('company', 'create');
    return level === undefined || level > 0;
  }

  /** May this user close a task assigned to `agentId` / group `groupId`? */
  canUpdateTask(agentId: number | null, groupId: number | null): boolean {
    if (this.isAdmin) return true;
    const level = this.level('task', 'update') ?? 3;
    const mine = agentId === this.id;
    const ourGroup = groupId !== null && groupId === this.user.group_id;
    if (level >= 3) return true;
    if (level >= 2) return mine || ourGroup;
    if (level >= 1) return mine;
    return false;
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
