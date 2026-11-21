import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RoleEnum } from '../user/user.entity';
import { SearchLinkableDto } from './dto/search.linkable.dto';

@Injectable()
export class LinkableService {
  constructor(private dataSource: DataSource) {}

  async fetch(data: SearchLinkableDto): Promise<Record<string, any>[]> {
    const query = `
      WITH linkable AS (
        SELECT t1.id, t1.username AS name, 'user' AS type FROM public.user t1 WHERE t1.role = '${RoleEnum.CTR_AGENT}' AND t1.username ILIKE $1
        UNION
        SELECT t2.id, t2.name, 'company' AS type FROM company t2 WHERE t2.name ILIKE $1
        UNION
        SELECT t3.id, t3.label AS name, 'deal' AS type FROM deal t3 WHERE t3.label ILIKE $1
      )
      SELECT * FROM linkable
      LIMIT 25
    `;

    return this.dataSource.query(query, [`%${data.name}%`]);
  }
}
