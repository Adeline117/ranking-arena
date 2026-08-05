import assert from 'node:assert/strict'
import test from 'node:test'

import {
  baselineAdditions,
  classifyBoundary,
  collectModuleSpecifiers,
  normalizeArchitectureBaseline,
  resolveRepositoryTarget,
} from './architecture-boundary-check.mjs'

test('collects static, dynamic, re-export, require, and type imports', () => {
  const source = `
    import value from '@/lib/value'
    export { thing } from '@/app/thing'
    const lazy = import('@/worker/job')
    const attributed = import('@/worker/data.json', { with: { type: 'json' } })
    const legacy = require('@/connectors')
    type Result = import('@/scripts/tool').Result
  `

  assert.deepEqual(
    collectModuleSpecifiers(source).map(({ kind, specifier }) => ({ kind, specifier })),
    [
      { kind: 'import', specifier: '@/lib/value' },
      { kind: 'export', specifier: '@/app/thing' },
      { kind: 'dynamic-import', specifier: '@/worker/job' },
      { kind: 'dynamic-import', specifier: '@/worker/data.json' },
      { kind: 'require', specifier: '@/connectors' },
      { kind: 'import-type', specifier: '@/scripts/tool' },
    ]
  )
})

test('collects TypeScript CommonJS imports and fails closed on parse errors', () => {
  assert.deepEqual(
    collectModuleSpecifiers("import route = require('@/app/api/jobs')", 'source.cts').map(
      ({ kind, specifier }) => ({ kind, specifier })
    ),
    [{ kind: 'import-equals', specifier: '@/app/api/jobs' }]
  )
  assert.throws(
    () => collectModuleSpecifiers('import {', 'broken.mts'),
    /Cannot parse broken\.mts:1:/
  )
})

test('resolves aliases and relative repository imports', () => {
  assert.equal(resolveRepositoryTarget('lib/utils/content.ts', '@/lib/logger'), 'lib/logger')
  assert.equal(resolveRepositoryTarget('lib/utils/content.ts', '../logger'), 'lib/logger')
  assert.equal(resolveRepositoryTarget('lib/utils/content.ts', './logger'), 'lib/utils/logger')
  assert.equal(resolveRepositoryTarget('lib/domain/file.ts', '@/app/api/jobs'), 'app/api/jobs')
  assert.equal(
    resolveRepositoryTarget('lib/domain/file.ts', '@/lib/../app/api/jobs'),
    'app/api/jobs'
  )
  assert.equal(resolveRepositoryTarget('lib/domain/file.ts', '@//app/api/jobs'), 'app/api/jobs')
  assert.equal(resolveRepositoryTarget('lib/domain/file.ts', '../../worker/job'), 'worker/job')
  assert.equal(resolveRepositoryTarget('lib/domain/file.ts', 'app/api/jobs'), 'app/api/jobs')
  assert.equal(resolveRepositoryTarget('lib/domain/file.ts', '../../proxy'), 'proxy')
  assert.equal(resolveRepositoryTarget('lib/domain/file.ts', 'proxy'), 'proxy')
  assert.equal(resolveRepositoryTarget('lib/domain/file.ts', '@/../../scripts/setup'), null)
  assert.equal(resolveRepositoryTarget('lib/domain/file.ts', 'react'), null)
})

test('classifies forbidden dependency directions', () => {
  assert.equal(
    classifyBoundary('lib/utils/content.ts', 'lib/logger'),
    'logger-utils-must-use-canonical-module'
  )
  assert.equal(
    classifyBoundary('lib/utils/content.ts', 'lib/logger.ts'),
    'logger-utils-must-use-canonical-module'
  )
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
  assert.equal(
    classifyBoundary('lib/domain/file.ts', 'proxy'),
    'runtime-module-must-not-import-root-entrypoint'
  )
  assert.equal(classifyBoundary('proxy.ts', 'worker/job'), 'root-runtime-must-not-import-worker')
  assert.equal(
    classifyBoundary('sentry.server.config.ts', 'app/api/jobs'),
    'root-runtime-must-not-import-app'
  )
  assert.equal(
    classifyBoundary('instrumentation.ts', 'scripts/setup'),
    'runtime-must-not-import-scripts'
  )
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
  assert.equal(classifyBoundary('lib/utils/content.ts', 'lib/utils/logger'), null)
  assert.equal(classifyBoundary('lib/utils/content.ts', 'lib/logger/README'), null)
  assert.equal(classifyBoundary('lib/utils-legacy/content.ts', 'lib/logger'), null)
  assert.equal(classifyBoundary('lib/services/email.ts', 'lib/logger'), null)
  assert.equal(classifyBoundary('app/api/jobs/route.ts', 'lib/jobs/service'), null)
  assert.equal(classifyBoundary('app/components/Card.tsx', 'lib/ui/card'), null)
  assert.equal(classifyBoundary('worker/job.ts', 'lib/ingest/job'), null)
  assert.equal(classifyBoundary('lib/ingest/job.ts', 'lib/supabase/server'), null)
})

test('validates unique baseline edges and identifies forbidden baseline growth', () => {
  const existing = {
    rule: 'lib-must-not-import-app',
    source: 'lib/domain/file.ts',
    specifier: '@/app/page',
  }
  const added = {
    rule: 'app-must-not-import-worker',
    source: 'app/page.tsx',
    specifier: '@/worker/job',
  }

  assert.deepEqual(normalizeArchitectureBaseline({ version: 1, violations: [existing] }), [
    existing,
  ])
  assert.deepEqual(baselineAdditions([existing, added], [existing]), [added])
  assert.throws(
    () => normalizeArchitectureBaseline({ version: 1, violations: [existing, existing] }),
    /Duplicate architecture baseline entry/
  )
  assert.throws(
    () => normalizeArchitectureBaseline({ version: 1, violations: [{ ...existing, rule: '' }] }),
    /Invalid architecture baseline entry/
  )
})
