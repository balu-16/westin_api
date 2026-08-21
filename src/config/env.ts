import fs from 'node:fs';
import path from 'node:path';

// Load .env from the westin-api root (works under tsx from src/ and from dist/).
const candidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(__dirname, '../../.env'),   // src/config -> root
  path.resolve(__dirname, '../../../.env'), // dist/src/config -> root
];
const envPath = candidates.find((p) => fs.existsSync(p));
if (envPath) {
  process.loadEnvFile(envPath);
}

const jwtSecret = required('JWT_SECRET');

export const env = {
  databaseUrl: required('DATABASE_URL'),
  supabaseUrl: required('SUPABASE_URL').replace(/\/$/, ''),
  supabaseServiceKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? '',
  jwtSecret,
  // Pinned on both sign and verify — blocks algorithm-confusion and
  // cross-service token reuse.
  jwtIssuer: process.env.JWT_ISSUER ?? 'westin-api',
  jwtAudience: process.env.JWT_AUDIENCE ?? 'westin-portals',
  port: Number(process.env.PORT ?? 4000),
  smtp: {
    host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT ?? 587),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.MAIL_FROM ?? process.env.SMTP_USER ?? '',
  },
  // OTP codes are only logged when explicitly enabled for local development.
  otpLogToConsole: (process.env.OTP_LOG_TO_CONSOLE ?? 'false') === 'true',
  // Server-side pepper for OTP hashes; falls back to the JWT secret so codes
  // are never stored as a plain hash of a 6-digit space.
  otpPepper: process.env.OTP_PEPPER ?? jwtSecret,
  // Set true only when deployed behind a reverse proxy you control — Express
  // then derives req.ip from X-Forwarded-For of that trusted hop only.
  trustProxy: (process.env.TRUST_PROXY ?? 'false') === 'true',
  onesignal: {
    appId: process.env.ONESIGNAL_APP_ID ?? '88500375-185d-4ea7-b3fc-bf32b8280b3b',
    restApiKey: process.env.ONESIGNAL_REST_API_KEY ?? '',
    apiUrl: (process.env.ONESIGNAL_API_URL ?? 'https://onesignal.com/api/v1').replace(/\/$/, ''),
  },
};

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (check westin-api/.env)`);
  return value;
}
