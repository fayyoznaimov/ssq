import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class IssueTokenDto {
  @IsInt()
  user_id: number;
}

/** Fields of the multipart POST /calls/upload (every value arrives as a string). */
export class UploadCallDto {
  // milliseconds, as the recorder writes them
  @IsOptional()
  @IsString()
  duration?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  number?: string;

  @IsOptional()
  @IsIn(['Incoming', 'Outgoing', 'incoming', 'outgoing'])
  direction?: string;

  // the folder scanner of the Telegram service and the FTP receiver: whose folder the file came from
  @IsOptional()
  @IsString()
  user_id?: string;

  // the time of the file on the phone, epoch milliseconds (used when its name has no date)
  @IsOptional()
  @IsString()
  @Length(1, 32)
  recorded_at?: string;
}

export class RecordingsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  user_id?: number;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  till?: string;

  @IsOptional()
  @IsString()
  @Length(1, 64)
  number?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

export class QueueQueryDto {
  @IsOptional()
  @IsIn(['pending', 'done', 'failed', 'discarded', 'all'])
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  user_id?: number;
}
