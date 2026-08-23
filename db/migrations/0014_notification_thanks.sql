-- ============================================================
-- 0014: Subscription thank-you idempotency
-- The welcome push ("Thanks for subscribing") is fired by the
-- frontend from several concurrent triggers (subscription change
-- event, identify retry, banner enable) and from multiple tabs.
-- The unique row below makes "sent once per user" DB-enforced —
-- a second POST /notifications/thanks for the same user is a no-op.
-- ============================================================

create table if not exists notification_thanks (
  user_id uuid primary key references users(id) on delete cascade,
  sent_at timestamptz not null default now()
);

alter table notification_thanks enable row level security;
