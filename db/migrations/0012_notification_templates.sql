-- ============================================================
-- 0012: Predefined notification templates for the admin Send page
-- Admins send many of the same messages repeatedly (holidays,
-- fee reminders, staff meets) — store them once, load with a picker.
-- target_type is an optional default recipient type (null = ask).
-- ============================================================

create table if not exists notification_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  title text not null,
  message text not null,
  target_type notification_target,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_notification_templates_created on notification_templates(created_at desc);

-- same lockdown as 0001_init: RLS enabled, no policies (API uses postgres role)
alter table if exists notification_templates enable row level security;

-- Seeded defaults. Fixed UUIDs + on-conflict keep re-runs idempotent.
insert into notification_templates (id, name, title, message, target_type) values
  ('11111111-1111-4111-8111-111111111101', 'Holiday Tomorrow', 'Holiday Tomorrow',
   'College will remain closed tomorrow for all students and faculty. Regular classes resume the following working day.',
   'all_students'),
  ('11111111-1111-4111-8111-111111111102', 'Exam Schedule Posted', 'Exam Schedule Published',
   'The exam timetable is now available on the portal. Please check the academics section for your dates, timings and venues.',
   'all_students'),
  ('11111111-1111-4111-8111-111111111103', 'Fee Payment Reminder', 'Fee Payment Reminder',
   'This is a reminder to complete your semester fee payment before the due date to avoid late fines.',
   'all_students'),
  ('11111111-1111-4111-8111-111111111104', 'Staff Meeting', 'Staff Meeting Today',
   'All faculty are requested to attend the staff meeting today at 3:00 PM in the conference hall. Attendance is mandatory.',
   'all_faculty'),
  ('11111111-1111-4111-8111-111111111105', 'Daily Report Reminder', 'Daily Report Reminder',
   'Reminder: please submit today''s daily reports on the portal before midnight.',
   'all_faculty'),
  ('11111111-1111-4111-8111-111111111106', 'Uniform Reminder', 'Uniform Reminder',
   'Students are reminded to report to college in complete prescribed uniform from tomorrow. Strict action will be taken against violations.',
   'all_students'),
  ('11111111-1111-4111-8111-111111111107', 'Cultural Event', 'Cultural Event This Week',
   'Our annual cultural event is here! Check the Events page for the schedule and venue. All students are encouraged to participate.',
   'all_students'),
  ('11111111-1111-4111-8111-111111111108', 'General Circular', 'College Circular',
   'A new circular has been published. Please check the announcements section on the portal for full details.',
   null)
on conflict (id) do nothing;
