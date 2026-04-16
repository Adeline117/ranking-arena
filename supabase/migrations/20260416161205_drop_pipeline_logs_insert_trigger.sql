-- Drop the AFTER-INSERT cleanup trigger on pipeline_logs
-- Root cause: every cron job insert (62 jobs x many inserts/hour) triggered a
-- full DELETE scan. This was the #1 write amplification source during cron storms.
-- Cleanup is already handled by cleanup_stale_data() invoked daily via cleanup-data cron.

DROP TRIGGER IF EXISTS trg_cleanup_pipeline_logs ON pipeline_logs;
DROP FUNCTION IF EXISTS cleanup_old_pipeline_logs();
