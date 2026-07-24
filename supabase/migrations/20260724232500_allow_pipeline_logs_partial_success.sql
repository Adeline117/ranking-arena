-- Keep the pipeline_logs status constraint aligned with PipelineLogger.
--
-- The application has emitted `partial_success` since 2026-03, while the
-- original table constraint only accepted running/success/error/timeout. A
-- rejected PostgREST update therefore left completed jobs in `running` until a
-- cleanup job mislabeled them as timeouts.

BEGIN;

SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '2min';

-- Install and validate the replacement before removing the old constraint.
-- NOT VALID keeps the initial lock short; it still protects all new writes.
ALTER TABLE public.pipeline_logs
  ADD CONSTRAINT pipeline_logs_status_check_v2
  CHECK (status IN ('running', 'success', 'partial_success', 'error', 'timeout'))
  NOT VALID;

ALTER TABLE public.pipeline_logs
  VALIDATE CONSTRAINT pipeline_logs_status_check_v2;

ALTER TABLE public.pipeline_logs
  DROP CONSTRAINT pipeline_logs_status_check;

ALTER TABLE public.pipeline_logs
  RENAME CONSTRAINT pipeline_logs_status_check_v2 TO pipeline_logs_status_check;

COMMIT;
