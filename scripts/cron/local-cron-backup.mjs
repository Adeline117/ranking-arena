#!/usr/bin/env node

/**
 * Retired launchd target kept only so already-installed jobs fail visibly.
 *
 * This file never created an R2/database backup. Its refresh endpoints and
 * refresh-all fallback have also been removed, so continuing with a zero exit
 * code would falsely attest both backup and data freshness.
 */

console.error(
  '[local-cron-backup] RETIRED: this job creates no backup and its refresh routes no longer exist. ' +
    'Run scripts/cron/setup-local-cron.sh uninstall, then use the reviewed ingest scheduler for data ' +
    'and BACKUP_SCHEMAS=arena,public npm run backup:r2 for an application-data capture.'
)
process.exitCode = 2
