import { Body, Controller, Delete, Get, Param, Patch, Post, Query, HttpCode } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/guards/jwt-auth.guard';
import { MaterialsService } from './materials.service';
import { CreateMaterialDto, UpdateMaterialDto, UploadUrlDto } from './dto';

@Controller('api/materials')
export class MaterialsController {
  constructor(private materials: MaterialsService) {}

  /** Library listing — any authenticated role. */
  @Get()
  list(@Query('search') search?: string, @Query('subjectId') subjectId?: string) {
    return this.materials.list(search, subjectId);
  }

  /** Step 1 of the upload flow: get a path + signed PUT URL. */
  @Post('upload-url')
  @HttpCode(200)
  @Roles('faculty', 'admin')
  uploadUrl(@Body() dto: UploadUrlDto) {
    return this.materials.uploadUrl(dto);
  }

  /** Step 2 of the upload flow: register the uploaded object as a study file. */
  @Post()
  @HttpCode(200)
  @Roles('faculty', 'admin')
  create(@Body() dto: CreateMaterialDto, @CurrentUser() user: AuthUser) {
    return this.materials.create(dto, user.id);
  }

  @Patch(':id')
  @Roles('faculty', 'admin')
  update(@Param('id') id: string, @Body() dto: UpdateMaterialDto) {
    return this.materials.update(id, dto);
  }

  @Delete(':id')
  @Roles('faculty', 'admin')
  remove(@Param('id') id: string) {
    return this.materials.remove(id);
  }
}
