/**
 * Compatibility export for the retired cache warmer module.
 *
 * The former implementation wrote unversioned, unfenced partial rows. Keep
 * this path for repository scanners and any rolling-deploy import, but route
 * every caller to the publication-fenced full-response warmer.
 */
export { warmupLeaderboardCache } from './post-processing'
