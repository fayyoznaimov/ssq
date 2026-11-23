import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RoleEnum } from '../user/user.entity';
import { SearchLinkableDto } from './dto/search.linkable.dto';
import { Access } from '../auth/access';
import { AuthUser } from '../auth/auth.guard';

/** A condition with named parameters (Access) put into raw SQL with $n parameters. */
function bindNamed(sql: string, named: Record<string, any>, params: unknown[]): string {
  return sql.replace(/:(\w+)/g, (match, name: string) => {
    if (!(name in named)) return match;
    params.push(named[name]);
    return `$${params.length}`;
  });
}

@Injectable()
export class LinkableService {
  constructor(private dataSource: DataSource) {}

  /**
   * What a task can be linked to (the task window): contacts, companies and deals whose name has the
   * text — not deleted, within the user's view rights (contact / company / deal), names starting with
   * the text first. It used to list deleted records and the deals of everybody, in no order.
   */
  async fetch(data: SearchLinkableDto, requester?: AuthUser): Promise<Record<string, any>[]> {
    const params: unknown[] = [`%${data.name}%`, `${data.name}%`];
    let contacts = 'TRUE';
    let companies = 'TRUE';
    let deals = 'TRUE';
    if (requester) {
      const access = new Access(requester);
      const c = access.contactSql('t1', 'view');
      const co = access.companySql('t2', 'view');
      const d = access.dealSql('t3', 'view');
      contacts = bindNamed(c.sql, c.params, params);
      companies = bindNamed(co.sql, co.params, params);
      deals = bindNamed(d.sql, d.params, params);
    }
    const query = `
      WITH linkable AS (
        SELECT t1.id, t1.username AS name, 'user' AS type FROM public.user t1
         WHERE t1.role = '${RoleEnum.CTR_AGENT}' AND t1.deleted_at IS NULL AND t1.username ILIKE $1 AND ${contacts}
        UNION
        SELECT t2.id, t2.name, 'company' AS type FROM company t2
         WHERE t2.deleted_at IS NULL AND t2.name ILIKE $1 AND ${companies}
        UNION
        SELECT t3.id, t3.label AS name, 'deal' AS type FROM deal t3
         WHERE t3.deleted_at IS NULL AND t3.label ILIKE $1 AND ${deals}
      )
      SELECT * FROM linkable
      ORDER BY (name ILIKE $2) DESC, length(name), name, id
      LIMIT 25
    `;

    return this.dataSource.query(query, params);
  }
}
