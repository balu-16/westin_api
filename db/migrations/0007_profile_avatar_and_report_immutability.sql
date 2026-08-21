-- ============================================================
-- 0007: Profile avatar + report immutability
-- * Adds users.avatar_path (private bucket `profile-avatars`)
-- * Makes daily_reports immutable via trigger (defense in depth)
-- * Protects historical reports from faculty deletion
-- * Prevents duplicate reports for same occurrence
-- ============================================================

-- ---------- profile avatar ----------
alter table users add column if not exists avatar_path text null;

-- ---------- daily_reports: immutability trigger ----------
create or replace function deny_daily_reports_mutation() returns trigger as $$
begin
  raise exception 'daily_reports are immutable: updates and deletes are not allowed' using errcode = 'P0001';
end;
$$ language plpgsql;

drop trigger if exists trg_deny_daily_reports_update on daily_reports;
create trigger trg_deny_daily_reports_update
  before update on daily_reports
  for each row execute function deny_daily_reports_mutation();

drop trigger if exists trg_deny_daily_reports_delete on daily_reports;
create trigger trg_deny_daily_reports_delete
  before delete on daily_reports
  for each row execute function deny_daily_reports_mutation();

-- ---------- protect historical reports: do not cascade on faculty delete ----------
-- Switch ON DELETE CASCADE -> RESTRICT so deleting a faculty with reports fails.
-- Deactivation should be via status='inactive', not hard delete.
alter table daily_reports drop constraint if exists daily_reports_faculty_id_fkey;
alter table daily_reports
  add constraint daily_reports_faculty_id_fkey
  foreign key (faculty_id) references users(id) on delete restrict;

-- ---------- prevent duplicate reports for same occurrence ----------
-- Assumes one report per faculty/section/subject/date. If schedule allows multiple
-- periods same day, include period column before applying this index.
create unique index if not exists uq_daily_reports_occurrence
  on daily_reports (faculty_id, section_id, subject_id, report_date);
