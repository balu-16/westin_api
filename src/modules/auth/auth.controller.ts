import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { AuthUser } from '../../common/guards/jwt-auth.guard';
import { AuthService } from './auth.service';

class LoginDto {
  @IsString() @IsNotEmpty() identifier: string; // email or STU-/FAC-/ADM- id
  @IsString() @IsNotEmpty() password: string;
}

class OtpRequestDto {
  @IsString() @IsNotEmpty() identifier: string;
  @IsOptional() @IsIn(['faculty', 'admin']) portal?: string;
}

class OtpVerifyDto {
  @IsString() @IsNotEmpty() identifier: string;
  @IsString() @IsNotEmpty() code: string;
  @IsOptional() @IsIn(['faculty', 'admin']) portal?: string;
}

class RefreshDto {
  @IsString() @IsNotEmpty() refreshToken: string;
}

class LogoutDto {
  @IsString() @IsOptional() refreshToken?: string;
}

@Controller('api/auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto, @Req() req: any) {
    return this.auth.login(dto.identifier, dto.password, requestMeta(req));
  }

  @Public()
  @Post('otp/request')
  @HttpCode(200)
  requestOtp(@Body() dto: OtpRequestDto) {
    return this.auth.requestOtp(dto.identifier, dto.portal);
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  verifyOtp(@Body() dto: OtpVerifyDto, @Req() req: any) {
    // portal check is optional for verify; role already enforced in service
    return this.auth.verifyOtp(dto.identifier, dto.code, requestMeta(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  logout(@Body() dto: LogoutDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user.id);
  }
}

function requestMeta(req: any): { ip?: string; device?: string } {
  const ua: string | undefined = req.headers?.['user-agent'];
  let device: string | undefined;
  if (ua) {
    const os = /Windows/i.test(ua) ? 'Windows' : /Mac/i.test(ua) ? 'macOS' : /Android/i.test(ua)
      ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Linux/i.test(ua) ? 'Linux' : 'Unknown';
    const browser = /Edg\//i.test(ua) ? 'Edge' : /Chrome/i.test(ua) ? 'Chrome'
      : /Firefox/i.test(ua) ? 'Firefox' : /Safari/i.test(ua) ? 'Safari' : 'Unknown';
    device = `${browser} on ${os}`;
  }
  return {
    ip: (req.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.socket?.remoteAddress,
    device,
  };
}
