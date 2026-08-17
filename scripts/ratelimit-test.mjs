#!/usr/bin/env node
/**
 * Layered rate-limit verification. Run with the API on :4000 (RATE_LIMIT_OFF
 * must not be set). Note: this intentionally exhausts the per-IP login
 * budget for a minute — run the normal smoke suite BEFORE this script.
 * Defaults asserted here mirror rate-limit.guard.ts (login-ip 30/min,
 * otp-req-id 3/10min, read-user 120/min); export the RL_* overrides in
 * .env and adjust if you tune them.
 */
const BASE = process.env.API_URL ?? 'http://localhost:4000';
let passed = 0, failed = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; failures.push(name); console.log(`  FAIL ${name} ${detail}`); }
};

async function req(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json, retryAfter: res.headers.get('retry-after') };
}

async function main() {
  console.log('== health exempt from edge limits ==');
  let healthOk = 0;
  for (let i = 0; i < 70; i++) {
    const r = await req('GET', '/api/health');
    if (r.status === 200) healthOk++;
  }
  ok('health 70x rapid requests all 200', healthOk === 70, `${healthOk}/70`);

  console.log('== login: 20/h per identifier, 30/min per IP ==');
  // Unknown identifiers still 401 (user not found) but count identically in
  // the guard, so per-run unique probes never touch real demo accounts'
  // hourly budgets (smoke logs in as STU-2025-001/FAC-2025-014 repeatedly).
  const probe = `rl-probe-${Date.now()}`;
  const codes = [];
  const rules = [];
  for (let i = 0; i < 21; i++) {
    const r = await req('POST', '/api/auth/login', { body: { identifier: probe, password: 'wrong' } });
    codes.push(r.status);
    rules.push(r.json?.rule ?? '');
  }
  const idDenied = codes.indexOf(429);
  ok(
    '21st login attempt for one identifier is 429 (login-id)',
    idDenied === 20 && rules[20] === 'login-id',
    `first 429 at #${idDenied + 1}, rule=${rules[idDenied] ?? ''}, tail=${codes.slice(18).join(',')}`,
  );

  // 20 of the probe attempts counted toward the shared per-IP budget (denied
  // requests never increment). Ten more fresh identifiers bring it to 30;
  // the 11th extra is the 31st counted attempt from this IP.
  let ipRule = '';
  let ipDeniedAt = -1;
  const ipCodes = [];
  for (let i = 0; i < 11; i++) {
    const r = await req('POST', '/api/auth/login', { body: { identifier: `${probe}-ip${i}`, password: 'wrong' } });
    ipCodes.push(r.status);
    if (r.status === 429) { ipDeniedAt = i; ipRule = r.json?.rule ?? ''; break; }
  }
  ok(
    '31st counted login attempt from one IP is 429 (login-ip)',
    ipDeniedAt === 10 && ipRule === 'login-ip',
    `at extra #${ipDeniedAt + 1}, rule=${ipRule}, codes=${ipCodes.join(',')}`,
  );

  const limited = await req('POST', '/api/auth/login', { body: { identifier: 'STU-2025-001', password: 'Password@123' } });
  ok('even correct creds are limited (429)', limited.status === 429, `got ${limited.status}`);
  ok('429 carries friendly message', /Too many requests/i.test(limited.json?.message ?? ''), JSON.stringify(limited.json).slice(0, 120));
  ok('Retry-After header present', !!limited.retryAfter, `retry-after=${limited.retryAfter}`);

  console.log('== login budget is per identifier (20/h) — different id not blocked by id rule ==');
  // NOTE: the per-IP 30/min budget is consumed above, so a second identifier
  // also 429s via the IP rule — that is the intended layered behaviour.
  const other = await req('POST', '/api/auth/login', { body: { identifier: 'FAC-2025-014', password: 'x' } });
  ok('stricter IP rule applies across identifiers', other.status === 429, `got ${other.status}`);

  console.log('== OTP request: 3 per 10 min per identifier ==');
  const otpCodes = [];
  for (let i = 0; i < 5; i++) {
    const r = await req('POST', '/api/auth/otp/request', { body: { identifier: 'ADM-2025-002' } });
    otpCodes.push(r.status);
  }
  const firstThrottle = otpCodes.indexOf(400); // 30s resend throttle → 400
  const otpDenied = otpCodes.indexOf(429);
  ok('OTP request eventually rate limited', otpDenied >= 0, `codes=${otpCodes.join(',')}`);

  console.log('== read APIs: 120/min per user ==');
  // Wait out the login window so we can obtain a token. Fresh identifier —
  // STU-2025-001's 20/h login-id budget was burned above.
  console.log('  waiting 62s for the per-IP login window to reset…');
  await new Promise((r) => setTimeout(r, 62_000));
  const login = await req('POST', '/api/auth/login', { body: { identifier: 'STU-2025-002', password: 'Password@123' } });
  ok('login works again after window', login.status === 200, `got ${login.status}`);
  if (login.status !== 200) { finish(); return; }
  const token = login.json.accessToken;
  let read429At = -1;
  let readRule = '';
  for (let i = 0; i < 125; i++) {
    const r = await req('GET', '/api/announcements', { token });
    if (r.status === 429) { read429At = i; readRule = r.json?.rule ?? ''; break; }
  }
  // Rapid-fire: the edge burst rule (60/10s) legitimately trips before the
  // per-user read limit (120/min) — both are correct layered outcomes. The
  // exact index shifts a little depending on what else shares the window.
  ok('reads limited under rapid fire (burst or per-user rule)',
    read429At >= 0 && (readRule === 'edge-ip-burst' ? read429At >= 55 : read429At >= 118),
    `429 at request #${read429At + 1}, rule=${readRule}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) { failures.forEach((f) => console.log(` - ${f}`)); process.exit(1); }
}
function finish() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('crashed:', e.message); process.exit(1); });
