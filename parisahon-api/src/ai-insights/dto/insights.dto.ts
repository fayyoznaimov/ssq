import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { INBOUND_CATEGORIES } from '../insights-prompts';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MESSAGE = 'Дата: ГГГГ-ММ-ДД';

/** A period of the reports: plain dates, both days included. */
export class InsightsPeriodDto {
  @IsOptional()
  @Matches(DAY, { message: DAY_MESSAGE })
  from_date?: string;

  @IsOptional()
  @Matches(DAY, { message: DAY_MESSAGE })
  till_date?: string;
}

/** GET /ai/market, POST /ai/market/summary */
export class MarketQueryDto extends InsightsPeriodDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  product?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  product_id?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  country?: string;
}

/** GET /ai/inbound */
export class InboundListDto extends InsightsPeriodDto {
  @IsOptional()
  @IsIn(['all', 'lead', 'not_lead', ...Object.keys(INBOUND_CATEGORIES)], { message: 'Неизвестная категория' })
  category?: string;

  @IsOptional()
  @IsIn(['all', 'new', 'reviewed'], { message: 'Неизвестное состояние' })
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  page?: number;
}

/** PATCH /deals/:id/ai/inbound: the category corrected, «просмотрено» */
export class InboundCorrectDto {
  @IsOptional()
  @IsIn(Object.keys(INBOUND_CATEGORIES), { message: 'Неизвестная категория' })
  category?: string;

  @IsOptional()
  @IsBoolean()
  reviewed?: boolean;
}

/** POST /ai/insights/run: a job of the AI features now (admin) */
export class InsightsRunDto {
  @IsIn(['morning', 'evening', 'supervisor', 'tips'], { message: 'Неизвестная задача' })
  job: 'morning' | 'evening' | 'supervisor' | 'tips';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsInt({ each: true })
  user_ids?: number[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsInt({ each: true })
  deal_ids?: number[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(14)
  @Matches(DAY, { each: true, message: DAY_MESSAGE })
  days?: string[];

  /** the evening digest: how long to wait for the AI's lines (seconds) */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(120)
  wait_sec?: number;
}
