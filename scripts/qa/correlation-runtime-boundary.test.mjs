import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..', '..')
const read = (path) => readFileSync(resolve(root, path), 'utf8')

const consumers = ['lib/utils/logger.ts', 'lib/cache/redis-layer.ts', 'lib/supabase/server.ts']

test('correlation bridge stays import-free and runtime-neutral', () => {
  const bridge = read('lib/telemetry/correlation-context.ts')
  assert.doesNotMatch(bridge, /^\s*import\s/m)
  assert.doesNotMatch(bridge, /\brequire\s*\(/)
  assert.match(bridge, /export function installCorrelationIdReader\(/)
  assert.match(bridge, /export function readCorrelationId\(/)
})

test('the API correlation owner publishes its reader through the bridge', () => {
  assert.match(
    read('lib/api/correlation.ts'),
    /installCorrelationIdReader\(\(\) => correlationStore\?\.getStore\(\)\)/
  )
})

test('shared consumers read through the bridge', () => {
  for (const path of consumers) {
    assert.match(
      read(path),
      /import \{ readCorrelationId \} from '@\/lib\/telemetry\/correlation-context'/
    )
  }
})

// A computed require of an aliased path compiles to webpack's empty context and
// always throws MODULE_NOT_FOUND in production, while jest's moduleNameMapper
// resolves it fine — so the failure is invisible to unit tests.
test('no source requires a computed @/ path', () => {
  const result = spawnSync(
    'git',
    ['grep', '-n', '-E', '[\'"]@/[^\'"]*[\'"]\\s*\\+', '--', 'lib', 'app', 'worker'],
    { cwd: root, encoding: 'utf8' }
  )
  // git grep exits 1 when nothing matches; anything else is a hit or an error.
  assert.equal(result.status, 1, result.stdout || result.stderr)
})
