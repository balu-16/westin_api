import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, HttpCode } from '@nestjs/common';
import { IsArray, IsIn, IsInt, IsNotEmpty, IsString, IsUUID, Matches, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/guards/jwt-auth.guard';
import { DatabaseService } from '../../database/database.service';
import { TimetableService, ImportRow } from './timetable.service';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

class SlotDto {
  @IsUUID() sectionId: string;
  @IsInt() @Min(0) @Max(5) day: number;
  @IsString() @Matches(HHMM, { message: 'startTime must be HH:MM (00:00-23:59)' }) startTime: string;
  @IsString() @Matches(HHMM, { message: 'endTime must be HH:MM (00:00-23:59)' }) endTime: string;
  @IsUUID() subjectId: string;
  @IsUUID() facultyId: string;
  @IsUUID() roomId: string;
}

class ImportDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportRow)
  rows: ImportRow[];
  @IsIn(['add', 'replace']) mode: 'add' | 'replace';
}

@Controller('api/timetable')
export class TimetableController {
  constructor(
    private timetable: TimetableService,
    private db: DatabaseService,
  ) {}

  @Get()
  async week(@Query('sectionId') sectionId: string | undefined, @CurrentUser() user: AuthUser) {
    let sid = sectionId;
    if (!sid) {
      if (user.role !== 'student') throw new BadRequestException('sectionId is required');
      const row = await this.db.queryOne<{ section_id: string }>(
        `select section_id from student_profiles where user_id = $1`, [user.id],
      );
      if (!row?.section_id) return [];
      sid = row.section_id;
    }
    return this.timetable.week(sid);
  }

  @Get('faculty/mine')
  @Roles('faculty')
  async facultyMine(@CurrentUser() user: AuthUser) {
    return this.timetable.facultyWeek(user.id);
  }

  @Get('slots')
  @Roles('admin')
  builderSlots(@Query('sectionId') sectionId: string, @Query('day') day?: string) {
    if (day !== undefined && day !== '') {
      const n = Number(day);
      if (!Number.isInteger(n)) throw new BadRequestException('day must be an integer 0..5');
      return this.timetable.builderSlots(sectionId, n);
    }
    return this.timetable.builderSlots(sectionId, undefined);
  }

  @Get('rooms')
  @Roles('admin')
  rooms() {
    return this.timetable.rooms();
  }

  @Get('availability')
  @Roles('admin')
  availability(
    @Query('sectionId') sectionId: string,
    @Query('day') day: string,
    @Query('startTime') startTime: string,
    @Query('endTime') endTime: string,
  ) {
    const n = Number(day);
    if (!Number.isInteger(n)) throw new BadRequestException('day must be an integer 0..5');
    return this.timetable.availability(sectionId, n, startTime, endTime);
  }

  @Post('slots')
  @HttpCode(201)
  @Roles('admin')
  createSlot(@Body() dto: SlotDto) {
    return this.timetable.createSlot(dto);
  }

  @Put('slots/:id')
  @Roles('admin')
  updateSlot(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SlotDto) {
    return this.timetable.updateSlot(id, dto);
  }

  @Delete('slots/:id')
  @Roles('admin')
  deleteSlot(@Param('id', ParseUUIDPipe) id: string) {
    return this.timetable.deleteSlot(id);
  }

  @Post('import')
  @HttpCode(200)
  @Roles('admin')
  import(@Body() dto: ImportDto) {
    return this.timetable.import(dto);
  }
}
