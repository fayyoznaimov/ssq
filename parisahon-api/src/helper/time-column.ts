import { ColumnType } from 'typeorm';

/**
 * The column type of every time of the CRM's entities (DB-1 / HACK-3): a moment with its zone, so it means
 * the same whatever zone a connection, psql, a backup or a script works in. The columns were converted by
 * migration 1795729000000-timestamptz. Should that migration be left out, this one line goes back to
 * 'timestamp' for all the entities. New time columns use it too: `@Column({ type: TIME, ... })`,
 * `@CreateDateColumn({ type: TIME })`.
 */
export const TIME: ColumnType = 'timestamp with time zone';
