-- Admin profile table, consistent with faculty/student profiles.
create table if not exists admin_profiles (
  user_id    uuid primary key references users(id) on delete cascade,
  admin_id   text not null unique,          -- ADM-2025-xxx
  title      text,                          -- e.g. "Super Admin"
  created_at timestamptz not null default now()
);

alter table if exists admin_profiles enable row level security;
