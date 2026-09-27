-- 0002_server_sets_roles.sql
-- Roles are decided on the server (office sign-up, invite redemption) using the
-- service role key. Users may no longer create their profile row or change
-- their own role through the API; they can still edit their display name.

revoke insert, update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;
