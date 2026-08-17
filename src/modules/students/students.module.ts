import { Module } from '@nestjs/common';
import { StudentsController } from './students.controller';
import { SettingsController } from './settings.controller';
import { StudentsService } from './students.service';

@Module({
  controllers: [StudentsController, SettingsController],
  providers: [StudentsService],
})
export class StudentsModule {}
