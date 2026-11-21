import { EventTypes } from '../event.entity';
import { IsEnum, IsNumber, IsOptional } from 'class-validator';
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
}
