import { IsArray, IsEnum, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export type NotificationTarget = 'all_faculty' | 'selected_faculty' | 'admins';

export class SendNotificationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  message!: string;

  @IsEnum(['all_faculty', 'selected_faculty', 'admins'] as const)
  target_type!: NotificationTarget;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  faculty_ids?: string[];
}

export class UpdateSettingsDto {
  receiveFromOtherAdmins!: boolean;
  // allow both camelCase and snake_case from frontend
  receive_from_other_admins?: boolean;
}
