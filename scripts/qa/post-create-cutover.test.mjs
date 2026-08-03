import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const CREATE_PAGES = ['app/(app)/u/[handle]/new/page.tsx', 'app/(app)/groups/[id]/new/page.tsx']
const DIRECT_POST_CREATE_ALLOWLIST = [
  'app/api/cron/auto-post-market-summary/route.ts',
  'app/api/cron/auto-post-weekly-recap/route.ts',
  'app/api/posts/[id]/repost/route.ts',
  // Legacy server helper: unused by production callers and closed to browser roles by postdeploy ACL.
  'lib/data/posts.ts',
]

const directTableReference = /\.from\s*\(\s*['"](?:posts|polls)['"]\s*\)/
const directPostCreate = /\.from\s*\(\s*['"]posts['"]\s*\)\s*\.(?:insert|upsert)\s*\(/
const directPollCreate = /\.from\s*\(\s*['"]polls['"]\s*\)\s*\.(?:insert|upsert)\s*\(/

function source(relativePath) {
  return readFileSync(join(ROOT, relativePath), 'utf8')
}

function productionTypeScriptFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') files.push(...productionTypeScriptFiles(absolutePath))
      continue
    }
    if (!/\.(?:ts|tsx)$/.test(entry.name) || /\.test\.(?:ts|tsx)$/.test(entry.name)) continue
    files.push(absolutePath)
  }
  return files
}

for (const pagePath of CREATE_PAGES) {
  test(`${pagePath} publishes only through the authenticated atomic authority`, () => {
    const page = source(pagePath)
    const submitStart = page.indexOf('const handleSubmit = async () => {')
    const submitEnd = page.indexOf('\n  return (', submitStart)
    assert.notEqual(submitStart, -1, 'submit handler is missing')
    assert.notEqual(submitEnd, -1, 'submit handler boundary is missing')

    const submit = page.slice(submitStart, submitEnd)
    assert.match(page, /from ['"]@\/lib\/posts\/post-create-client['"]/)
    assert.match(submit, /const capturedViewerScope = getViewerScope\(\)/)
    assert.match(submit, /capturedViewerScope\.userId !== userId/)
    assert.match(submit, /bindPostCreateOperation\([\s\S]*publishOperationRef\.current[\s\S]*\)/)
    assert.match(submit, /publishPostAtomic\(operation\.request, capturedViewerScope\)/)
    assert.match(submit, /result\.status === 'superseded'/)
    assert.match(submit, /result\.status === 'failed'/)
    assert.match(submit, /result\.status === 'invalid_ack'/)
    assert.doesNotMatch(page, directTableReference)
    assert.doesNotMatch(page, /\.rpc\s*\(\s*['"]create_post_atomic['"]/)

    const publishIndex = submit.indexOf('await publishPostAtomic(')
    assert.notEqual(publishIndex, -1, 'atomic publish call is missing')
    const successTail = submit.slice(publishIndex)
    assert.match(successTail, /publishOperationRef\.current = null/)
    assert.match(successTail, /clearDraft\(\)/)
    assert.match(successTail, /trackEvent\('create_post'/)
    assert.match(successTail, /showToast\(t\('publishSuccess'\), 'success'\)/)
  })
}

test('keeps direct post creation limited to the reviewed server-side inventory', () => {
  const files = [
    ...productionTypeScriptFiles(join(ROOT, 'app')),
    ...productionTypeScriptFiles(join(ROOT, 'lib')),
  ]
  const postCreateFiles = files
    .filter((file) => directPostCreate.test(readFileSync(file, 'utf8')))
    .map((file) => relative(ROOT, file))
    .sort()
  const pollCreateFiles = files
    .filter((file) => directPollCreate.test(readFileSync(file, 'utf8')))
    .map((file) => relative(ROOT, file))
    .sort()

  assert.deepEqual(postCreateFiles, [...DIRECT_POST_CREATE_ALLOWLIST].sort())
  assert.deepEqual(pollCreateFiles, [])
})
