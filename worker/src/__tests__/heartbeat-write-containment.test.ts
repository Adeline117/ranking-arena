import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(process.cwd(), 'worker/src/index.ts'), 'utf8')

function failedHandlerSource(): string {
  const start = source.indexOf("worker.on('failed'")
  const end = source.indexOf("worker.on('error'", start)
  return source.slice(start, end)
}

describe('legacy worker heartbeat write containment', () => {
  it('does not POST failed jobs to the V1-unpublished heartbeat ingress', () => {
    const failedHandler = failedHandlerSource()

    expect(failedHandler).toContain("worker.on('failed', (job, err) =>")
    expect(failedHandler).not.toContain('/api/health/heartbeat')
    expect(failedHandler).not.toMatch(/\bfetch\s*\(/)
    expect(failedHandler).not.toMatch(/\b(?:CRON_SECRET|SITE_URL)\b/)
  })
})
