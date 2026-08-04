import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const hook = readFileSync(
  resolve(process.cwd(), 'app/(app)/groups/[id]/hooks/useGroupPosts.ts'),
  'utf8'
)

describe('group inline post editor atomic contract', () => {
  it('hydrates the exact revision needed by the mutation', () => {
    expect(hook).toContain('updated_at, content_version')
    expect(hook).toContain('content_version: number')
    expect(hook).toContain('expected_version: currentPost.content_version')
  })

  it('single-flights one post and trusts only the exact database acknowledgement', () => {
    expect(hook).toContain('editRequestLockRef.current.has(requestLockKey)')
    expect(hook).toContain('readPostEditApiAcknowledgement(result.data, postId)')
    expect(hook).toContain('acknowledgement.author_id === context.scope.userId')
    expect(hook).toContain('acknowledgement.group_id === context.groupId')
    expect(hook).toContain('title: acknowledgement.title')
    expect(hook).toContain('language: acknowledgement.language')
    expect(hook).toContain('mentions: acknowledgement.mentions')
    expect(hook).toContain('hashtags: acknowledgement.hashtags')
    expect(hook).not.toMatch(/result\.ok\)[\s\S]{0,400}title: submittedTitle/)
  })

  it('does not remove a post from the group UI on a malformed 2xx delete response', () => {
    expect(hook).toContain('deleteRequestLockRef.current.has(requestLockKey)')
    expect(hook).toContain('result.ok && readPostDeleteAcknowledgement(result.data)')
    expect(hook).toContain('readPostDeleteError(result.data)')
  })
})
