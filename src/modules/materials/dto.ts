import { IsIn, IsInt, IsOptional, IsString, IsNotEmpty, IsUUID, Min } from 'class-validator';

export const FILE_TYPES = ['pdf', 'docx', 'pptx', 'xlsx'] as const;
export type FileType = (typeof FILE_TYPES)[number];

/** Study-materials bucket limit. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export class UploadUrlDto {
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

export class CreateMaterialDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsUUID()
  subjectId?: string | null;

  @IsIn(FILE_TYPES as unknown as string[])
  fileType: FileType;

  @IsInt()
  @Min(0)
  sizeBytes: number;

  /** Path returned earlier by POST /api/materials/upload-url. */
  @IsString()
  @IsNotEmpty()
  storagePath: string;

  @IsOptional()
  @IsString()
  description?: string | null;
}

export class UpdateMaterialDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsUUID()
  subjectId?: string | null;

  @IsOptional()
  @IsString()
  description?: string | null;
}
