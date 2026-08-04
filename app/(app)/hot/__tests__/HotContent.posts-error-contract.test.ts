import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const content = readFileSync(join(process.cwd(), 'app/(app)/hot/HotContent.tsx'), 'utf8')

describe('HotContent post error contract', () => {
  it('shows retryable load failures without falling through to no-data', () => {
    expect(content).toContain('role="alert"')
    expect(content).toContain("t('loadHotPostsFailed')")
    expect(content).toContain('onClick={() => void refreshPosts()}')
    expect(content).toContain('!postsError &&')
  })

  it('refreshes posts in place instead of reloading the entire page', () => {
    expect(content).toContain('<PullToRefreshWrapper onRefresh={refreshPosts}>')
    expect(content).not.toContain('window.location.reload()')
  })

  it('wires group failures to an explicit retry instead of a false empty state', () => {
    expect(content).toContain('error={groupsError !== null}')
    expect(content).toContain('onRetry={() => void refreshGroups()}')
  })

  it('keeps primary hot tabs and retries at the shared touch-target size', () => {
    expect(content).toContain('minHeight: tokens.touchTarget.min')
    expect(content).not.toContain('minHeight: 32')
  })
})
