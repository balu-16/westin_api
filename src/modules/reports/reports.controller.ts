import { Body, Controller, Delete, Get, Param, Post, Query, HttpCode } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/guards/jwt-auth.guard';
import { ReportsService } from './reports.service';
import { CreateReportDto, ReportUploadUrlDto } from './dto';

@Controller('api/reports')
export class ReportsController {
  constructor(private reports: ReportsService) {}

  /** Own reports, newest first. */
  @Get('mine')
  @Roles('faculty')
  mine(@CurrentUser() user: AuthUser) {
    return this.reports.mine(user.id);
  }

  /** Admin listing of all reports (with faculty names) + filters. */
  @Get()
  @Roles('admin')
  listAdmin(
    @Query('search') search?: string,
    @Query('sectionId') sectionId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.reports.listAdmin({ search, sectionId, from, to }, page, pageSize);
  }

  /** Step 1 of the attachment flow: get a path + signed PUT URL. */
  @Post('upload-url')
  @HttpCode(200)
  @Roles('faculty')
  uploadUrl(@Body() dto: ReportUploadUrlDto) {
    return this.reports.uploadUrl(dto);
  }

  /** Step 2 of the attachment flow: submit the report row. */
  @Post()
  @HttpCode(200)
  @Roles('faculty')
  create(@Body() dto: CreateReportDto, @CurrentUser() user: AuthUser) {
    return this.reports.create(dto, user.id);
  }

  /** Faculty may delete their own reports; admins any. */
  @Delete(':id')
  @Roles('faculty', 'admin')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.reports.remove(id, user);
  }
}
