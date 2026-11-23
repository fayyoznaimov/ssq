import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, Min } from 'class-validator';

/** POST /emails/deals: «доб.сделку» in Mail — deals with the clients of these letters. */
export class CreateDealsFromLettersDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Отметьте письма, из которых нужно создать сделку' })
  @ArrayMaxSize(200)
  @Type(() => Number)
  @IsInt({ each: true })
  email_ids: number[];

  /** the responsible manager */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  agent_id: number;

  /** the stage; the default stage when not given */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  stage_id?: number;
}

/** POST /emails/contacts: contacts just made from letters («доб.контакты»); their stored letters point to them. */
export class LinkLetterContactsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @Type(() => Number)
  @IsInt({ each: true })
  user_ids: number[];
}
