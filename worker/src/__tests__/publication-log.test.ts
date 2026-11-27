import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { RANK_PUBLICATION_STDOUT_PREFIX, rankPublicationLogSink } from '../publication-log'

describe('rankPublicationLogSink', () => {
  it('writes each line to the job log unchanged and to stdout with a prefix', () => {
    const jobLines: string[] = []
    const stdoutLines: string[] = []
    const log = rankPublicationLogSink(
      (message) => jobLines.push(message),
      (line) => stdoutLines.push(line)
    )

    log('[7D] stage=rerank rows=8759 ms=1234')

    expect(jobLines).toEqual(['[7D] stage=rerank rows=8759 ms=1234'])
    expect(stdoutLines).toEqual([
      `${RANK_PUBLICATION_STDOUT_PREFIX} [7D] stage=rerank rows=8759 ms=1234`,
    ])
  })

  it('is what the worker passes to publishLeaderboardSeason', () => {
    const source = readFileSync(join(process.cwd(), 'worker/src/index.ts'), 'utf8')
    const call = source.slice(source.indexOf('publishLeaderboardSeason(season, {'))
    const deps = call.slice(0, call.indexOf('})'))
    expect(deps).toContain('log: rankPublicationLogSink((message) => job.log(message))')
  })
})
