# westin-api — Implementation SPEC

One NestJS API + one Supabase Postgres DB serving 3 portals (student, faculty, admin).
**No ORM.** All SQL is hand-written, parameterized, via `DatabaseService`.

## Project facts
- Root: `/home/balarakeshg16/Documents/westin/westin-api`
- Run: `npm run dev` (tsx watch, port 4000). Typecheck: `npm run check`. Migrate: `npm run migrate`. Seed: `npm run seed`.
- Env already configured in `.env` (Supabase pooler DB, service key, SMTP). Do not print secrets.
- Frontends: `../Student_portal` (React 19 + Vite + Tailwind v4, dev :5173) and `../faculty_admin_portal` (:5174). Their `src/data/*` files are the **mock data whose shapes the API must match** and whose values the seed must mirror.

## Existing core (DO NOT rewrite; read these first)
- `src/config/env.ts` — env loader. `src/database/database.service.ts` — `query(sql, params)`, `queryOne`, `tx(fn)`.
- `src/common/guards/jwt-auth.guard.ts` (`AuthUser`), `roles.guard.ts`, `decorators/`: `@Roles(...roles)`, `@Public()`, `@CurrentUser()`.
- Guards are applied globally in `main.ts`. Controllers use full paths like `@Controller('api/...')`. Auth routes are `@Public()`.
- `src/modules/storage/storage.service.ts` — `signedUrl`, `signedUploadUrl`, `uploadObject`, `deleteObject`, `ensureBucket`; `BUCKETS.studyMaterials` / `BUCKETS.reportAttachments`. Global module.
- `src/modules/mail/mail.service.ts`, `src/modules/auth/*` — done (login, OTP request/verify, refresh rotation, logout, me, login_logs).
- `src/app.module.ts` already imports: SectionsModule, SubjectsModule, TimetableModule, AttendanceModule, EventsModule, MaterialsModule, AnnouncementsModule, ReportsModule, StudentsModule, FacultyModule, AdminModule — each at `src/modules/<name>/<name>.module.ts` (+ `.controller.ts`, `.service.ts`, optional `dto.ts`). **Create exactly these files/class names.**

## Conventions
- SQL via `this.db.query` / `this.db.queryOne` / `this.db.tx`. Never string-concatenate user input into SQL.
- Dates to clients: ISO strings (`date` columns → `YYYY-MM-DD`, timestamps → ISO 8601). Convert in SQL with `to_char` or in JS.
- Validation with `class-validator` DTOs; throw `BadRequestException`/`NotFoundException`/`ConflictException` (409 for timetable conflicts).
- Every service method returns plain JSON-serializable objects shaped exactly as specified below (camelCase).

## Database schema (already migrated — do not alter; ask via new migration file if truly needed)
Tables: `users(id,role,email,password_hash,display_name,phone,status,created_at)`, `faculty_profiles(user_id,faculty_id,designation,department)`, `admin_profiles(user_id,admin_id,title)`, `student_profiles(user_id,student_id,section_id,year,department,roll_no)`, `sections(id,label,department,year,class_teacher_id,max_strength)`, `subjects(id,name,code)`, `faculty_subjects(faculty_id,subject_id)`, `rooms(id,name)`, `timetable_slots(id,section_id,day 0=Mon..5=Sat,start_time,end_time,subject_id,faculty_id,room_id)` unique(section,day,start_time), `attendance_sessions(id,section_id,subject_id,session_date,period,marked_by)` unique(section,date,period), `attendance_records(session_id,student_id,status present|absent|leave)`, `study_files(id,name,subject_id,file_type pdf|docx|pptx|xlsx,size_bytes,storage_path,description,uploaded_by,created_at)`, `events(id,title,category CULTURAL|'TECH TALK'|SPORTS|WORKSHOP|SEMINAR,start_date,end_date,event_time,location,is_live,created_by)`, `announcements(id,title,message,category exam|event|general,audience all|students|faculty,created_at)`, `daily_reports(id,faculty_id,section_id,subject_id,report_date,topic,attachment_path,created_at)`, `user_settings(user_id,push,email,announcements,reminders,theme)`, `login_logs`, `refresh_tokens`, `otp_codes`.
Shared `ClassSession` JSON shape (used by timetable + dashboards): `{ id, subject, code, faculty, facultyId, startTime "09:00", endTime "09:50", room, section, sectionId, day (0-5), status: 'completed'|'in-progress'|'upcoming' }` — status computed vs `now()` in Asia/Kolkata (`now() at time zone 'Asia/Kolkata'`).

## Module assignments

### 1) `sections` + `subjects` modules
- `GET api/sections` (faculty|admin) → `[{ id, label, department, year, classTeacherId, classTeacherName, maxStrength, studentCount }]`
- `POST api/sections` (admin) `{label, department, year, classTeacherId?, maxStrength}`; `PATCH api/sections/:id`; `DELETE api/sections/:id` (409 if students exist, or reassign null — choose: block with 409 message "Move students first").
- `POST api/sections/:id/students/move` (admin) `{studentId}` → updates `student_profiles.section_id` + `roll_no` = section prefix + sequence.
- `GET api/subjects` (any role) → `[{id, name, code}]`; `POST/PATCH/DELETE api/subjects/:id` (admin).
- `GET api/timetable/rooms` (admin) → `[{id, name}]` — put in timetable module.

### 2) `timetable` module
- `GET api/timetable` (any role) → week for a section: students get own section automatically; `?sectionId=` for faculty/admin → `[{ day: 0..5, dayName, sessions: ClassSession[] }]` Mon–Sat (empty arrays allowed).
- `GET api/timetable/faculty/mine` (faculty) → same week shape, only slots where `faculty_id = me`.
- `GET api/timetable/slots?sectionId=&day=` (admin) → raw builder rows `[{id, day, startTime, endTime, subjectId, subject, code, facultyId, faculty, roomId, room}]`.
- `POST api/timetable/slots` (admin) `{sectionId, day, startTime "HH:MM", endTime, subjectId, facultyId, roomId}` → 409 with `message` listing conflicts: same room overlapping, same faculty overlapping, same section overlapping (compare `start < existing.end AND end > existing.start` on same day).
- `PUT api/timetable/slots/:id` (admin) — same checks excluding self. `DELETE api/timetable/slots/:id` (admin).
- `POST api/timetable/import` (admin) `{ rows: [{ section, day, timeSlot, subject, faculty, room }], mode: 'add'|'replace' }` — names as strings (from the frontend XLSX parser). Validate every row against DB entities (unknown → error listing the row), detect intra-file conflicts and vs-existing (in add mode), then in ONE tx: if replace → delete that section's slots first; insert all. Return `{ inserted, errors: [{row, message}] }` — if any error, insert nothing (400 with errors).
  - `timeSlot` strings look like `09:00 - 09:50` (frontend `canonicalPeriods`).
  - `day` may be `Monday`..`Saturday` or 0-5 — accept both.

### 3) `attendance` module
- `GET api/attendance/roster?sectionId=&date=&period=` (faculty) → `{ sessionExists, marks: { [studentId]: 'present'|'absent'|'leave' }, students: [{ id, studentId, rollNo, name }] }`.
- `POST api/attendance/mark` (faculty) `{ sectionId, date, period, subjectId?, records: [{ studentId, status }] }` → tx: upsert `attendance_sessions` (unique section/date/period), upsert all records; return `{ counts: { present, absent, leave } }`.
- `GET api/attendance/my?month=YYYY-MM` (student) → full page payload:
  `{ summary: { overall: 87, present: 261, total: 300 }, subjects: [{ id, code, subject, held, attended, percentage }], overview: [{ label: 'Present', value, color? not needed }], calendar: [{ date: '2026-08-01', status: 'present'|'absent'|'mixed'|'none' }], quickStats: { thisMonth, lastMonth, semesterAvg, required: 75 } }` (percentages rounded ints; calendar covers the requested month; mixed = some present some absent that day).

### 4) `events` module
- `GET api/events` (any role) → `{ featured: event|null (is_live first, else soonest upcoming; null if none), upcoming: [event...] (start_date >= today, sorted asc), calendarMarks: ['YYYY-MM-DD'...], categories: [{ category, count }] }`. Event JSON: `{ id, title, category, startDate, endDate|null, time, location, isLive, createdBy }`.
- `POST api/events` (faculty|admin), `PUT api/events/:id`, `DELETE api/events/:id` — same shape in/out. `endDate` optional; validate dates.

### 5) `materials` module (storage-backed)
- `GET api/materials?search=&subjectId=` (any role) → `{ files: [{ id, name, description, type: 'pdf'|'docx'|'pptx'|'xlsx', subject, subjectId, uploadedBy (display name), date (ISO), size (bytes), downloadUrl (signed 1h) }], folders: [{ id: subjectId, name: subject, fileCount }], stats: { totalFiles, totalSize, subjects: count } }`. Search filters name/description/subject (case-insensitive).
- `POST api/materials/upload-url` (faculty|admin) `{ name, contentType, sizeBytes }` → `{ path, url }` (path = `${Date.now()}-${slug(name)}`; client PUTs the file to `url`).
- `POST api/materials` (faculty|admin) `{ name, subjectId?, fileType, sizeBytes, storagePath, description? }` → created row (same shape as files[] entry).
- `PATCH api/materials/:id` (faculty|admin) `{ name?, subjectId?, description? }`; `DELETE api/materials/:id` → also `StorageService.deleteObject(BUCKETS.studyMaterials, storagePath)`.

### 6) `announcements` module
- `GET api/announcements` (any role; students see `audience in ('all','students')`, faculty/admin see all) → `[{ id, title, message, date (ISO), category }]` newest first.
- `POST/PATCH/DELETE api/announcements/:id` (admin).

### 7) `reports` module
- `GET api/reports/mine` (faculty) → own reports `[{ id, section, sectionId, subject, subjectId, date, topic, fileName, fileType, attachmentUrl (signed|null), submittedBy }]` newest first.
- `POST api/reports/upload-url` (faculty) `{ name, contentType, sizeBytes }` → `{ path, url }` (bucket `report-attachments`).
- `POST api/reports` (faculty) `{ sectionId, subjectId, reportDate, topic, attachmentPath? }`.
- `DELETE api/reports/:id` (faculty own, or admin).
- `GET api/reports?search=&sectionId=&from=&to=` (admin) → all reports (same shape as mine) with faculty names; search matches topic/faculty/section.

### 8) `students` module (student self endpoints)
- `GET api/students/me/dashboard` (student) → `{ stats: { classesToday, classesCompleted, overallAttendance (int %), subjects (distinct subjects in section timetable), pendingAssignments: 0 }, todaySessions: ClassSession[], subjectAttendance: [{ subject, code, attended, total, percentage }], announcements: [{ id, title, message, date, category }] }`.
- `GET api/students/me/settings` / `PATCH api/students/me/settings` (student) → `{ push, email, announcements, reminders, theme }` (upsert row on first save).

### 9) `faculty` module
- `GET api/faculty/me/dashboard` (faculty) → `{ stats: { classesToday, classesCompleted, sections (distinct sections taught), pendingReports (count), attendanceMarked (sessions marked today) }, pendingReports: [{ id, section, subject, date, topic }], todaySessions: ClassSession[], announcements: [...] }` (pendingReports = today's slots without an attendance_session yet, or reports due — use: slots today count minus sessions marked today; keep simple + list up to 5 upcoming slots lacking marks).
- `GET api/faculty/me/sections` (faculty) → `[{ id, label, department, year, studentCount, subjects: [names], isClassTeacher }]`.
- `GET api/faculty/sections/:id/students` (faculty) → `[{ id, studentId, rollNo, name, email }]` ordered by roll_no.

### 10) `admin` module
- `GET api/admin/dashboard` (admin) → `{ totals: { faculty, students, events, reportsToday }, activityFeed: [{ id, actor, action, target, time }] (latest ~8 from login_logs + daily_reports + events + created users), upcomingEvents: [event...] }`.
- Teachers CRUD: `GET api/admin/teachers` (admin) → `[{ id (user id), facultyId, name, email, designation, department, phone, subjects: [codes], status }]`; `POST api/admin/teachers` `{ name, email, facultyId?, designation, department, phone?, subjects?: [subjectId] }` (creates an OTP-only user role faculty + profile + faculty_subjects; facultyId auto `FAC-2025-<next seq>` if absent); `PATCH .../:id`; `DELETE .../:id` (set users.status='inactive' if referenced elsewhere, else hard delete — prefer hard delete, fall back to inactive with 409 only if truly blocked; simplest: hard delete, FKs use on delete set null/cascade).
- Students CRUD: `GET api/admin/students?sectionId=&search=` (admin) → `[{ id, studentId, name, email, section, sectionId, year, department, rollNo, attendance (int %), status }]`; `POST api/admin/students` `{ name, email, sectionId, year, department? }` (studentId auto `STU-2025-<seq>`, rollNo = next in section; password is set to the administrator-assigned default); `PATCH .../:id` (section move allowed); `DELETE .../:id`.
- `GET api/admin/students/directory` (admin) → same row shape as the students list, unpaginated, every student in one call (attendance computed via a single grouped aggregate). Powers the portal's section rosters/move dropdowns — do not page-walk `/api/admin/students` for this.
- `GET api/admin/login-logs?role=teacher|student&limit=10` (admin) → `[{ id, name, identifier (STU-/FAC- id), device, ip, time }]` newest first.

## Seed (`scripts/seed.ts`) — separate agent
Mirrors mock data; reads the frontend mock files for exact values:
`../Student_portal/src/data/mockData.ts`, `attendanceData.ts`, `studyMaterialsData.ts`; `../faculty_admin_portal/src/data/sharedData.ts`, `facultyData.ts`, `adminData.ts`, `adminTimetableData.ts`.
- Demo student uses password `Password@123` (scrypt via `src/common/util/crypto` `hashPassword`); faculty Dr. Priya Sharma FAC-2025-014 and admin Ananya Verma ADM-2025-002 use OTP only, as do the other 7 teachers.
- 6 sections (labels/roll prefixes from `sharedData.sections`), 8 subjects (`sharedData.subjects`), 15 rooms (`adminTimetableData.rooms`), `faculty_subjects` from `subjectFaculty` map, class teachers assigned.
- 40 students/section = 240 (`sharedData.studentsForSection` names/rolls), emails `fname.lname<n>@student.westin.edu` unique, studentId STU-2025-### unique.
- Timetable: periods `h1..h6` times from `sharedData.periods`; 4-6 slots per section per day Mon-Sat rotating subjects/faculty per `subjectFaculty`; NO conflicts (check before insert). Demo student must be in section CSE-A (or the section used by `mockData.weeklyTimetable` subjects).
- Attendance: last 60 days (skip Sundays), 2-3 sessions/section/day using that day's slots' subject+faculty; every student marked ~87% present / 8% absent / 5% leave (deterministic pseudo-random via seeded function or (i*7+j)%23 style math — NO Math.random so re-runs are stable). Demo student ≈87%.
- Events: 6 from `eventsPool`/`studyMaterialsData`/`currentEvent` with dates SHIFTED relative to today (featured/live event = today+1, others spread over next 6 weeks) so dashboards always show upcoming.
- Announcements 3 (from mock lists), `study_files` 8 mirroring `studyFiles` mock (upload real small bytes to `study-materials` bucket via StorageService.uploadObject — tiny valid PDF for pdf, plain text bytes for docx/pptx/xlsx; `uploaded_by` = matching faculty user), `daily_reports` = 5 from `facultyReports` + 5 more recent for admin view (dates within last 7 days incl. today), `login_logs` ~10 teacher + ~10 student rows mirroring the mock logs, `user_settings` default rows for demo users.
- Idempotent: TRUNCATE all data tables (in FK-safe order; `truncate ... restart identity cascade`) then insert. Prints a credentials summary table at the end. Wrap whole thing in one tx where practical.

## Testing requirements (each module agent)
- `npm run check` must pass with zero TS errors.
- Start server (`npm run start` in background), curl your endpoints with real tokens (student login uses `Password@123`; faculty/admin use an emailed OTP — seed may not have run yet; if login fails because DB is empty, coordinate: seed agent runs first; verify with `curl` once seed done, or test after seeding). Ensure JSON shapes match this SPEC exactly (field names, camelCase).
- Do NOT modify files outside your module (shared files only if compilation requires an export).
