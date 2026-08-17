import { Body, Controller, Delete, Get, Param, Post, Put, HttpCode } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/guards/jwt-auth.guard';
import { EventsService } from './events.service';
import { CreateEventDto, UpdateEventDto } from './dto';

@Controller('api/events')
export class EventsController {
  constructor(private events: EventsService) {}

  /** Aggregated events payload — any authenticated role. */
  @Get()
  list() {
    return this.events.list();
  }

  @Post()
  @HttpCode(200)
  @Roles('faculty', 'admin')
  create(@Body() dto: CreateEventDto, @CurrentUser() user: AuthUser) {
    return this.events.create(dto, user.id);
  }

  @Put(':id')
  @Roles('faculty', 'admin')
  update(@Param('id') id: string, @Body() dto: UpdateEventDto) {
    return this.events.update(id, dto);
  }

  @Delete(':id')
  @Roles('faculty', 'admin')
  remove(@Param('id') id: string) {
    return this.events.remove(id);
  }
}
