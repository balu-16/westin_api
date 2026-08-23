import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';
import { SendNotificationDto } from './notifications.dto';

class SettingsBodyDto {
  @IsOptional()
  @IsBoolean()
  receiveFromOtherAdmins?: boolean;

  @IsOptional()
  @IsBoolean()
  receive_from_other_admins?: boolean;
}

class HistoryQueryDto {
  @IsOptional()
  @IsString()
  senderAdminId?: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsString()
  page?: string;

  @IsOptional()
  @IsString()
  pageSize?: string;
}

@Controller('api')
export class NotificationsController {
  constructor(private svc: NotificationsService) {}

  // Read — both portals share this helper shape (simple directory)
  @Get('faculty/list')
  @Roles('admin')
  facultyList() {
    return this.svc.facultyList();
  }

  @Get('students/list')
  @Roles('admin')
  studentsList() {
    return this.svc.studentsList();
  }

  @Get('notifications/history')
  @Roles('admin')
  history(@Query() q: HistoryQueryDto) {
    return this.svc.history(q);
  }

  @Get('notifications/history/:id')
  @Roles('admin')
  historyDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.historyDetail(id);
  }

  @Get('notifications/settings')
  @Roles('admin')
  getSettings(@CurrentUser() user: AuthUser) {
    return this.svc.getSettings(user.id);
  }

  @Put('notifications/settings')
  @Roles('admin')
  putSettings(@CurrentUser() user: AuthUser, @Body() body: SettingsBodyDto) {
    const raw = body.receiveFromOtherAdmins ?? body.receive_from_other_admins;
    const value = Boolean(raw);
    return this.svc.putSettings(user.id, value);
  }

  @Get('notifications/my')
  @Roles('faculty', 'student', 'admin')
  myNotifications(@CurrentUser() user: AuthUser, @Query('limit') limit?: string) {
    return this.svc.myNotifications(user.id, Number(limit) || 30);
  }

  @Put('notifications/my/read-all')
  @Roles('faculty', 'student', 'admin')
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.svc.markAllRead(user.id);
  }

  @Put('notifications/my/:id/read')
  @Roles('faculty', 'student', 'admin')
  markRead(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.svc.markRead(user.id, id);
  }

  @Post('notifications/thanks')
  @Roles('faculty', 'student', 'admin')
  subscriptionThanks(@CurrentUser() user: AuthUser) {
    return this.svc.sendSubscriptionThanks({ id: user.id, role: user.role });
  }

  @Post('notifications/send')
  @Roles('admin')
  send(@CurrentUser() user: AuthUser, @Body() dto: SendNotificationDto) {
    // normalize ids: accept both snake_case and camelCase keys
    const raw: any = dto as any;
    const facultyIds: string[] | undefined = raw.faculty_ids ?? raw.facultyIds;
    const studentIds: string[] | undefined = raw.student_ids ?? raw.studentIds;
    return this.svc.send({
      title: raw.title ?? raw.message_title ?? '',
      message: raw.message ?? raw.message_body ?? '',
      target_type: raw.target_type ?? raw.targetType,
      faculty_ids: facultyIds,
      student_ids: studentIds,
      senderAdminId: user.id,
    });
  }
}
