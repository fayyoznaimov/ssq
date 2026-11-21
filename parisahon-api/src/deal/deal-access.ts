import { AuthUser } from '../auth/auth.guard';
import { RoleEnum } from '../user/user.entity';

/**
 * Which deals a user may delete (move to the trash), see in the trash and restore from it.
 * One rule for the three, enforced by the API (the client mirrors it in utils/casl.ts):
 * the "Удаление" column of the deal permissions in the user card,
 * user.permissions.deal.delete — 0 nothing, 1 deals where the user is responsible,
 * 2 deals of the user's group, 3 every deal.
 * Admin: every deal. An account without stored permissions (created before they existed):
 * manager every deal, agent their own deals — the defaults of the CRM bot (src/bot/bot-access.ts).
 *
 * Permanent deletion from the trash is for the admin only (@Roles on the trash controller).
 */
export type DealScope = 'none' | 'own' | 'group' | 'all';

const LEVEL_TO_SCOPE: Record<number, DealScope> = { 0: 'none', 1: 'own', 2: 'group', 3: 'all' };

export class DealAccess {
  constructor(private readonly user: AuthUser) {}

  get userId(): number {
    return this.user.sub;
  }

  get isAdmin(): boolean {
    return this.user.role === RoleEnum.ADMIN;
  }

  deleteScope(): DealScope {
    if (this.isAdmin) {
      return 'all';
    }

    const level = (this.user.permissions as any)?.deal?.delete;

    if (typeof level !== 'number') {
      return this.user.role === RoleEnum.MANAGER ? 'all' : 'own';
    }

    return LEVEL_TO_SCOPE[level] ?? 'none';
  }

  /**
   * SQL condition (QueryBuilder parameters) limiting deals of `alias` to the delete scope.
   * "Own" deals: the user is responsible, or the user moved the deal to the trash.
   */
  deleteCondition(alias: string): { sql: string; params: Record<string, any> } {
    const scope = this.deleteScope();

    if (scope === 'all') {
      return { sql: 'TRUE', params: {} };
    }

    if (scope === 'none') {
      return { sql: 'FALSE', params: {} };
    }

    const params: Record<string, any> = { access_user_id: this.userId };
    const own = `${alias}.agent_id = :access_user_id OR ${alias}.deleted_by = :access_user_id`;

    if (scope === 'own' || this.user.group_id === null || this.user.group_id === undefined) {
      return { sql: `(${own})`, params };
    }

    params.access_group_id = this.user.group_id;

    return {
      sql: `(${own} OR ${alias}.agent_id IN (SELECT gu.id FROM "user" gu WHERE gu.group_id = :access_group_id))`,
      params,
    };
  }
}
