/**
 * Score jobs must drain serially.
 *
 * Normal schedules are staggered, but an offline worker leaves one overdue
 * iteration per season in Redis. Starting with concurrency >1 collapses that
 * backlog into parallel compute-leaderboard calls, recreating the database
 * pool saturation that the single-season compute path was designed to avoid.
 */
export const PIPELINE_WORKER_CONCURRENCY = 1
