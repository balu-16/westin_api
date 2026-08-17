import { Body, Controller, Delete, Get, Param, Patch, Post, HttpCode } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/guards/jwt-auth.guard';
import { AnnouncementsService } from './announcements.service';
import { CreateAnnouncementDto, UpdateAnnouncementDto } from './dto';

@Controller('api/announcements')
export class AnnouncementsController {
  constructor(private announcements: AnnouncementsService) {}

  /** Audience-filtered read — any authenticated role. */
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.announcements.listForRole(user.role);
  }

  @Post()
  @HttpCode(200)
  @Roles('admin')
  create(@Body() dto: CreateAnnouncementDto) {
    return this.announcements.create(dto);
  }

  @Patch(':id')
  @Roles('admin')
  update(@Param('id') id: string, @Body() dto: UpdateAnnouncementDto) {
    return this.announcements.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  remove(@Param('id') id: string) {
    return this.announcements.remove(id);
  }
}
