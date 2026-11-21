import {
  IsEnum,
  IsNotEmpty,
  IsNumberString,
  IsString,
  ValidateIf,
} from 'class-validator';

export enum MessageTargetTypesEnum {
  GROUP = 'group',
  USER = 'user',
  ALL = 'all',
}
export class CreateChatMessageDto {
  @IsString()
  @IsNotEmpty()
  message: string;

  @IsEnum(MessageTargetTypesEnum)
  target: MessageTargetTypesEnum;

  @ValidateIf((o) => o.target !== MessageTargetTypesEnum.ALL)
  @IsNumberString()
  target_id?: number;
}
