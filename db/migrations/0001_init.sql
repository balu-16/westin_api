-- ============================================================
-- Westin College Portal — initial schema
-- One database shared by student / faculty / admin portals.
-- Access model: the NestJS API connects as `postgres` (bypasses
-- RLS). Every table below has RLS ENABLED with NO policies, so
-- the publicly-exposed Supabase REST/anon key can read nothing.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- enums ----------
do $$ begin
  create type user_role as enum ('student', 'faculty', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  create type attendance_status as enum ('present', 'absent', 'leave');
exception when duplicate_object then null; end $$;

do $$ begin
  create type event_category as enum ('CULTURAL', 'TECH TALK', 'SPORTS', 'WORKSHOP', 'SEMINAR');
exception when duplicate_object then null; end $$;

do $$ begin
  create type announcement_category as enum ('exam', 'event', 'general');
exception when duplicate_object then null; end $$;

do $$ begin
  create type file_type as enum ('pdf', 'docx', 'pptx', 'xlsx');
exception when duplicate_object then null; end $$;

do $$ begin
  create type user_status as enum ('active', 'inactive');
exception when duplicate_object then null; end $$;

-- ---------- identity ----------
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  role          user_role not null,
  email         text not null unique,
  password_hash text,                       -- null => OTP-only login (faculty/admin)
  display_name  text not null,
  phone         text,
  status        user_status not null default 'active',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists refresh_tokens (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_refresh_tokens_user on refresh_tokens(user_id);

create table if not exists otp_codes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  code_hash  text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  attempts   int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_otp_codes_user on otp_codes(user_id, created_at desc);

create table if not exists login_logs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  device     text,
  ip         text,
  created_at timestamptz not null default now()
);
create index if not exists idx_login_logs_user on login_logs(user_id, created_at desc);
create index if not exists idx_login_logs_created on login_logs(created_at desc);

-- ---------- academic structure ----------
create table if not exists faculty_profiles (
  user_id     uuid primary key references users(id) on delete cascade,
  faculty_id  text not null unique,          -- FAC-2025-xxx
  designation text,
  department  text,
  created_at  timestamptz not null default now()
);

create table if not exists sections (
  id              uuid primary key default gen_random_uuid(),
  label           text not null unique,      -- e.g. "CSE-A"
  department      text not null,
  year            int not null,
  class_teacher_id uuid references faculty_profiles(user_id) on delete set null,
  max_strength    int not null default 40,
  created_at      timestamptz not null default now()
);

create table if not exists subjects (
  id   uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique
);

create table if not exists faculty_subjects (
  faculty_id uuid not null references faculty_profiles(user_id) on delete cascade,
  subject_id uuid not null references subjects(id) on delete cascade,
  primary key (faculty_id, subject_id)
);

create table if not exists student_profiles (
  user_id    uuid primary key references users(id) on delete cascade,
  student_id text not null unique,           -- STU-2025-xxx
  section_id uuid references sections(id) on delete set null,
  year       int,
  department text,
  roll_no    text,
  created_at timestamptz not null default now(),
  unique (section_id, roll_no)
);

create table if not exists rooms (
  id   uuid primary key default gen_random_uuid(),
  name text not null unique
);

-- day: 0=Monday .. 5=Saturday
create table if not exists timetable_slots (
  id         uuid primary key default gen_random_uuid(),
  section_id uuid not null references sections(id) on delete cascade,
  day        int not null check (day between 0 and 5),
  start_time time not null,
  end_time   time not null check (end_time > start_time),
  subject_id uuid not null references subjects(id),
  faculty_id uuid not null references faculty_profiles(user_id),
  room_id    uuid not null references rooms(id),
  created_at timestamptz not null default now(),
  unique (section_id, day, start_time)
);
create index if not exists idx_slots_faculty on timetable_slots(faculty_id, day);
create index if not exists idx_slots_room on timetable_slots(room_id, day);
create index if not exists idx_slots_section on timetable_slots(section_id, day);

-- ---------- attendance ----------
create table if not exists attendance_sessions (
  id           uuid primary key default gen_random_uuid(),
  section_id   uuid not null references sections(id) on delete cascade,
  subject_id   uuid references subjects(id) on delete set null,
  session_date date not null,
  period       text not null,                -- h1..h6
  marked_by    uuid references users(id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (section_id, session_date, period)
);
create index if not exists idx_att_sessions_date on attendance_sessions(session_date desc);
create index if not exists idx_att_sessions_section on attendance_sessions(section_id, session_date desc);

create table if not exists attendance_records (
  session_id uuid not null references attendance_sessions(id) on delete cascade,
  student_id uuid not null references users(id) on delete cascade,
  status     attendance_status not null,
  marked_at  timestamptz not null default now(),
  primary key (session_id, student_id)
);
create index if not exists idx_att_records_student on attendance_records(student_id);

-- ---------- content ----------
create table if not exists study_files (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  subject_id   uuid references subjects(id) on delete set null,
  file_type    file_type not null,
  size_bytes   bigint not null default 0,
  storage_path text not null,                -- path inside `study-materials` bucket
  description  text,
  uploaded_by  uuid references users(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists idx_study_files_subject on study_files(subject_id);

create table if not exists events (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  category   event_category not null,
  start_date date not null,
  end_date   date,
  event_time text,
  location   text,
  is_live    boolean not null default false,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_events_start on events(start_date);

create table if not exists announcements (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  message    text not null,
  category   announcement_category not null default 'general',
  audience   text not null default 'all',    -- all | students | faculty
  created_at timestamptz not null default now()
);

create table if not exists daily_reports (
  id              uuid primary key default gen_random_uuid(),
  faculty_id      uuid not null references users(id) on delete cascade,
  section_id      uuid references sections(id) on delete set null,
  subject_id      uuid references subjects(id) on delete set null,
  report_date     date not null,
  topic           text not null,
  attachment_path text,                      -- path inside `report-attachments` bucket
  created_at      timestamptz not null default now()
);
create index if not exists idx_reports_faculty on daily_reports(faculty_id, report_date desc);
create index if not exists idx_reports_date on daily_reports(report_date desc);

create table if not exists user_settings (
  user_id       uuid primary key references users(id) on delete cascade,
  push          boolean not null default true,
  email         boolean not null default true,
  announcements boolean not null default true,
  reminders     boolean not null default true,
  theme         text not null default 'light',
  updated_at    timestamptz not null default now()
);

-- ---------- RLS lockdown: enabled everywhere, zero policies ----------
do $$
declare t text;
begin
  foreach t in array array[
    'users','refresh_tokens','otp_codes','login_logs','faculty_profiles','sections',
    'subjects','faculty_subjects','student_profiles','rooms','timetable_slots',
    'attendance_sessions','attendance_records','study_files','events','announcements',
    'daily_reports','user_settings'
  ] loop
    execute format('alter table if exists %I enable row level security', t);
  end loop;
end $$;
