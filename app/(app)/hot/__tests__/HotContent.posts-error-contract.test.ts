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
})
