import { AuthUser } from '../auth/auth.guard';
import { Access } from '../auth/access';
import { RoleEnum } from '../user/user.entity';

/**
 * Which deals a user may delete (move to the trash), see in the trash and restore from it.
 * One rule for the three: the "delete" scope of deals in the API's Access (src/auth/access.ts),
 * which the client gets from GET /auth/access — the "Удаление" column of the deal permissions in
 * the user card, user.permissions.deal.delete: 0 nothing, 1 deals where the user is responsible,
 * 2 deals of the user's group, 3 every deal. Admin and manager: every deal. An account without
 * stored permissions (created before they existed): the agent's own deals.
 *
 * Permanent deletion from the trash is for the admin only (@Roles on the trash controller).
 */
export type DealScope = 'none' | 'own' | 'group' | 'all';

export class DealAccess {
  constructor(private readonly user: AuthUser) {}

  get userId(): number {
    return this.user.sub;
  }

  get isAdmin(): boolean {
    return this.user.role === RoleEnum.ADMIN;
  }

  deleteScope(): DealScope {
    return new Access(this.user).scope('deal', 'delete');
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
