import { Access } from '../auth/access';
import { AuthUser } from '../auth/auth.guard';

/**
 * Which tasks a user sees (GET /tasks, GET /tasks/:id) and what a task may be linked to.
 *
 * A task carries its deal (label, budget), company (requisites) and contact, so it is visible by the
 * same rules as those records (src/auth/access.ts): admin and manager see every task; anyone else
 * sees the tasks assigned to them or to their group, the tasks they created, and the tasks of a
 * record they may see. A task of a deal goes by the deal, also when it names the company too.
 * A task linked to nothing follows the task level of the user card ("Задачи: правка"): "group" — the
 * tasks of the colleagues of the group too (assigned to them or created by them), "all" — every one;
 * "own" or none — only the user's own (an unlinked task of a colleague was shown to everybody).
 */

let counter = 0;
const param = (name: string) => `tv_${name}_${counter++}`;

export interface ScopedSql {
  sql: string;
  params: Record<string, any>;
}

/** Contacts (alias of "user"): the contact rule of the API (Access.contactSql, also used by RecordAccess('contact')). */
export function contactSql(access: Access, alias: string): ScopedSql {
  return access.contactSql(alias, 'view');
}

/** Condition on the task alias `t` limiting tasks to those the user sees; null: no limit (admin, manager). */
export function taskVisibilitySql(user: AuthUser | undefined, t = 't0'): ScopedSql | null {
  if (!user) return null;
  const access = new Access(user);
  if (access.isManager) return null;
  const me = param('me');
  const group = param('group');
  const deal = access.dealSql('tvd', 'view');
  const company = access.companySql('tvc', 'view');
  const contact = contactSql(access, 'tvu');
  const own = [`${t}.agent_id = :${me}`, `${t}."createdById" = :${me}`];
  if (user.group_id != null) own.push(`${t}.group_id = :${group}`);
  const breadth = access.scope('task', 'update');
  const colleagues =
    breadth === 'all'
      ? 'TRUE'
      : breadth === 'group' && user.group_id != null
        ? `(${t}.agent_id IN (SELECT tvg.id FROM "user" tvg WHERE tvg.group_id = :${group})
            OR ${t}."createdById" IN (SELECT tvg.id FROM "user" tvg WHERE tvg.group_id = :${group}))`
        : 'FALSE';
  return {
    sql: `(${own.join(' OR ')}
      OR (${t}.deal_id IS NOT NULL AND EXISTS (SELECT 1 FROM deal tvd WHERE tvd.id = ${t}.deal_id AND ${deal.sql}))
      OR (${t}.deal_id IS NULL AND ${t}.company_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM company tvc WHERE tvc.id = ${t}.company_id AND ${company.sql}))
      OR (${t}.deal_id IS NULL AND ${t}.company_id IS NULL AND ${t}.ctr_agent_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM "user" tvu WHERE tvu.id = ${t}.ctr_agent_id AND ${contact.sql}))
      OR (${t}.deal_id IS NULL AND ${t}.company_id IS NULL AND ${t}.ctr_agent_id IS NULL AND ${colleagues}))`,
    params: { ...deal.params, ...company.params, ...contact.params, [me]: user.sub, [group]: user.group_id },
  };
}
