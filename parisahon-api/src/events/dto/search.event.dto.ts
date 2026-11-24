import { EventTypes } from '../event.entity';
import { IsEnum, IsIn, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';
import { HISTORY_KINDS, HistoryKind } from '../../history/history-filters';
import { PaginationRequestDto } from '../../helper/dto/pagination.dto';
import { Type } from 'class-transformer';

export enum ChatTypes {
  WITH_CLIENTS = 'with_clients',
  INNER = 'inner',
}

export enum LinkedEntities {
  CONTACTS = 'contacts',
  COMPANY = 'company',
}

export class SearchEventDto extends PaginationRequestDto {
  @IsOptional()
  @IsEnum(ChatTypes, { each: true })
  exclude_chats: ChatTypes[];

  @IsOptional()
  @IsEnum(LinkedEntities, { each: true })
  exclude_linked_entities: LinkedEntities[];

  @IsOptional()
  @IsNumber({}, { each: true })
  @Type(() => Number)
  @IsEnum(EventTypes, { each: true })
  exclude_event_types: EventTypes[];

  /** «Всё / Переписка / Звонки / Задачи / Изменения» of the history (src/history/history-filters.ts) */
  @IsOptional()
  @IsIn(HISTORY_KINDS as unknown as string[])
  kind?: HistoryKind;

  /** Search in the history: the text of messages, notes, tasks, changes, the names of people */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}
