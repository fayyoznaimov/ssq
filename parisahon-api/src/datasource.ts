import 'dotenv/config';
import { DataSource, DataSourceOptions } from 'typeorm';
import * as process from 'process';
import { APP_TIME_ZONE } from './helper/time-zone';

export const options: DataSourceOptions = {
  type: 'postgres',
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  username: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DATABASE,
  entities: [process.env.TYPEORM_ENTITIES],
  synchronize: process.env.TYPEORM_SYNCHRONIZE === 'true',
  migrations: [process.env.TYPEORM_MIGRATIONS],
  migrationsTableName: 'migrations',
  // The session works in the CRM's zone (helper/time-zone.ts: TZ, Asia/Tashkent by default): values the
  // database fills itself (created_at, updated_at, soft deletes, now()) are then in the same zone as the
  // ones the API writes (deadlines, stage changes, closing). The database itself has the same default
  // (migration 1795720000000-database-time-zone), for psql, backups and scripts.
  // A bounded pool and a ceiling per statement: one heavy report cannot take the database from everybody.
  extra: {
    options: `-c timezone=${APP_TIME_ZONE}`,
    max: Number(process.env.POSTGRES_POOL || 15),
    statement_timeout: Number(process.env.POSTGRES_STATEMENT_TIMEOUT_MS || 60000),
    idleTimeoutMillis: 30000,
  },
};

const dataSource = new DataSource(options);
export default dataSource;
