import { Transform } from 'class-transformer';
import { IsDateString, IsIn, IsNumberString, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationRequestDto } from '../../helper/dto/pagination.dto';
import { AUDIT_SOURCES } from '../audit-context';
import { AUDIT_ACTIONS } from '../audit-journal';

/** `a=1` and `a[]=1&a[]=2` alike: a list. */
const list = ({ value }: { value: unknown }) =>
  value === undefined || value === null || value === '' ? undefined : Array.isArray(value) ? value : String(value).split(',');

/**
 * GET /audit (the journal page) and the histories of the cards (/audit/deal/:id, /company/:id,
 * /user/:id): the same filters. A period is inclusive: `from` its first day (or moment), `till` its last
 * day when it is a date (up to 23:59:59).
 */
export class SearchAuditDto extends PaginationRequestDto {
  /** all: business events and changes of data together; changes; events */
  @IsOptional()
  @IsIn(['all', 'changes', 'events'])
  kind?: 'all' | 'changes' | 'events';

  /** the kinds of objects: deal, company, contact, task, … (audit-registry.ts) */
  @IsOptional()
  @Transform(list)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  entity?: string[];

  @IsOptional()
  @Transform(list)
  @IsIn(AUDIT_ACTIONS, { each: true })
  action?: string[];

  @IsOptional()
  @Transform(list)
  @IsIn(AUDIT_SOURCES as unknown as string[], { each: true })
  source?: string[];

  /** types of the history entries (src/events/event.entity.ts EventTypes) */
  @IsOptional()
  @Transform(list)
  @IsNumberString(undefined, { each: true })
  event_types?: string[];

  /** who did it */
  @IsOptional()
  @IsNumberString()
  actor_id?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  till?: string;

  /** the journal page: one deal, company or contact */
  @IsOptional()
  @IsNumberString()
  deal_id?: string;

  @IsOptional()
  @IsNumberString()
  company_id?: string;

  @IsOptional()
  @IsNumberString()
  contact_id?: string;

  /** words of the line of a change or of the text of an event */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  /** 1: also the state of the objects at the moment the journal was switched on */
  @IsOptional()
  @IsIn(['0', '1', 'true', 'false'])
  with_baseline?: string;

  /** the card of an employee: the changes of the account (default) or what the employee did */
  @IsOptional()
  @IsIn(['account', 'actor'])
  as?: 'account' | 'actor';
}
