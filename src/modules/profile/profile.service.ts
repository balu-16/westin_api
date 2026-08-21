import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
import { StorageService, BUCKETS } from '../storage/storage.service';

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function extFromContentType(ct: string): string | null {
  return MIME_EXT[ct] ?? null;
}

function sanitizeExt(name: string): string | null {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return null;
  const ext = m[1];
  if (ext === 'jpeg' || ext === 'jpg') return 'jpg';
  if (ext === 'png') return 'png';
  if (ext === 'webp') return 'webp';
  return null;
}

@Injectable()
export class ProfileService {
  private logger = new Logger('Profile');

  constructor(
    private db: DatabaseService,
    private storage: StorageService,
  ) {}

  async createUploadUrl(userId: string, dto: { filename: string; contentType: string; size?: number }) {
    const contentType = dto.contentType?.toLowerCase().trim();
    if (!ALLOWED_MIME.has(contentType)) {
      throw new BadRequestException('Only JPEG, PNG and WebP images are allowed');
    }
    if (dto.size != null && dto.size > MAX_AVATAR_BYTES) {
      throw new BadRequestException('Avatar must be 5 MB or smaller');
    }
    const ext = extFromContentType(contentType) ?? sanitizeExt(dto.filename) ?? 'jpg';
    const path = `${userId}/${randomUUID()}.${ext}`;
    // Supabase signs a short-lived upload URL; client PUTs bytes directly.
    const { url, token } = await this.storage.signedUploadUrl(BUCKETS.profileAvatars, path, 600);
    return { url, path, token, expiresIn: 600, contentType, maxSize: MAX_AVATAR_BYTES };
  }

  async finalizeAvatar(userId: string, path: string) {
    if (!path || typeof path !== 'string') throw new BadRequestException('Path is required');
    // Server-owned path only: must be under the caller's folder
    if (!path.startsWith(`${userId}/`)) {
      throw new BadRequestException('Invalid avatar path');
    }
    const suffix = path.slice(userId.length + 1);
    // {uuid}.{ext}
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/i.test(suffix)) {
      throw new BadRequestException('Invalid avatar path format');
    }

    // Verify object was actually uploaded
    let exists = false;
    try {
      exists = await this.storage.objectExists(BUCKETS.profileAvatars, path);
    } catch (e: any) {
      throw new BadRequestException(`Could not verify avatar upload: ${e.message}`);
    }
    if (!exists) throw new BadRequestException('Avatar file not found — please upload again');

    // Optional size/type check via HEAD (best-effort)
    try {
      const head = await this.storage.headObject(BUCKETS.profileAvatars, path);
      if (head.exists && head.size != null && head.size > MAX_AVATAR_BYTES) {
        // clean up oversized orphan
        await this.storage.deleteObject(BUCKETS.profileAvatars, path).catch(() => {});
        throw new BadRequestException('Avatar exceeds 5 MB');
      }
      if (head.exists && head.contentType && !ALLOWED_MIME.has(head.contentType.toLowerCase())) {
        await this.storage.deleteObject(BUCKETS.profileAvatars, path).catch(() => {});
        throw new BadRequestException('Invalid avatar file type');
      }
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      // head failure not fatal beyond exists check
      this.logger.warn(`avatar head check failed for ${path}: ${e.message}`);
    }

    const prev = await this.db.queryOne<{ avatar_path: string | null }>(
      `select avatar_path from users where id=$1`,
      [userId],
    );
    const prevPath = prev?.avatar_path ?? null;

    await this.db.query(`update users set avatar_path=$1, updated_at=now() where id=$2`, [path, userId]);

    // Delete previous object after DB success (best-effort, no rollback if delete fails)
    if (prevPath && prevPath !== path) {
      await this.storage.deleteObject(BUCKETS.profileAvatars, prevPath).catch((err) => {
        this.logger.warn(`failed to delete previous avatar ${prevPath}: ${err.message}`);
      });
    }

    // Return fresh avatarUrl
    let avatarUrl: string | null = null;
    try {
      avatarUrl = await this.storage.signedUrl(BUCKETS.profileAvatars, path, 3600);
    } catch {}
    return { avatarUrl, path };
  }

  async removeAvatar(userId: string) {
    const prev = await this.db.queryOne<{ avatar_path: string | null }>(
      `select avatar_path from users where id=$1`,
      [userId],
    );
    if (!prev?.avatar_path) throw new NotFoundException('No avatar to remove');
    const prevPath = prev.avatar_path;
    await this.db.query(`update users set avatar_path=null, updated_at=now() where id=$1`, [userId]);
    await this.storage.deleteObject(BUCKETS.profileAvatars, prevPath).catch((err) => {
      this.logger.warn(`failed to delete avatar ${prevPath}: ${err.message}`);
    });
    return { removed: true };
  }
}
