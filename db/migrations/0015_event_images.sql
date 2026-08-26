-- ============================================================
-- 0015: Event images — poster + gallery / reference pics
-- Poster stored as events.poster_path (single primary image).
-- Additional images (pre-event references, last-year pics, post-event
-- gallery) stored in event_images. Bucket: event-images (10 MB).
-- ============================================================

alter table if exists events
  add column if not exists poster_path text;

create table if not exists event_images (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references events(id) on delete cascade,
  storage_path text not null,
  kind         text not null default 'gallery' check (kind in ('poster','gallery','reference')),
  uploaded_by  uuid references users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists idx_event_images_event on event_images(event_id, created_at desc);

alter table event_images enable row level security;

-- Back-compat: existing events have no images.
