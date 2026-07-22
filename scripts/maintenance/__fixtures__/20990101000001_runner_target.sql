BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;

LOCK TABLE runner_harness.effects IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO runner_harness.effects (scenario)
VALUES (
  COALESCE(
    NULLIF(current_setting('arena.runner_scenario', true), ''),
    'default'
  )
);

SELECT pg_catalog.pg_sleep(
  COALESCE(
    NULLIF(current_setting('arena.runner_sleep_seconds', true), '')::double precision,
    0
  )
);

DO $runner_fixture_body$
BEGIN
  IF current_setting('arena.runner_fail', true) = 'on' THEN
    RAISE EXCEPTION 'runner fixture mid-body failure';
  END IF;
END
$runner_fixture_body$;

COMMIT;
