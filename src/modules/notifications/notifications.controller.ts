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

  @Post('notifications/send')
  @Roles('admin')
  send(@CurrentUser() user: AuthUser, @Body() dto: SendNotificationDto) {
    // normalize faculty_ids: accept both faculty_ids and facultyIds
    const raw: any = dto as any;
    const ids: string[] | undefined = raw.faculty_ids ?? raw.facultyIds;
    return this.svc.send({
      title: raw.title ?? raw.message_title ?? '',
      message: raw.message ?? raw.message_body ?? '',
      target_type: raw.target_type ?? raw.targetType,
      faculty_ids: ids,
      senderAdminId: user.id,
    });
  }
}
