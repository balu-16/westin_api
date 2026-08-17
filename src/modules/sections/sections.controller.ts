import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, HttpCode } from '@nestjs/common';
import { IsInt, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import { Roles } from '../../common/decorators/roles.decorator';
import { SectionsService } from './sections.service';

class CreateSectionDto {
  @IsString() @IsNotEmpty() label: string;
  @IsString() @IsNotEmpty() department: string;
  @IsInt() year: number;
  @IsOptional() @IsUUID() classTeacherId?: string;
  @IsOptional() @IsInt() maxStrength?: number;
}

class UpdateSectionDto {
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsString() department?: string;
  @IsOptional() @IsInt() year?: number;
  @IsOptional() @IsUUID() classTeacherId?: string | null;
  @IsOptional() @IsInt() maxStrength?: number;
}

class MoveStudentDto {
  @IsUUID() studentId: string;
}

@Controller('api/sections')
export class SectionsController {
  constructor(private sections: SectionsService) {}

  @Get()
  @Roles('faculty', 'admin')
  list() {
    return this.sections.list();
  }

  @Get(':id')
  @Roles('faculty', 'admin')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.sections.findOne(id);
  }

  @Post()
  @HttpCode(200)
  @Roles('admin')
  create(@Body() dto: CreateSectionDto) {
    return this.sections.create(dto);
  }

  @Patch(':id')
  @Roles('admin')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSectionDto) {
    return this.sections.update(id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.sections.remove(id);
  }

  @Post(':id/students/move')
  @HttpCode(200)
  @Roles('admin')
  moveStudent(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MoveStudentDto) {
    return this.sections.moveStudent(id, dto.studentId);
  }
}
