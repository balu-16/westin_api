import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env';
import { Role } from '../decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

export type AuthUser = {
  id: string;
  role: Role;
  name: string;
  email: string;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Missing access token');

    let payload: { sub: string; role: Role; name: string; email: string };
    try {
      payload = jwt.verify(token, env.jwtSecret) as any;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    req.user = {
      id: payload.sub,
      role: payload.role,
      name: payload.name,
      email: payload.email,
    } satisfies AuthUser;
    return true;
  }
}

/** Use with @Roles() — rejects when the authenticated role is not allowed. */
export function roleAllowed(allowed: Role[] | undefined, role: Role): boolean {
  if (!allowed || allowed.length === 0) return true;
  return allowed.includes(role);
}
