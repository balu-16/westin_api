-- ============================================================
-- Auth security overhaul
--  * Faculty/admin accounts become OTP-only: their password
--    hashes are cleared and password login is rejected.
--
-- Student passwords are assigned by the administrator, so there is no
-- student email-enrollment flow. The follow-up 0006 migration also removes
-- the enrollment objects for databases where an earlier version of 0005 ran.
-- ============================================================

-- Existing faculty/admin: password login is removed outright.
update users set password_hash = null
 where role in ('faculty', 'admin') and password_hash is not null;
