import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class IssueTokenDto {
  @IsInt()
  user_id: number;

  // FTP logins with this token must use FTPS; not given — as the manager's previous token
  @IsOptional()
  @IsBoolean()
  tls_required?: boolean;
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

  // in — incoming calls only, out — outgoing only
  @IsOptional()
  @IsIn(['in', 'out'])
  direction?: 'in' | 'out';

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

/** A page of calls: the company card, a staff member's own list (GET /calls/companies/:id, /calls/staff/:id). */
export class CallFeedQueryDto {
  // in — incoming calls only, out — outgoing only
  @IsOptional()
  @IsIn(['in', 'out'])
  direction?: 'in' | 'out';

  // YYYY-MM-DD, both days included
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

/** «Записи звонков» (GET /calls/list): a page of calls; user_id — whose (admin and manager; an agent sees their own). */
export class CallListQueryDto extends CallFeedQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  user_id?: number;
}

/** Per token: FTP logins with it must use FTPS (PATCH /calls/tokens/:user_id). */
export class TokenSettingsDto {
  @IsBoolean()
  tls_required: boolean;
}

export class QueueQueryDto {
  @IsOptional()
  @IsIn(['pending', 'done', 'failed', 'discarded', 'duplicate', 'all'])
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  user_id?: number;
}
