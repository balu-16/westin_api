import { Body, Controller, Delete, Get, Param, Post, Put, Query, HttpCode } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/guards/jwt-auth.guard';
import { EventsService } from './events.service';
import { CreateEventDto, CreateEventImageDto, EventImageUploadUrlDto, UpdateEventDto } from './dto';

@Controller('api/events')
export class EventsController {
  constructor(private events: EventsService) {}

  /** Aggregated events payload — any authenticated role.
   *  Query: ?search&category&from(YYYY-MM-DD)&to&includePast=true */
  @Get()
  list(
    @Query('search') search?: string,
    @Query('category') category?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('includePast') includePast?: string,
  ) {
    return this.events.list({ search, category, from, to, includePast });
  }

  @Post('upload-url')
  @HttpCode(200)
  @Roles('faculty', 'admin')
  uploadUrl(@Body() dto: EventImageUploadUrlDto) {
    return this.events.eventImageUploadUrl(dto);
  }

  @Get(':id/images')
  images(@Param('id') id: string) {
    return this.events.listImages(id);
  }

  @Post(':id/images')
  @HttpCode(200)
  @Roles('faculty', 'admin')
  addImage(@Param('id') id: string, @Body() dto: CreateEventImageDto, @CurrentUser() user: AuthUser) {
    return this.events.addImage(id, dto, user.id, user.role);
  }

  @Delete('images/:imageId')
  @Roles('faculty', 'admin')
  removeImage(@Param('imageId') imageId: string, @CurrentUser() user: AuthUser) {
    return this.events.removeImage(imageId, { id: user.id, role: user.role });
  }

  @Post()
  @HttpCode(200)
  @Roles('faculty', 'admin')
  create(@Body() dto: CreateEventDto, @CurrentUser() user: AuthUser) {
    return this.events.create(dto, user.id);
  }

  @Put(':id')
  @Roles('faculty', 'admin')
  update(@Param('id') id: string, @Body() dto: UpdateEventDto, @CurrentUser() user: AuthUser) {
    return this.events.update(id, dto, { id: user.id, role: user.role });
  }

  @Delete(':id')
  @Roles('faculty', 'admin')
  remove(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.events.remove(id, { id: user.id, role: user.role });
  }
}
