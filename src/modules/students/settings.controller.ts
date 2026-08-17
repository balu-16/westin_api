import { Body, Controller, Get, Patch } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/guards/jwt-auth.guard';
import { StudentsService } from './students.service';

class SettingsDto {
  @IsOptional() @IsBoolean() push?: boolean;
  @IsOptional() @IsBoolean() email?: boolean;
  @IsOptional() @IsBoolean() announcements?: boolean;
  @IsOptional() @IsBoolean() reminders?: boolean;
  @IsOptional() @IsString() theme?: string;
}

/** Notification/appearance settings for any authenticated user. */
@Controller('api/settings')
export class SettingsController {
  constructor(private students: StudentsService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.students.getSettings(user.id);
  }

  @Patch()
  update(@CurrentUser() user: AuthUser, @Body() dto: SettingsDto) {
    return this.students.updateSettings(user.id, dto);
  }
}
