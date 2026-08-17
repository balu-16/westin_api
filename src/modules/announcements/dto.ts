import { IsIn, IsOptional, IsString, IsNotEmpty } from 'class-validator';

export const ANNOUNCEMENT_CATEGORIES = ['exam', 'event', 'general'] as const;
export const AUDIENCES = ['all', 'students', 'faculty'] as const;

export class CreateAnnouncementDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  message: string;

  @IsOptional()
  @IsIn(ANNOUNCEMENT_CATEGORIES as unknown as string[])
  category?: string;

  @IsOptional()
  @IsIn(AUDIENCES as unknown as string[])
  audience?: string;
}

/** All fields optional; only provided fields are updated. */
export class UpdateAnnouncementDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  title?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  message?: string;

  @IsOptional()
  @IsIn(ANNOUNCEMENT_CATEGORIES as unknown as string[])
  category?: string;

  @IsOptional()
  @IsIn(AUDIENCES as unknown as string[])
  audience?: string;
}
