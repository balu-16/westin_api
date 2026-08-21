import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { CacheModule } from './common/cache/cache.module';
import { HealthModule } from './modules/health/health.module';
import { StorageModule } from './modules/storage/storage.module';
import { MailModule } from './modules/mail/mail.module';
import { AuthModule } from './modules/auth/auth.module';
import { SectionsModule } from './modules/sections/sections.module';
import { SubjectsModule } from './modules/subjects/subjects.module';
import { TimetableModule } from './modules/timetable/timetable.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { EventsModule } from './modules/events/events.module';
import { MaterialsModule } from './modules/materials/materials.module';
import { AnnouncementsModule } from './modules/announcements/announcements.module';
import { ReportsModule } from './modules/reports/reports.module';
import { StudentsModule } from './modules/students/students.module';
import { FacultyModule } from './modules/faculty/faculty.module';
import { AdminModule } from './modules/admin/admin.module';
import { ProfileModule } from './modules/profile/profile.module';

@Module({
  imports: [
    DatabaseModule,
    CacheModule,
    HealthModule,
    StorageModule,
    MailModule,
    AuthModule,
    SectionsModule,
    SubjectsModule,
    TimetableModule,
    AttendanceModule,
    EventsModule,
    MaterialsModule,
    AnnouncementsModule,
    ReportsModule,
    StudentsModule,
    FacultyModule,
    AdminModule,
    ProfileModule,
  ],
})
export class AppModule {}
