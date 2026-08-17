import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/guards/jwt-auth.guard';
import { FacultyService } from './faculty.service';

@Controller('api/faculty')
@Roles('faculty')
export class FacultyController {
  constructor(private faculty: FacultyService) {}

  @Get('me/dashboard')
  dashboard(@CurrentUser() user: AuthUser) {
    return this.faculty.dashboard(user.id);
  }

  @Get('me/sections')
  mySections(@CurrentUser() user: AuthUser) {
    return this.faculty.mySections(user.id);
  }

  @Get('sections/:id/students')
  sectionStudents(@Param('id', ParseUUIDPipe) id: string) {
    return this.faculty.sectionStudents(id);
  }
}
