import { IsInt, IsOptional, IsString, IsNotEmpty, IsUUID, Matches, Min } from 'class-validator';

/** Report-attachments bucket limit. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class ReportUploadUrlDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  /** MIME type the client will PUT (e.g. application/pdf). */
  @IsString()
  @IsNotEmpty()
  contentType: string;

  @IsInt()
  @Min(1)
  sizeBytes: number;
}

export class CreateReportDto {
  @IsUUID()
  sectionId: string;

  @IsUUID()
  subjectId: string;

  /** YYYY-MM-DD */
  @Matches(DATE_RE, { message: 'reportDate must be a YYYY-MM-DD date' })
  reportDate: string;

  @IsString()
  @IsNotEmpty()
  topic: string;

  /** Path returned earlier by POST /api/reports/upload-url. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  attachmentPath?: string | null;
}
