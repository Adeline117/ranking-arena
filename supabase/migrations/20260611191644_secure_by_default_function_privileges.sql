-- Migration: 20260611191644_secure_by_default_function_privileges.sql
-- Created: 2026-06-12T02:16:44Z
-- Description: ROOT FIX for the recurring "admin function publicly
--   executable" class (16 instances revoked in the previous migration).
--   PostgreSQL grants EXECUTE to PUBLIC on new functions BY DEFAULT, so
--   every future SECURITY DEFINER helper would silently become an anon
--   /rpc endpoint again. Flip the default: functions created from now on
--   are private until explicitly granted.
--
--   ⚠ NEW CONVENTION (update your mental model when writing migrations):
--   a function meant to be called from the browser now needs an explicit
--     GRANT EXECUTE ON FUNCTION public.my_rpc(args) TO anon, authenticated;
--   Existing functions keep their current grants — this only changes the
--   default for FUTURE objects created by the migration role.

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA arena
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA arena
  REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated;
