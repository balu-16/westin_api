-- ============================================================
-- 0008: OneSignal web push notifications (Admin → Faculty/Admin)
-- Site: https://westin-faculty.vercel.app (shared faculty+admin deployment)
-- Student portal is out-of-scope; no student recipients.
-- External IDs: faculty_<users.id>, admin_<users.id> via getOneSignalExternalId()
-- ============================================================

-- enums
do $$ begin
  create type notification_target as enum ('all_faculty', 'selected_faculty', 'admins');
exception when duplicate_object then null; end $$;

do $$ begin
  create type recipient_type as enum ('faculty', 'admin');
exception when duplicate_object then null; end $$;

-- one row per send (audit)
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  sender_admin_id uuid not null references users(id) on delete cascade,
  message_title text not null,
  message_body text not null,
  target_type notification_target not null,
  created_at timestamptz not null default now(),
  onesignal_notification_id text
);
create index if not exists idx_notifications_created on notifications(created_at desc);
create index if not exists idx_notifications_sender on notifications(sender_admin_id);

-- one row per resolved recipient (permanent audit)
create table if not exists notification_recipients (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references notifications(id) on delete cascade,
  recipient_type recipient_type not null,
  recipient_id uuid not null references users(id) on delete cascade,
  delivered boolean,
  created_at timestamptz not null default now()
);
create index if not exists idx_notification_recipients_notification on notification_recipients(notification_id);
create index if not exists idx_notification_recipients_recipient on notification_recipients(recipient_id);

-- per-admin opt-in for admin broadcasts
create table if not exists admin_notification_settings (
  admin_id uuid primary key references users(id) on delete cascade,
  receive_from_other_admins boolean not null default false,
  updated_at timestamptz not null default now()
);

-- same lockdown as 0001_init: RLS enabled, no policies (API uses postgres role)
alter table if exists notifications enable row level security;
alter table if exists notification_recipients enable row level security;
alter table if exists admin_notification_settings enable row level security;
