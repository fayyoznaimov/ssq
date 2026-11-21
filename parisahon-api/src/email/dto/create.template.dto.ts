import { IsOptional, IsString, Length } from 'class-validator';

export class CreateTemplateDto {
  @IsString()
  template_body: string;

  @IsString()
  @Length(1, 255)
  name: string;

  @IsOptional()
  @IsString()
  subject: string;
}
