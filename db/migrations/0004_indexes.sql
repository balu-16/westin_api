-- ============================================================
-- 0004: Performance indexes
-- Plain (non-concurrent) creates so they run inside the
-- migrate.ts transaction.
-- ============================================================

-- Role scans (admin dashboards, role-guarded listings).
create index if not exists idx_users_role on users (role);

-- "newest first" listings / feeds.
create index if not exists idx_announcements_created_at on announcements (created_at desc);
create index if not exists idx_events_created_at on events (created_at);
create index if not exists idx_daily_reports_created_at on daily_reports (created_at);
create index if not exists idx_study_files_created_at on study_files (created_at);

-- Sargable login lookup: findUser() matches lower(email) / lower(portal id)
-- across the three profile tables.
create index if not exists idx_users_email_lower on users (lower(email));
create index if not exists idx_student_profiles_student_id_lower on student_profiles (lower(student_id));
create index if not exists idx_faculty_profiles_faculty_id_lower on faculty_profiles (lower(faculty_id));
create index if not exists idx_admin_profiles_admin_id_lower on admin_profiles (lower(admin_id));
