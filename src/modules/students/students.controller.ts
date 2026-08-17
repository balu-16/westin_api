import { Body, Controller, Get, Patch } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { Roles } from '../../common/decorators/roles.decorator';
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

@Controller('api/students')
@Roles('student')
export class StudentsController {
  constructor(private students: StudentsService) {}

  @Get('me/dashboard')
  dashboard(@CurrentUser() user: AuthUser) {
    return this.students.dashboard(user.id);
  }

  @Get('me/settings')
  settings(@CurrentUser() user: AuthUser) {
    return this.students.getSettings(user.id);
  }

  @Patch('me/settings')
  updateSettings(@CurrentUser() user: AuthUser, @Body() dto: SettingsDto) {
    return this.students.updateSettings(user.id, dto);
  }
}
