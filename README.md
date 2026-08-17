# westin-api

One NestJS API + one Supabase Postgres database serving all three Westin College
portals (student, faculty, admin). **No ORM** — every query is hand-written,
parameterized SQL over `node-postgres` (`pg`).

## Architecture

- **NestJS 11**, TypeScript. Modules: `auth`, `sections`, `subjects`, `timetable`,
  `attendance`, `events`, `materials`, `announcements`, `reports`, `students`,
  `faculty`, `admin`, plus global `storage` (Supabase Storage signed URLs) and
  `mail` (nodemailer/Gmail SMTP) modules.
- **Supabase Postgres** via the session pooler (`aws-0-ap-south-1`). All tables
  have RLS **enabled with zero policies**, so the public anon key cannot read or
  write anything — the API connects as `postgres`, which bypasses RLS.
- **Supabase Storage**: private buckets `study-materials` (50 MB) and
  `report-attachments` (20 MB). Clients only receive short-lived signed URLs.
- **Auth**: password login for students (the administrator-assigned default is
  `Password@123`) plus 6-digit OTP-only login for faculty/admin (hashed in DB,
  10-min expiry, 30-s resend throttle, 5-attempt cap, emailed via Gmail SMTP
  and logged to the API console in dev).
  JWT access tokens (15 min) + rotating refresh tokens (7 days). Every login
  writes a `login_logs` row (powers the admin Login Logs tabs).
- Role guards: `student` / `faculty` / `admin` per route via `@Roles()`.
- **Layered rate limiting** (`src/modules/ratelimit/`) — fixed-window counters,
  identity-aware so a campus behind one NAT IP is never blocked collectively:

  | Layer | Rule | Limit |
  |---|---|---|
  | Edge (per IP) | all `/api` paths | 900/min + burst 150/10s (`GET /api/health` exempt) |
  | Login | per IP / per identifier | 30/min / 20/hour |
  | OTP request | per identifier / per IP | 3/10min / 60/hour |
  | OTP verify | per identifier+IP | 10/10min |
  | Refresh | per token hash | 30/min |
  | Read APIs (GET) | per user id | 120/min |
  | Write APIs (POST/PATCH/DELETE) | per user id | 30/min |
  | Upload-URL endpoints | per user id | 10/min |

  Per-IP budgets are sized for ~1200 users sharing a campus NAT address and
  are env-tunable (`RL_EDGE_IP_PER_MIN`, `RL_LOGIN_IP_PER_MIN`,
  `RL_LOGIN_ID_PER_HOUR`, `RL_OTP_IP_PER_HOUR`, `RL_READ_PER_MIN`, …) so
  proxy topology changes need no code change. 429s carry `Retry-After` and a
  friendly message the portals render in their error states. In-memory store
  = per process (use Redis when scaling out); in production the edge layer
  belongs at the WAF/CDN. `RATE_LIMIT_OFF=true` disables limiting for local
  testing.
- **Read caching** (`src/common/cache/`) — tiny in-process TTL cache (60 s,
  write-invalidated) for the reads every user hits identically: subject and
  section lists, events aggregate, timetable slot rows (per section/faculty;
  session statuses stay live per request), and the admin student directory
  (`GET /api/admin/students/directory` — one call replacing the portals'
  page-walk over the paginated students list). Per process by design — swap
  for Redis together with the rate-limit store when scaling horizontally.

## Run

```bash
cp .env.example .env   # fill in values (never commit .env)
npm install
npm run migrate        # apply db/migrations/*.sql
npm run seed           # demo data mirroring the portal mock data
npm run dev            # build + start on :4000
npm run smoke          # 40-check API smoke suite (needs seed + server running)
```

Frontends: `../Student_portal` (`:5173`) and `../faculty_admin_portal` (`:5174`)
proxy `/api` to `http://localhost:4000` in dev.

## Demo accounts

| Role    | Identifier       | Email                       | Auth |
|---------|------------------|-----------------------------|------|
| Student | `STU-2025-001`   | balarakesh.g@university.edu | Password `Password@123` |
| Faculty | `FAC-2025-014`   | priya.sharma@westin.edu     | OTP only |
| Admin   | `ADM-2025-002`   | ananya.verma@westin.edu     | OTP only |

Seeded students use `Password@123`. OTP emails go to the real faculty/admin
address and the code is always printed in the API server console
(`OTP for … : 123456`).

## Notes

- `npm run dev` compiles with `tsc` first — required because tsx/esbuild does
  not emit the `design:paramtypes` metadata NestJS dependency injection needs.
  `npm run seed` / `npm run migrate` are DI-free and stay on tsx.
- See `SPEC.md` for the full endpoint/JSON-shape contract the portals rely on.
- Secrets in `.env` were shared during development — rotate the Supabase
  service key, DB password, and Gmail app password before production.
