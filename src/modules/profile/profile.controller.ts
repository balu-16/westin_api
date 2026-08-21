import { Body, Controller, Delete, Patch, Post } from '@nestjs/common';
import { IsNotEmpty, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthUser } from '../../common/guards/jwt-auth.guard';
import { AuthService } from '../auth/auth.service';
import { ProfileService } from './profile.service';

class AvatarUploadUrlDto {
  @IsString() @IsNotEmpty() filename!: string;
  @IsString() @IsNotEmpty() contentType!: string;
  @IsOptional() @IsNumber() @Min(1) @Max(5 * 1024 * 1024) size?: number;
}

class AvatarFinalizeDto {
  @IsString() @IsNotEmpty() path!: string;
}

@Controller('api/profile')
export class ProfileController {
  constructor(
    private profile: ProfileService,
    private auth: AuthService,
  ) {}

  @Post('avatar/upload-url')
  async uploadUrl(@CurrentUser() user: AuthUser, @Body() dto: AvatarUploadUrlDto) {
    return this.profile.createUploadUrl(user.id, {
      filename: dto.filename,
      contentType: dto.contentType,
      size: dto.size,
    });
  }

  @Patch('avatar')
  async finalize(@CurrentUser() user: AuthUser, @Body() dto: AvatarFinalizeDto) {
    const result = await this.profile.finalizeAvatar(user.id, dto.path);
    // Return updated user payload so caller can refresh sidebar instantly
    const freshUser = await this.auth.me(user.id);
    return { ...result, user: freshUser };
  }

  @Delete('avatar')
  async remove(@CurrentUser() user: AuthUser) {
    const result = await this.profile.removeAvatar(user.id);
    const freshUser = await this.auth.me(user.id);
    return { ...result, user: freshUser };
  }
}
