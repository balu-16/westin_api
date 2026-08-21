import { Body, Controller, Get, Post, Query, HttpCode } from '@nestjs/common';
import { IsArray, IsISO8601, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/guards/jwt-auth.guard';
import { AttendanceService } from './attendance.service';

class AttendanceRecordDto {
  @IsUUID() studentId: string;
  @IsIn(['present', 'absent', 'leave']) status: string;
}

class MarkAttendanceDto {
  @IsUUID() sectionId: string;
  @IsISO8601() date: string;
  @IsString() @IsNotEmpty() period: string;
  @IsOptional() @IsUUID() subjectId?: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => AttendanceRecordDto)
  records: AttendanceRecordDto[];
}

@Controller('api/attendance')
export class AttendanceController {
  constructor(private attendance: AttendanceService) {}

  @Get('roster')
  @Roles('faculty')
  roster(
    @CurrentUser() user: AuthUser,
    @Query('sectionId') sectionId: string,
    @Query('date') date: string,
    @Query('period') period: string,
  ) {
    return this.attendance.roster(user.id, sectionId, date, period);
  }

  @Post('mark')
  @HttpCode(200)
  @Roles('faculty')
  mark(@CurrentUser() user: AuthUser, @Body() dto: MarkAttendanceDto) {
    return this.attendance.mark(user.id, dto);
  }

  @Get('my')
  @Roles('student')
  my(@CurrentUser() user: AuthUser, @Query('month') month?: string) {
    return this.attendance.myAttendance(user.id, month);
  }
}
