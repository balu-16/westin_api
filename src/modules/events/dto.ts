import { IsBoolean, IsIn, IsOptional, IsString, IsNotEmpty, Matches } from 'class-validator';

export const EVENT_CATEGORIES = ['CULTURAL', 'TECH TALK', 'SPORTS', 'WORKSHOP', 'SEMINAR'] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateEventDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^.{1,120}$/s, { message: 'title must be 1-120 characters' })
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
  @Matches(/^.{0,60}$/s, { message: 'time must be at most 60 characters' })
  time?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^.{0,120}$/s, { message: 'location must be at most 120 characters' })
  location?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^.{0,2000}$/s, { message: 'description must be at most 2000 characters' })
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  isLive?: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^.{0,500}$/s, { message: 'posterPath too long' })
  posterPath?: string | null;
}

/** All fields optional; only provided fields are updated. */
export class UpdateEventDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Matches(/^.{1,120}$/s, { message: 'title must be 1-120 characters' })
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
  @Matches(/^.{0,60}$/s, { message: 'time must be at most 60 characters' })
  time?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^.{0,120}$/s, { message: 'location must be at most 120 characters' })
  location?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^.{0,2000}$/s, { message: 'description must be at most 2000 characters' })
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  isLive?: boolean;

  @IsOptional()
  @IsString()
  @Matches(/^.{0,500}$/s, { message: 'posterPath too long' })
  posterPath?: string | null;
}

export class EventImageUploadUrlDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  contentType?: string;

  @IsOptional()
  sizeBytes?: number;
}

export class CreateEventImageDto {
  @IsString()
  @IsNotEmpty()
  storagePath: string;

  @IsOptional()
  @IsIn(['poster', 'gallery', 'reference'])
  kind?: string;
}
