import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = process.cwd()

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

const bridgePath = 'lib/telemetry/correlation-context.ts'
const consumers = ['lib/utils/logger.ts', 'lib/cache/redis-layer.ts', 'lib/supabase/server.ts']

test('correlation bridge stays import-free and runtime-neutral', () => {
  const bridge = read(bridgePath)

  assert.doesNotMatch(bridge, /^\s*import\s/m)
  assert.doesNotMatch(bridge, /\brequire\s*\(/)
  assert.doesNotMatch(bridge, /\b(?:process|window)\b/)
  assert.doesNotMatch(bridge, /['"](?:node:|next\/)/)
  assert.match(bridge, /export function installCorrelationIdReader\(/)
  assert.match(bridge, /export function readCorrelationId\(/)
})

test('API correlation module remains the only AsyncLocalStorage owner', () => {
  const owner = read('lib/api/correlation.ts')

  assert.match(owner, /import \{ AsyncLocalStorage \} from ['"]node:async_hooks['"]/)
  assert.match(owner, /installCorrelationIdReader\(\(\) => correlationStore\.getStore\(\)\)/)
  assert.match(owner, /return readCorrelationId\(\)/)
  assert.doesNotMatch(owner, /\brequire\s*\(/)
  assert.doesNotMatch(owner, /process\.versions/)
})

test('shared correlation consumers use the neutral bridge without dynamic requests', () => {
  for (const path of consumers) {
    const source = read(path)

    assert.match(
      source,
      /import \{ readCorrelationId \} from ['"]@\/lib\/telemetry\/correlation-context['"]/
    )
    assert.doesNotMatch(source, /@\/lib\/api\/['"]?\s*\+/)
    assert.doesNotMatch(source, /\brequire\s*\(/)
  }
})
