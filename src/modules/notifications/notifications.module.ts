import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { ReportReminderService } from './report-reminder.service';

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, ReportReminderService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
