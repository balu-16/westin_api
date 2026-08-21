import { Injectable, Logger } from '@nestjs/common';
import { env } from '../../config/env';

/**
 * Talks to the Supabase Storage HTTP API with the service-role key.
 * Buckets are private: clients only ever receive signed, short-lived URLs.
 */
/** Signed URLs are identical for every caller (service-role key, private
 *  buckets), so responses are cached in-process instead of re-signing the
 *  same object on every listing request (N+1 external HTTPS round trips). */
const SIGNED_URL_SAFETY_SECONDS = 5 * 60;

type CachedSignedUrl = { url: string; expiresAt: number };

@Injectable()
export class StorageService {
  private logger = new Logger('Storage');
  private signedUrlCache = new Map<string, CachedSignedUrl>();

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${env.supabaseUrl}${path}`, {
      ...init,
      headers: {
        apikey: env.supabaseServiceKey,
        Authorization: `Bearer ${env.supabaseServiceKey}`,
        ...(init.headers ?? {}),
      },
    });
    return res;
  }

  async ensureBucket(name: string, fileSizeLimit: number): Promise<void> {
    const list = await this.call('/storage/v1/bucket');
    const buckets: any[] = list.ok ? ((await list.json()) as any[]) : [];
    if (buckets.some((b) => b.name === name)) return;
    const created = await this.call('/storage/v1/bucket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: name, name, public: false, file_size_limit: fileSizeLimit }),
    });
    if (!created.ok) {
      this.logger.error(`Failed to create bucket ${name}: ${await created.text()}`);
      throw new Error(`Failed to create bucket ${name}`);
    }
    this.logger.log(`Created storage bucket ${name}`);
  }

  /** Signed download URL (default 1 hour), served from an in-memory cache. */
  async signedUrl(bucket: string, path: string, expiresIn = 3600): Promise<string> {
    const key = `${bucket}:${path}`;
    const cached = this.signedUrlCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.url;

    const res = await this.call(`/storage/v1/object/sign/${bucket}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn }),
    });
    if (!res.ok) throw new Error(`sign failed: ${await res.text()}`);
    const { signedURL } = (await res.json()) as any;
    const url = `${env.supabaseUrl}/storage/v1${signedURL}`;
    const ttlSeconds = Math.max(0, expiresIn - SIGNED_URL_SAFETY_SECONDS);
    this.signedUrlCache.set(key, { url, expiresAt: Date.now() + ttlSeconds * 1000 });
    return url;
  }

  /** Signed URL the client PUTs the file bytes to. */
  async signedUploadUrl(bucket: string, path: string, expiresIn = 600): Promise<{ url: string; token: string }> {
    const res = await this.call(`/storage/v1/object/upload/sign/${bucket}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn }),
    });
    if (!res.ok) throw new Error(`upload-sign failed: ${await res.text()}`);
    const { url, token } = (await res.json()) as any;
    return { url: `${env.supabaseUrl}/storage/v1${url}`, token };
  }

  /** Server-side upload used by the seed script and small attachments. */
  async uploadObject(
    bucket: string,
    path: string,
    data: Buffer | Uint8Array,
    contentType: string,
  ): Promise<string> {
    const res = await this.call(`/storage/v1/object/${bucket}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'x-upsert': 'true' },
      body: data as any,
    });
    if (!res.ok) throw new Error(`upload failed: ${await res.text()}`);
    return path;
  }

  async deleteObject(bucket: string, path: string): Promise<void> {
    const res = await this.call(`/storage/v1/object/${bucket}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [path] }),
    });
    if (!res.ok) throw new Error(`delete failed: ${await res.text()}`);
    this.signedUrlCache.delete(`${bucket}:${path}`);
  }

  async objectExists(bucket: string, path: string): Promise<boolean> {
    const res = await this.call(`/storage/v1/object/${bucket}/${path}`, {
      method: 'HEAD',
    });
    if (res.ok) return true;
    if (res.status === 404) return false;
    // Some deployments return 400 for missing; treat 404-like as false, else throw
    const text = await res.text().catch(() => '');
    if (text.toLowerCase().includes('not found') || text.toLowerCase().includes('object not found')) return false;
    throw new Error(`object check failed: ${text || res.status}`);
  }

  async headObject(bucket: string, path: string): Promise<{ exists: boolean; size?: number; contentType?: string }> {
    const res = await this.call(`/storage/v1/object/${bucket}/${path}`, { method: 'HEAD' });
    if (res.status === 404) return { exists: false };
    if (!res.ok) throw new Error(`head failed: ${await res.text()}`);
    const len = res.headers.get('content-length');
    return { exists: true, size: len ? Number(len) : undefined, contentType: res.headers.get('content-type') ?? undefined };
  }
}

export const BUCKETS = {
  studyMaterials: 'study-materials',       // 50 MB limit
  reportAttachments: 'report-attachments', // 20 MB limit
  profileAvatars: 'profile-avatars',       // 5 MB limit
} as const;
