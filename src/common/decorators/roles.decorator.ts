import { SetMetadata } from '@nestjs/common';

export type Role = 'student' | 'faculty' | 'admin';

export const ROLES_KEY = 'roles';

/** Restrict a route to the given roles (any-of). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
