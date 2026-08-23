-- ============================================================
-- 0013: System-generated notifications (auto triggers)
-- Announcements, events, absent-marking and the daily-report
-- reminder send pushes without an admin composing them:
--   - sender_admin_id becomes nullable (null = System)
--   - target_type gains a 'system' value (recipients are resolved
--     per trigger, not from the manual broadcast audience list)
--   - kind records which trigger produced the row
-- ============================================================

alter table notifications alter column sender_admin_id drop not null;

alter type notification_target add value if not exists 'system';

alter table notifications add column if not exists kind text;

-- Sender index already exists (0008); keep history scans cheap.
create index if not exists idx_notifications_kind on notifications(kind) where kind is not null;
