import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')
const workflow = fs.readFileSync(path.join(root, '.github/workflows/lighthouse-ci.yml'), 'utf8')

test('Lighthouse builds pull requests without production credentials', () => {
  assert.match(workflow, /NEXT_PUBLIC_SUPABASE_URL: https:\/\/placeholder\.supabase\.co/)
  assert.match(workflow, /SUPABASE_SERVICE_ROLE_KEY: lighthouse-build-service-placeholder/)
  assert.doesNotMatch(workflow, /secrets\.(?:NEXT_PUBLIC_)?SUPABASE/)
})

test('Lighthouse allocates the validated production-build heap', () => {
  assert.match(
    workflow,
    /- name: Build\n\s+run: npm run build\n\s+env:\n[\s\S]*?NODE_OPTIONS: --max-old-space-size=4096/
  )
})

test('Lighthouse result parsing does not shadow github-script globals', () => {
  assert.doesNotMatch(workflow, /\b(?:const|let|var) glob\b/)
})
