import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(
  join(process.cwd(), 'app/(app)/settings/hooks/useSettingsHandlers.ts'),
  'utf8'
)

describe('profile save media rollback', () => {
  it('restores avatar/cover URL state (not only previews) when a save fails', () => {
    const helper = source.slice(source.indexOf('const revertMediaState = () => {'))
    const body = helper.slice(0, helper.indexOf('\n    }\n'))
    expect(body).toContain('setAvatarUrl(previousAvatarUrl)')
    expect(body).toContain('setCoverUrl(previousCoverUrl)')
  })

  it('uses the shared rollback on both the save-error and exception paths', () => {
    expect(source.match(/revertMediaState\(\)/g)?.length).toBe(2)
    expect(source).not.toContain('// Revert avatar/cover preview on')
  })
})
