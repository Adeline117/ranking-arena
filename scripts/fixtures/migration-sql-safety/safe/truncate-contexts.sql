REVOKE TRUNCATE ON TABLE arena.accounts FROM app_user;

CREATE TRIGGER audit_accounts_truncate
BEFORE TRUNCATE ON arena.accounts
FOR EACH STATEMENT EXECUTE FUNCTION arena.audit_accounts_truncate();

CREATE OR REPLACE FUNCTION arena.audit_accounts_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
  -- TRUNCATE TABLE arena.comment_only_example;
  IF TG_OP = 'TRUNCATE' THEN
    RETURN NULL;
  END IF;
  RETURN NULL;
END
$body$;

SELECT ARRAY['SELECT', 'INSERT', 'TRUNCATE']::text[] AS allowed_permissions;
SELECT truncate_marker, last_truncate, truncateCount FROM arena.diagnostics;
