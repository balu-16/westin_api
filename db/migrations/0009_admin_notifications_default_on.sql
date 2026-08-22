-- ============================================================
-- 0009: Admin notifications default ON (opt-out instead of opt-in)
-- admin_notification_settings.receive_from_other_admins now defaults
-- to true, so every active admin receives admin-targeted notifications
-- unless they explicitly opt out in Admin Settings. Existing rows are
-- brought to the new default (feature had not shipped, no real opt-outs
-- to preserve). Admins without a settings row are covered by the
-- backend query's coalesce(..., true).
-- ============================================================

alter table admin_notification_settings
  alter column receive_from_other_admins set default true;

update admin_notification_settings
   set receive_from_other_admins = true,
       updated_at = now()
 where receive_from_other_admins = false;
