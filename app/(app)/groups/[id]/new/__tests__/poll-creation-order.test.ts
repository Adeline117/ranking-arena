import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// The polls INSERT policy (20260413183345_fix_rls_initplan_auth_uid.sql) only
// admits a poll whose post_id is a post authored by the caller. Inserting the
// poll before its post (no post_id) is always rejected, which made every group
// poll fail with "createPollFailed".
const page = readFileSync(join(process.cwd(), 'app/(app)/groups/[id]/new/page.tsx'), 'utf8')

describe('group composer poll creation order', () => {
  it('creates the post before the poll', () => {
    const postInsert = page.indexOf(".from('posts')\n        .insert(")
    const pollInsert = page.indexOf(".from('polls')")
    expect(postInsert).toBeGreaterThan(-1)
    expect(pollInsert).toBeGreaterThan(postInsert)
  })

  it('binds the poll to the new post and links it back', () => {
    const pollBlock = page.slice(page.indexOf(".from('polls')"))
    expect(pollBlock).toMatch(/\.insert\(\{\s*post_id: postData\.id,/u)
    expect(pollBlock).toContain('.update({ poll_id: pollData.id })')
  })

  it('does not leave a poll post without its poll', () => {
    const pollBlock = page.slice(page.indexOf(".from('polls')"))
    expect(pollBlock).toContain(".from('posts').delete().eq('id', postData.id)")
  })
})
