import { CanActivate, ExecutionContext, HttpException, Injectable, Logger } from '@nestjs/common';
import crypto from 'node:crypto';
import { RateLimitService, RateRule } from './rate-limit.service';

/**
 * Layered rate limiting.
 *
 * Layer 1 — coarse edge-style IP guard (in production this lives at the
 *          WAF/CDN; enforced here so the app is safe standalone). Defaults
 *          sized for a campus behind one NAT IP (~1000 students sharing a
 *          public address). Health checks exempt.
 * Layer 2 — identity-aware application limits. Authenticated routes key by
 *          user id (fallback IP) so a whole campus behind one NAT IP is not
 *          blocked collectively. Public auth routes key by IP and a hash of
 *          the submitted identifier.
 * Layer 3 — endpoint-specific rules (see POLICY below).
 *
 * The per-IP budgets are env-tunable (RL_*) so deployment topologies with
 * different NAT/proxy layouts can adjust without a code change. Per-account
 * budgets (login-id 20/h) stay tight — they are the actual brute-force brake.
 */
const num = (name: string, fallback: number): number => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
};

const POLICY = {
  edgeMinute: { name: 'edge-ip-min', limit: num('RL_EDGE_IP_PER_MIN', 900), windowMs: 60_000 },
  edgeBurst: { name: 'edge-ip-burst', limit: num('RL_EDGE_IP_BURST_PER_10S', 150), windowMs: 10_000 },
  loginIp: { name: 'login-ip', limit: num('RL_LOGIN_IP_PER_MIN', 30), windowMs: 60_000 },
  loginIdentifier: { name: 'login-id', limit: num('RL_LOGIN_ID_PER_HOUR', 20), windowMs: 3_600_000 },
  otpRequestId: { name: 'otp-req-id', limit: 3, windowMs: 600_000 },
  otpRequestIp: { name: 'otp-req-ip', limit: num('RL_OTP_IP_PER_HOUR', 60), windowMs: 3_600_000 },
  otpVerifyIdIp: { name: 'otp-verify-id-ip', limit: 10, windowMs: 600_000 },
  refreshToken: { name: 'refresh-token', limit: 30, windowMs: 60_000 },
  readUser: { name: 'read-user', limit: num('RL_READ_PER_MIN', 120), windowMs: 60_000 },
  writeUser: { name: 'write-user', limit: 30, windowMs: 60_000 },
  uploadUser: { name: 'upload-user', limit: 10, windowMs: 60_000 },
} satisfies Record<string, RateRule>;

@Injectable()
export class RateLimitGuard implements CanActivate {
  private logger = new Logger('RateLimit');

  constructor(private limiter: RateLimitService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    if (process.env.RATE_LIMIT_OFF === 'true') return true;

    const path: string = req.path ?? req.url ?? '';
    const method: string = (req.method ?? 'GET').toUpperCase();
    if (method === 'GET' && path === '/api/health') return true; // edge-exempt

    const ip = clientIp(req);
    const identity = (req.user?.id as string | undefined) ?? ip;
    const body = (req.body ?? {}) as Record<string, unknown>;

    // ---- Layer 1: coarse per-IP guard (everything except health) ----
    const hits: Array<{ key: string; rule: RateRule }> = [
      { key: ip, rule: POLICY.edgeMinute },
      { key: ip, rule: POLICY.edgeBurst },
    ];

    // ---- Layers 2+3: endpoint-specific, identity-aware ----
    if (method === 'POST' && path === '/api/auth/login') {
      hits.push({ key: ip, rule: POLICY.loginIp });
      hits.push({ key: idHash(body.identifier), rule: POLICY.loginIdentifier });
    } else if (method === 'POST' && path === '/api/auth/otp/request') {
      hits.push({ key: idHash(body.identifier), rule: POLICY.otpRequestId });
      hits.push({ key: ip, rule: POLICY.otpRequestIp });
    } else if (method === 'POST' && path === '/api/auth/otp/verify') {
      hits.push({ key: `${idHash(body.identifier)}:${ip}`, rule: POLICY.otpVerifyIdIp });
    } else if (method === 'POST' && path === '/api/auth/refresh') {
      hits.push({ key: tokenHash(body.refreshToken), rule: POLICY.refreshToken });
    } else if (method === 'POST' && path.endsWith('/upload-url')) {
      hits.push({ key: identity, rule: POLICY.uploadUser });
    } else if (method === 'GET') {
      hits.push({ key: identity, rule: POLICY.readUser });
    } else {
      // POST/PATCH/PUT/DELETE (incl. logout, which is public → keyed by IP)
      hits.push({ key: identity, rule: POLICY.writeUser });
    }

    const verdict = this.limiter.hitAll(hits);
    if (verdict.allowed) return true;

    const retryAfterSec = Math.max(1, Math.ceil(verdict.retryAfterMs / 1000));
    res.setHeader?.('Retry-After', String(retryAfterSec));
    this.logger.warn(`429 ${method} ${path} rule=${verdict.rule} ip=${ip} retry=${retryAfterSec}s`);
    throw new HttpException(
      {
        statusCode: 429,
        message: `Too many requests — please try again in ${retryAfterSec}s.`,
        error: 'RateLimited',
        rule: verdict.rule,
      },
      429,
    );
  }
}

function clientIp(req: any): string {
  const fwd = req.headers?.['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

/** Normalized, hashed identifier so raw emails/ids never sit in metric keys. */
function idHash(identifier: unknown): string {
  const norm = String(identifier ?? 'anon').trim().toLowerCase();
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 20);
}

function tokenHash(token: unknown): string {
  return crypto.createHash('sha256').update(String(token ?? 'anon')).digest('hex').slice(0, 20);
}
