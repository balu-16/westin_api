import 'reflect-metadata';
import { NestFactory, Reflector } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import compression from 'compression';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { RateLimitGuard } from './modules/ratelimit/rate-limit.guard';
import { RateLimitService } from './modules/ratelimit/rate-limit.service';
import { env } from './config/env';

async function createServer() {
  const app = await NestFactory.create(AppModule);
  const reflector = app.get(Reflector);

  // Security headers + gzip for the JSON list payloads.
  app.use(helmet());
  app.use(compression());

  // Only the known portal origins (comma-separated CORS_ORIGINS in .env).
  const origins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:5174')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins, credentials: false });

  // Global guards, in order: authenticate → authorize → rate-limit.
  // The rate limiter runs last so it can key by the authenticated user id.
  const rateLimiter = new RateLimitService();
  app.useGlobalGuards(
    new JwtAuthGuard(reflector),
    new RolesGuard(reflector),
    new RateLimitGuard(rateLimiter),
  );
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  if (process.env.TRUST_PROXY === '1' || process.env.VERCEL === '1') {
    (app as any).getHttpAdapter().getInstance().set('trust proxy', 1);
  }

  await app.init();
  return app.getHttpAdapter().getInstance();
}

let serverPromise: Promise<any> | null = null;

function getServer() {
  if (!serverPromise) serverPromise = createServer();
  return serverPromise;
}

/** Vercel's Node runtime invokes the exported handler for each request. */
export default async function handler(req: any, res: any) {
  const server = await getServer();
  return server(req, res);
}

// Keep the normal long-running local development server behavior.
if (process.env.VERCEL !== '1') {
  getServer()
    .then((server) => {
      server.listen(env.port, () => {
        console.log(`westin-api listening on http://localhost:${env.port}`);
      });
    })
    .catch((err) => {
      console.error('Failed to start westin-api:', err);
      process.exit(1);
    });
}
