import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, HttpCode } from '@nestjs/common';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SubjectsService } from './subjects.service';

class CreateSubjectDto {
  @IsString() @IsNotEmpty() name: string;
  @IsString() @IsNotEmpty() code: string;
}

class UpdateSubjectDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() code?: string;
}

@Controller('api/subjects')
export class SubjectsController {
  constructor(private subjects: SubjectsService) {}

  @Get()
  list() {
    return this.subjects.list();
  }

  @Post()
  @HttpCode(200)
  @Roles('admin')
  create(@Body() dto: CreateSubjectDto) {
    return this.subjects.create(dto);
  }

  @Patch(':id')
  @Roles('admin')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSubjectDto) {
    return this.subjects.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.subjects.remove(id);
  }
}
