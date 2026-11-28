/**
 * Log sink for a rank publication job.
 *
 * publishLeaderboardSeason reports its stage timings
 * ("[7D] stage=read|score|write|cleanup|rerank|seal rows=… ms=…") and alert
 * text through `deps.log`. The worker used to pass only `job.log`, which BullMQ
 * keeps in Redis next to the job; nothing reached the process stdout that the
 * release owner reads (pm2 logs), so the stage lines were never seen there.
 *
 * This sink writes every line to both: the job log (unchanged) and stdout,
 * prefixed so the lines can be grepped.
 */
export const RANK_PUBLICATION_STDOUT_PREFIX = '[rank-publication]'

export function rankPublicationLogSink(
  jobLog: (message: string) => unknown,
  stdout: (line: string) => void = (line) => console.log(line)
): (message: string) => void {
  return (message) => {
    void jobLog(message)
    stdout(`${RANK_PUBLICATION_STDOUT_PREFIX} ${message}`)
  }
}
