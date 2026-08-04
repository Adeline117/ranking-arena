import assert from 'node:assert/strict'
import test from 'node:test'

import {
  classifyBoundary,
  collectModuleSpecifiers,
  resolveRepositoryTarget,
} from './architecture-boundary-check.mjs'

test('collects static, dynamic, re-export, require, and type imports', () => {
  const source = `
    import value from '@/lib/value'
    export { thing } from '@/app/thing'
    const lazy = import('@/worker/job')
    const legacy = require('@/connectors')
    type Result = import('@/scripts/tool').Result
  `

  assert.deepEqual(
    collectModuleSpecifiers(source).map(({ kind, specifier }) => ({ kind, specifier })),
    [
      { kind: 'import', specifier: '@/lib/value' },
      { kind: 'export', specifier: '@/app/thing' },
      { kind: 'dynamic-import', specifier: '@/worker/job' },
      { kind: 'require', specifier: '@/connectors' },
      { kind: 'import-type', specifier: '@/scripts/tool' },
    ]
  )
})

test('resolves aliases and relative repository imports', () => {
  assert.equal(resolveRepositoryTarget('lib/domain/file.ts', '@/app/api/jobs'), 'app/api/jobs')
  assert.equal(resolveRepositoryTarget('lib/domain/file.ts', '../../worker/job'), 'worker/job')
  assert.equal(resolveRepositoryTarget('lib/domain/file.ts', 'react'), null)
})

test('classifies forbidden dependency directions', () => {
  assert.equal(
    classifyBoundary('lib/domain/file.ts', 'app/components/Button'),
    'lib-must-not-import-app'
  )
  assert.equal(classifyBoundary('lib/domain/file.ts', 'worker/job'), 'lib-must-not-import-worker')
  assert.equal(classifyBoundary('worker/job.ts', 'app/api/jobs'), 'worker-must-not-import-app')
  assert.equal(
    classifyBoundary('app/components/Card.tsx', 'app/api/jobs/route'),
    'app-ui-must-not-import-api-route'
  )
  assert.equal(classifyBoundary('app/page.tsx', 'worker/job'), 'app-must-not-import-worker')
  assert.equal(classifyBoundary('app/page.tsx', 'scripts/tool'), 'runtime-must-not-import-scripts')
  assert.equal(
    classifyBoundary('lib/cron/job.ts', 'connectors/binance'),
    'runtime-must-not-import-legacy-connectors'
  )
  assert.equal(
    classifyBoundary('lib/cron/job.ts', 'workers/arena-score'),
    'runtime-must-not-import-legacy-workers'
  )
})

test('allows intended dependency directions', () => {
  assert.equal(classifyBoundary('app/api/jobs/route.ts', 'lib/jobs/service'), null)
  assert.equal(classifyBoundary('app/components/Card.tsx', 'lib/ui/card'), null)
  assert.equal(classifyBoundary('worker/job.ts', 'lib/ingest/job'), null)
  assert.equal(classifyBoundary('lib/ingest/job.ts', 'lib/supabase/server'), null)
})
