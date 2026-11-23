import { PaginationRequestDto } from '../../helper/dto/pagination.dto';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export enum TaskTypes {
  TODAY = 'today',
  TOMORROW = 'tomorrow',
  THIS_WEEK = 'this_week',
  THIS_MONTH = 'this_month',
  THIS_QUARTER = 'this_quarter',
  NO_TASK = 'no_task',
  OVERDUE = 'overdue',
}

export const TaskTypesToWeights = new Map<TaskTypes, number>();
TaskTypesToWeights.set(TaskTypes.TODAY, 1);
TaskTypesToWeights.set(TaskTypes.TOMORROW, 2);
TaskTypesToWeights.set(TaskTypes.THIS_WEEK, 3);
TaskTypesToWeights.set(TaskTypes.THIS_MONTH, 4);
TaskTypesToWeights.set(TaskTypes.THIS_QUARTER, 5);

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date: Date): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999,
  );
}

/**
 * 'YYYY-MM-DD HH:mm:ss.SSS' in the server time zone, the way task times are
 * stored in "timestamp without time zone" columns.
 */
export function formatLocalTimestamp(date: Date): string {
  const pad = (value: number, length: number = 2): string =>
    String(value).padStart(length, '0');

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    `${pad(date.getMilliseconds(), 3)}`
  );
}

type RangedTaskTypes =
  | TaskTypes.TODAY
  | TaskTypes.TOMORROW
  | TaskTypes.THIS_WEEK
  | TaskTypes.THIS_MONTH
  | TaskTypes.THIS_QUARTER;

/**
 * Date range of a task filter.
 *
 * "now" is an argument, so the ranges can be checked for any date. The result
 * is in the server time zone: task times are written to the database from
 * Date objects as well, so both sides of a comparison use the same clock.
 *
 * The Date constructor normalises overflowing day/month numbers
 * (e.g. day 0 or day 35), which makes month and year boundaries safe.
 */
export function getTaskDateRange(
  type: RangedTaskTypes,
  now: Date = new Date(),
): [Date, Date] {
  switch (type) {
    case TaskTypes.TODAY:
      return [startOfDay(now), endOfDay(now)];

    case TaskTypes.TOMORROW: {
      const tomorrow = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
      );

      return [startOfDay(tomorrow), endOfDay(tomorrow)];
    }

    /**
     * Monday 00:00 - Sunday 23:59:59.999 of the week "now" belongs to.
     * getDay() returns 0 for Sunday, which is the LAST day of the week here.
     */
    case TaskTypes.THIS_WEEK: {
      const daysSinceMonday = (now.getDay() + 6) % 7;
      const monday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - daysSinceMonday,
      );
      const sunday = new Date(
        monday.getFullYear(),
        monday.getMonth(),
        monday.getDate() + 6,
      );

      return [startOfDay(monday), endOfDay(sunday)];
    }

    case TaskTypes.THIS_MONTH:
      return [
        new Date(now.getFullYear(), now.getMonth(), 1),
        endOfDay(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
      ];

    case TaskTypes.THIS_QUARTER: {
      const currentQuarter = Math.floor(now.getMonth() / 3);
      const year = now.getFullYear();

      return [
        new Date(year, currentQuarter * 3, 1),
        endOfDay(new Date(year, (currentQuarter + 1) * 3, 0)),
      ];
    }
  }
}

function formattedRange(type: RangedTaskTypes) {
  return (now: Date = new Date()): [string, string] => {
    const [start, end] = getTaskDateRange(type, now);

    return [formatLocalTimestamp(start), formatLocalTimestamp(end)];
  };
}

/**
 * Same ranges as strings Postgres understands. Kept for callers that put the
 * values straight into SQL text (contact.service.ts).
 */
export const TaskTypeDateRange = {
  [TaskTypes.TODAY]: formattedRange(TaskTypes.TODAY),
  [TaskTypes.TOMORROW]: formattedRange(TaskTypes.TOMORROW),
  [TaskTypes.THIS_WEEK]: formattedRange(TaskTypes.THIS_WEEK),
  [TaskTypes.THIS_MONTH]: formattedRange(TaskTypes.THIS_MONTH),
  [TaskTypes.THIS_QUARTER]: formattedRange(TaskTypes.THIS_QUARTER),
};

export class FillerDto {
  @IsNumberString()
  id: number;

  @Length(1, 255)
  value: string;
}

export class SearchUserDto {
  @IsOptional()
  @IsNumberString()
  id: number;

  @IsOptional()
  @Length(1, 255)
  username: string;

  @IsOptional()
  @IsDateString()
  created_after: Date;

  @IsOptional()
  @IsDateString()
  created_before: Date;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FillerDto)
  fillers: FillerDto[];
}

export class SearchCompanyDto {
  @IsOptional()
  @IsNumberString()
  id: string;

  @IsOptional()
  @Length(1, 255)
  name: string;

  @IsOptional()
  @IsDateString()
  created_after: Date;

  @IsOptional()
  @IsDateString()
  created_before: Date;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FillerDto)
  fillers: FillerDto[];
}

/** stages=5 is the same as stages[]=5 */
const toNumberList = ({ value }) =>
  value === undefined || value === null ? value : (Array.isArray(value) ? value : [value]).map(Number);

export class SearchDealDto extends PaginationRequestDto {
  @IsOptional()
  @Length(1, 255)
  label: string;

  /**
   * The search box of the deals page: the number of the deal (125, #125), its name, the name,
   * e-mail and phone (by digits: "90 123-45-67") of a client, the company of the deal or of a client.
   */
  @IsOptional()
  @IsString()
  @Length(1, 255)
  q: string;

  /** Only these deals (the kanban re-reads the deals a live update named) */
  @IsOptional()
  @Transform(toNumberList)
  @IsArray()
  @ArrayMaxSize(200)
  @IsInt({ each: true })
  ids: number[];

  /**
   * Query string values are strings, so the value is converted to a number
   * before validation (plain @IsNumber() rejected every request).
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  display_id: number;

  @IsOptional()
  @IsDateString()
  created_after: Date;

  @IsOptional()
  @IsDateString()
  created_before: Date;

  @IsOptional()
  @IsDateString()
  closed_after: Date;

  @IsOptional()
  @IsDateString()
  closed_before: Date;

  @IsOptional()
  // stages=5 is the same as stages[]=5
  @Transform(toNumberList)
  @IsArray()
  @IsInt({ each: true })
  stages: number[];

  @IsOptional()
  @IsArray()
  @IsEnum(TaskTypes, { each: true })
  tasks: TaskTypes[];

  @IsOptional()
  @IsNumberString()
  created_by: number;

  @IsOptional()
  @IsNumberString()
  budget_from: number;

  @IsOptional()
  @IsNumberString()
  budget_till: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FillerDto)
  fillers: FillerDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => SearchUserDto)
  ctr_agent: SearchUserDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SearchUserDto)
  agent: SearchUserDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => SearchCompanyDto)
  company: SearchCompanyDto;
}

/**
 * GET /deals/board: the kanban, column by column. The filters of GET /deals apply;
 * limit / skip / sort do not (a column is ordered newest first).
 */
export class SearchDealBoardDto extends SearchDealDto {
  /** Cards of every column; 0 = the totals of the columns only */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(200)
  per_stage: number = 50;

  /** «Показать ещё» of a column (with stages=<its id>): the cards older than this deal */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  before_id: number;

  /** The closing columns show the deals closed in the last N days; 0 = all of them */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(36500)
  closed_days: number = 30;
}
