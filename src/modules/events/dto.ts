import { IsBoolean, IsIn, IsOptional, IsString, IsNotEmpty, Matches } from 'class-validator';

export const EVENT_CATEGORIES = ['CULTURAL', 'TECH TALK', 'SPORTS', 'WORKSHOP', 'SEMINAR'] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateEventDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsIn(EVENT_CATEGORIES as unknown as string[])
  category: string;

  /** YYYY-MM-DD */
  @Matches(DATE_RE, { message: 'startDate must be a YYYY-MM-DD date' })
  startDate: string;

  /** YYYY-MM-DD, optional */
  @IsOptional()
  @Matches(DATE_RE, { message: 'endDate must be a YYYY-MM-DD date' })
  endDate?: string | null;

  /** Free-form display string, e.g. "09:00 AM - 08:00 PM" */
  @IsOptional()
  @IsString()
  time?: string | null;

  @IsOptional()
  @IsString()
  location?: string | null;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  isLive?: boolean;
}

/** All fields optional; only provided fields are updated. */
export class UpdateEventDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  title?: string;

  @IsOptional()
  @IsIn(EVENT_CATEGORIES as unknown as string[])
  category?: string;

  @IsOptional()
  @Matches(DATE_RE, { message: 'startDate must be a YYYY-MM-DD date' })
  startDate?: string;

  @IsOptional()
  @Matches(DATE_RE, { message: 'endDate must be a YYYY-MM-DD date' })
  endDate?: string | null;

  @IsOptional()
  @IsString()
  time?: string | null;

  @IsOptional()
  @IsString()
  location?: string | null;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  isLive?: boolean;
}
