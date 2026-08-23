-- ============================================================
-- 0011: In-app notification inbox — per-recipient read state
-- GET /api/notifications/my lists notifications addressed to the
-- logged-in user (any role); read_at marks them seen in-app.
-- ============================================================

alter table notification_recipients add column if not exists read_at timestamptz;

create index if not exists idx_notifrecipients_recipient
  on notification_recipients (recipient_id);
