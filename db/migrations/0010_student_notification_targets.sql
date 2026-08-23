-- ============================================================
-- 0010: Student notification targets (Admin → Students)
-- Students subscribe from https://westin-student.vercel.app —
-- a separate OneSignal app (browser same-origin policy forbids
-- one app per two origins). External IDs: student_<users.id>.
-- ============================================================

alter type notification_target add value if not exists 'all_students';
alter type notification_target add value if not exists 'selected_students';

alter type recipient_type add value if not exists 'student';
