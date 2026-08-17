-- ============================================================
-- Auth follow-up
--  * Students keep the password assigned by the administrator at creation.
--  * Faculty and admin accounts remain OTP-only.
--  * Remove the unused student email-enrollment flow introduced in 0005.
-- ============================================================

update users
   set password_hash = null
 where role in ('faculty', 'admin');

drop table if exists enrollment_tokens;
alter table users drop column if exists must_set_password;
