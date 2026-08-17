#!/usr/bin/env node
/**
 * End-to-end smoke test for westin-api. Requires the API running on :4000
 * and the seed applied. Usage: node scripts/smoke.mjs
 */
const BASE = process.env.API_URL ?? 'http://localhost:4000';
const PASSWORD = 'Password@123';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    failures.push(`${name} ${detail}`);
    console.log(`  FAIL ${name} ${detail}`);
  }
}

async function req(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
}

async function login(identifier) {
  const r = await req('POST', '/api/auth/login', { body: { identifier, password: PASSWORD } });
  if (r.status !== 200) throw new Error(`login failed for ${identifier}: ${JSON.stringify(r.json)}`);
  return r.json;
}

async function main() {
  console.log('== auth ==');
  const noTok = await req('GET', '/api/auth/me');
  ok('unauthenticated me -> 401', noTok.status === 401, `got ${noTok.status}`);

  const bad = await req('POST', '/api/auth/login', { body: { identifier: 'STU-2025-001', password: 'wrong' } });
  ok('bad password -> 401', bad.status === 401, `got ${bad.status}`);

  const stu = await login('STU-2025-001');
  ok('student login', !!stu.accessToken && stu.user?.role === 'student');
  const fac = await login('FAC-2025-014');
  ok('faculty login by id', fac.user?.role === 'faculty');
  const adm = await login('ADM-2025-002');
  ok('admin login by id', adm.user?.role === 'admin');

  const me = await req('GET', '/api/auth/me', { token: stu.accessToken });
  ok('me returns student payload', me.status === 200 && me.json?.studentId === 'STU-2025-001');

  const refreshed = await req('POST', '/api/auth/refresh', { body: { refreshToken: stu.refreshToken } });
  ok('refresh rotates', refreshed.status === 200 && refreshed.json?.accessToken);
  const reuse = await req('POST', '/api/auth/refresh', { body: { refreshToken: stu.refreshToken } });
  ok('old refresh token rejected', reuse.status === 401, `got ${reuse.status}`);

  const otpReq = await req('POST', '/api/auth/otp/request', { body: { identifier: 'FAC-2025-014' } });
  ok('otp request ok (or 30s throttle)', otpReq.status === 200 || (otpReq.status === 400 && /30s|wait/i.test(otpReq.json?.message ?? '')), `got ${otpReq.status} ${otpReq.json?.message}`);
  const otpBad = await req('POST', '/api/auth/otp/verify', { body: { identifier: 'FAC-2025-014', code: '000000' } });
  ok('otp wrong code rejected', otpBad.status === 401, `got ${otpBad.status}`);

  console.log('== role guards ==');
  const denied = await req('GET', '/api/admin/dashboard', { token: stu.accessToken });
  ok('student blocked from admin', denied.status === 403, `got ${denied.status}`);
  const denied2 = await req('GET', '/api/faculty/me/dashboard', { token: stu.accessToken });
  ok('student blocked from faculty', denied2.status === 403, `got ${denied2.status}`);

  console.log('== student endpoints ==');
  const dash = await req('GET', '/api/students/me/dashboard', { token: stu.accessToken });
  ok('student dashboard', dash.status === 200 && dash.json?.stats && Array.isArray(dash.json?.todaySessions), JSON.stringify(dash.json).slice(0, 120));
  ok('dashboard stats fields', ['classesToday', 'classesCompleted', 'overallAttendance', 'subjects', 'pendingAssignments'].every((k) => k in (dash.json?.stats ?? {})));

  const tt = await req('GET', '/api/timetable', { token: stu.accessToken });
  ok('student timetable week', tt.status === 200 && Array.isArray(tt.json) && tt.json.length === 6 && tt.json[0]?.sessions?.length >= 0);
  const session = tt.json?.[0]?.sessions?.[0];
  ok('timetable session shape', !session || ['subject', 'code', 'faculty', 'startTime', 'endTime', 'room', 'section', 'status'].every((k) => k in session));

  const att = await req('GET', '/api/attendance/my', { token: stu.accessToken });
  ok('student attendance page payload', att.status === 200 && att.json?.summary && Array.isArray(att.json?.subjects) && Array.isArray(att.json?.calendar) && att.json?.quickStats, JSON.stringify(att.json).slice(0, 120));

  const mats = await req('GET', '/api/materials', { token: stu.accessToken });
  ok('materials listing + signed urls', mats.status === 200 && mats.json?.files?.length > 0 && mats.json.files[0]?.downloadUrl?.includes('token='), JSON.stringify(mats.json).slice(0, 150));

  const evts = await req('GET', '/api/events', { token: stu.accessToken });
  ok('events payload', evts.status === 200 && evts.json?.upcoming?.length > 0 && Array.isArray(evts.json?.calendarMarks) && Array.isArray(evts.json?.categories));

  const anns = await req('GET', '/api/announcements', { token: stu.accessToken });
  ok('announcements for students', anns.status === 200 && Array.isArray(anns.json));

  const setPatch = await req('PATCH', '/api/students/me/settings', { token: stu.accessToken, body: { push: false, email: true, announcements: true, reminders: true, theme: 'light' } });
  ok('settings patch', setPatch.status === 200 && setPatch.json?.push === false);

  console.log('== faculty endpoints ==');
  const fdash = await req('GET', '/api/faculty/me/dashboard', { token: fac.accessToken });
  ok('faculty dashboard', fdash.status === 200 && fdash.json?.stats && Array.isArray(fdash.json?.todaySessions));

  const ftt = await req('GET', '/api/timetable/faculty/mine', { token: fac.accessToken });
  ok('faculty own timetable', ftt.status === 200 && Array.isArray(ftt.json) && ftt.json.length === 6);

  const fsec = await req('GET', '/api/faculty/me/sections', { token: fac.accessToken });
  ok('faculty sections', fsec.status === 200 && Array.isArray(fsec.json) && fsec.json.length > 0);
  const sectionId = fsec.json?.[0]?.id;

  const roster = await req('GET', `/api/faculty/sections/${sectionId}/students`, { token: fac.accessToken });
  ok('section roster', roster.status === 200 && roster.json?.length > 0 && roster.json[0]?.rollNo);

  const markDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const period = `smoke-${Date.now() % 1_000_000}`; // unique per run so totals grow
  // Mark in the DEMO STUDENT's own section so cross-portal totals are verifiable.
  const meRes = await req('GET', '/api/auth/me', { token: stu.accessToken });
  const demoSectionId = meRes.json?.sectionId;
  const rosterRes = await req('GET', `/api/attendance/roster?sectionId=${demoSectionId}&date=${markDate}&period=${period}`, { token: fac.accessToken });
  ok('attendance roster', rosterRes.status === 200 && Array.isArray(rosterRes.json?.students));
  const demoInRoster = rosterRes.json?.students?.find((s) => s.id === stu.user.id);
  const records = [
    { studentId: stu.user.id, status: 'absent' },
    ...(demoInRoster ? [] : []).slice(0, 4),
  ];
  const mark = await req('POST', '/api/attendance/mark', {
    token: fac.accessToken,
    body: { sectionId: demoSectionId, date: markDate, period, records },
  });
  ok('attendance mark', mark.status === 200 && mark.json?.counts, JSON.stringify(mark.json));

  const frep = await req('GET', '/api/reports/mine', { token: fac.accessToken });
  ok('faculty reports mine', frep.status === 200 && Array.isArray(frep.json));

  console.log('== admin endpoints ==');
  const adash = await req('GET', '/api/admin/dashboard', { token: adm.accessToken });
  ok('admin dashboard', adash.status === 200 && adash.json?.totals && Array.isArray(adash.json?.activityFeed));

  const teachers = await req('GET', '/api/admin/teachers', { token: adm.accessToken });
  ok('teachers list', teachers.status === 200 && teachers.json?.total >= 8 && Array.isArray(teachers.json?.rows), JSON.stringify(teachers.json).slice(0, 80));

  const sections = await req('GET', '/api/sections', { token: adm.accessToken });
  ok('sections list', sections.status === 200 && sections.json?.length === 6);

  const students = await req('GET', '/api/admin/students', { token: adm.accessToken });
  ok('admin students list', students.status === 200 && students.json?.total >= 240 && Array.isArray(students.json?.rows), JSON.stringify(students.json).slice(0, 80));
  ok('students pagination envelope', ['total', 'page', 'pageSize'].every((k) => k in (students.json ?? {})) && students.json?.rows?.length <= students.json?.pageSize);
  const studentsPaged = await req('GET', '/api/admin/students?page=2&pageSize=100', { token: adm.accessToken });
  ok('students page 2', studentsPaged.status === 200 && studentsPaged.json?.page === 2 && studentsPaged.json?.pageSize === 100 && studentsPaged.json?.rows?.length <= 100);

  const logs = await req('GET', '/api/admin/login-logs?role=teacher&limit=10', { token: adm.accessToken });
  ok('login logs', logs.status === 200 && Array.isArray(logs.json));

  const rooms = await req('GET', '/api/timetable/rooms', { token: adm.accessToken });
  ok('rooms list', rooms.status === 200 && rooms.json?.length >= 15);

  // timetable conflict check
  const slots = await req('GET', `/api/timetable/slots?sectionId=${sectionId}&day=1`, { token: adm.accessToken });
  ok('builder slots', slots.status === 200 && Array.isArray(slots.json));
  const existing = slots.json?.[0];
  if (existing) {
    const conflict = await req('POST', '/api/timetable/slots', {
      token: adm.accessToken,
      body: {
        sectionId, day: 1,
        startTime: existing.startTime, endTime: existing.endTime,
        subjectId: existing.subjectId, facultyId: existing.facultyId, roomId: existing.roomId,
      },
    });
    ok('timetable conflict -> 409', conflict.status === 409, `got ${conflict.status} ${JSON.stringify(conflict.json).slice(0, 100)}`);
  }

  const imp = await req('POST', '/api/timetable/import', {
    token: adm.accessToken,
    body: {
      mode: 'add',
      rows: [{ section: sections.json[0].label, day: 'Saturday', timeSlot: '16:00 - 16:50', subject: slots.json?.[0]?.subject ?? 'x', faculty: 'Nobody', room: rooms.json?.[0]?.name ?? 'x' }],
    },
  });
  ok('import rejects unknown faculty', imp.status === 400 || imp.json?.errors?.length > 0, `got ${imp.status}`);

  const arep = await req('GET', '/api/reports', { token: adm.accessToken });
  ok('admin reports list', arep.status === 200 && arep.json?.total >= 1 && Array.isArray(arep.json?.rows) && arep.json.rows.length <= arep.json.pageSize, JSON.stringify(arep.json).slice(0, 80));

  console.log('== cross-portal sync ==');
  const attAfter = await req('GET', '/api/attendance/my', { token: stu.accessToken });
  const markedStudent = records.find((r) => r.status === 'absent');
  ok('attendance totals grew after faculty marking', (attAfter.json?.summary?.total ?? 0) > (att.json?.summary?.total ?? 0), `before ${att.json?.summary?.total} after ${attAfter.json?.summary?.total}`);
  const calMark = (attAfter.json?.calendar ?? []).find((c) => c.date === markDate);
  ok('calendar reflects marked day', !calMark || calMark.status !== 'none', JSON.stringify(calMark));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('FAILURES:');
    failures.forEach((f) => console.log(` - ${f}`));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('smoke crashed:', e.message);
  process.exit(1);
});
