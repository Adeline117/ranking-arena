import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('claimed-profile server history quarantine', () => {
  it('sanitizes enveloped and unwrapped API data before passing initialData to the client', () => {
    const source = readFileSync(join(process.cwd(), 'app/(app)/u/[handle]/page.tsx'), 'utf8')
    const fetcher = source.slice(
      source.indexOf('async function fetchTraderData'),
      source.indexOf('/**\n * M1 unified profile')
    )

    expect(fetcher.match(/return quarantineLegacyPositionHistory\(/g)).toHaveLength(2)
    expect(fetcher).not.toContain('return json.data\n')
    expect(fetcher).not.toContain('return json\n')
  })
})
