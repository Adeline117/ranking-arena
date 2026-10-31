import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  baselineAdditions,
  classifyBoundary,
  collectModuleSpecifiers,
  normalizeArchitectureBaseline,
  resolveRepositoryTarget,
  scanArchitecture,
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
  assert.equal(resolveRepositoryTarget('app/runtime.ts', 'proxy.js'), 'proxy.js')
  assert.equal(resolveRepositoryTarget('app/runtime.ts', 'proxy.jsx'), 'proxy.jsx')
  assert.equal(
    resolveRepositoryTarget('instrumentation.ts', './sentry.server.config.js'),
    'sentry.server.config.js'
  )
  assert.equal(resolveRepositoryTarget('app/runtime.ts', 'tooling/generate'), 'tooling/generate')
  assert.equal(resolveRepositoryTarget('app/runtime.ts', 'infra/deploy'), 'infra/deploy')
  assert.equal(
    resolveRepositoryTarget('app/runtime.ts', 'cloudflare-worker/src/index'),
    'cloudflare-worker/src/index'
  )
  assert.equal(resolveRepositoryTarget('app/runtime.ts', 'e2e/helpers'), 'e2e/helpers')
  assert.equal(resolveRepositoryTarget('app/runtime.ts', '__tests__/helpers'), '__tests__/helpers')
  assert.equal(
    resolveRepositoryTarget('app/runtime.ts', '.github/workflows/ci'),
    '.github/workflows/ci'
  )
  assert.equal(
    resolveRepositoryTarget('app/runtime.ts', 'future-isolated-root/helper', {
      roots: new Set(['future-isolated-root']),
      targets: new Set(),
    }),
    'future-isolated-root/helper'
  )
  const futureRootFileImports = {
    roots: new Set(),
    targets: new Set(['future-tool', 'future-tool.js']),
  }
  assert.equal(
    resolveRepositoryTarget('app/runtime.ts', 'future-tool.js', futureRootFileImports),
    'future-tool.js'
  )
  assert.equal(
    resolveRepositoryTarget('app/runtime.ts', 'future-tool/subpath', futureRootFileImports),
    null
  )
  assert.equal(resolveRepositoryTarget('lib/domain/file.ts', '@/../../scripts/setup'), null)
  assert.equal(resolveRepositoryTarget('lib/domain/file.ts', 'react'), null)
  assert.equal(resolveRepositoryTarget('lib/domain/file.ts', 'next/server'), null)
  assert.equal(resolveRepositoryTarget('lib/domain/file.ts', '@sentry/nextjs'), null)
  assert.equal(resolveRepositoryTarget('lib/domain/file.ts', 'package'), null)
})

test('mutation canaries classify resolved non-runtime roots across module syntaxes', () => {
  const canaries = [
    {
      kind: 'import',
      source: 'app/runtime/entry.ts',
      statement: "import helper from '@/tooling/runtime-helper'",
      target: 'tooling/runtime-helper',
    },
    {
      kind: 'import',
      source: 'lib/runtime/entry.ts',
      statement: "import helper from '../../infra/runtime-helper'",
      target: 'infra/runtime-helper',
    },
    {
      kind: 'dynamic-import',
      source: 'worker/src/entry.ts',
      statement: "const isolated = import('@/cloudflare-worker/src/index')",
      target: 'cloudflare-worker/src/index',
    },
    {
      kind: 'export',
      source: 'lib/runtime/entry.ts',
      statement: "export { fixture } from '../../e2e/fixtures/runtime'",
      target: 'e2e/fixtures/runtime',
    },
    {
      kind: 'require',
      source: 'app/runtime/entry.ts',
      statement: "const helper = require('@/__tests__/runtime-helper')",
      target: '__tests__/runtime-helper',
    },
    {
      kind: 'import',
      source: 'lib/runtime/types.ts',
      statement: "import type { RuntimeFixture } from '@/docs/runtime-fixture'",
      target: 'docs/runtime-fixture',
    },
    {
      kind: 'import-type',
      source: 'worker/src/types.ts',
      statement: "type RuntimeFixture = import('../../tooling/runtime-types').RuntimeFixture",
      target: 'tooling/runtime-types',
    },
    {
      kind: 'import',
      repositoryBareImports: {
        roots: new Set(['future-isolated-root']),
        targets: new Set(),
      },
      source: 'app/runtime/entry.ts',
      statement: "import helper from 'future-isolated-root/runtime-helper'",
      target: 'future-isolated-root/runtime-helper',
    },
  ]

  for (const canary of canaries) {
    const dependencies = collectModuleSpecifiers(canary.statement, canary.source)
    assert.equal(dependencies.length, 1, canary.statement)
    const [dependency] = dependencies
    const target = resolveRepositoryTarget(
      canary.source,
      dependency.specifier,
      canary.repositoryBareImports
    )
    assert.deepEqual(
      {
        kind: dependency.kind,
        rule: classifyBoundary(canary.source, target),
        target,
      },
      {
        kind: canary.kind,
        rule: 'runtime-must-not-import-non-runtime-root',
        target: canary.target,
      },
      canary.statement
    )
  }
})

test('scanner discovers tracked and untracked future repository roots', async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'arena-architecture-root-'))
  t.after(() => rmSync(fixture, { force: true, recursive: true }))
  execFileSync('git', ['init', '--quiet'], { cwd: fixture })
  mkdirSync(join(fixture, 'app'), { recursive: true })
  mkdirSync(join(fixture, 'future-isolated-root'), { recursive: true })
  writeFileSync(
    join(fixture, 'app/page.ts'),
    [
      "import helper from 'future-isolated-root/helper'",
      "import tool from 'future-tool.js'",
      "import esm from 'future-esm.mjs'",
      "import common from 'future-common.cjs'",
      "import types from 'future-types.jsx'",
      "import component from 'future-component.jsx'",
      "import script from 'future-script'",
      "import scriptFallback from 'future-script.jsx'",
      "import jsx from 'future-jsx.js'",
      "import reactRuntime from 'react/jsx-runtime'",
      "import ignoredEsm from 'extensionless-esm'",
      "import ignoredCommon from 'extensionless-common'",
      "import ignoredPackage from 'package'",
      '',
    ].join('\n')
  )
  writeFileSync(join(fixture, 'future-isolated-root/helper.ts'), 'export default true\n')
  writeFileSync(join(fixture, 'future-tool.ts'), 'export default true\n')
  writeFileSync(join(fixture, 'future-esm.mts'), 'export default true\n')
  writeFileSync(join(fixture, 'future-common.cts'), 'export default true\n')
  writeFileSync(
    join(fixture, 'future-types.d.ts'),
    'declare const value: true\nexport default value\n'
  )
  writeFileSync(join(fixture, 'future-component.tsx'), 'export default function Value() {}\n')
  writeFileSync(join(fixture, 'future-script.js'), 'export default true\n')
  writeFileSync(join(fixture, 'future-jsx.jsx'), 'export default true\n')
  writeFileSync(join(fixture, 'react.ts'), 'export default true\n')
  writeFileSync(join(fixture, 'extensionless-esm.mts'), 'export default true\n')
  writeFileSync(join(fixture, 'extensionless-common.cts'), 'export default true\n')
  writeFileSync(join(fixture, 'package.json'), '{}\n')
  execFileSync('git', ['add', '--', 'app/page.ts'], { cwd: fixture })

  const expected = [
    {
      kind: 'import',
      line: 4,
      rule: 'runtime-must-not-import-non-runtime-root',
      source: 'app/page.ts',
      specifier: 'future-common.cjs',
    },
    {
      kind: 'import',
      line: 6,
      rule: 'runtime-must-not-import-non-runtime-root',
      source: 'app/page.ts',
      specifier: 'future-component.jsx',
    },
    {
      kind: 'import',
      line: 3,
      rule: 'runtime-must-not-import-non-runtime-root',
      source: 'app/page.ts',
      specifier: 'future-esm.mjs',
    },
    {
      kind: 'import',
      line: 1,
      rule: 'runtime-must-not-import-non-runtime-root',
      source: 'app/page.ts',
      specifier: 'future-isolated-root/helper',
    },
    {
      kind: 'import',
      line: 9,
      rule: 'runtime-must-not-import-non-runtime-root',
      source: 'app/page.ts',
      specifier: 'future-jsx.js',
    },
    {
      kind: 'import',
      line: 7,
      rule: 'runtime-must-not-import-non-runtime-root',
      source: 'app/page.ts',
      specifier: 'future-script',
    },
    {
      kind: 'import',
      line: 8,
      rule: 'runtime-must-not-import-non-runtime-root',
      source: 'app/page.ts',
      specifier: 'future-script.jsx',
    },
    {
      kind: 'import',
      line: 2,
      rule: 'runtime-must-not-import-non-runtime-root',
      source: 'app/page.ts',
      specifier: 'future-tool.js',
    },
    {
      kind: 'import',
      line: 5,
      rule: 'runtime-must-not-import-non-runtime-root',
      source: 'app/page.ts',
      specifier: 'future-types.jsx',
    },
  ]
  assert.deepEqual(await scanArchitecture(fixture), expected, 'untracked root must be classified')

  execFileSync(
    'git',
    [
      'add',
      '--',
      'extensionless-common.cts',
      'extensionless-esm.mts',
      'future-common.cts',
      'future-component.tsx',
      'future-esm.mts',
      'future-isolated-root/helper.ts',
      'future-jsx.jsx',
      'future-script.js',
      'future-tool.ts',
      'future-types.d.ts',
      'package.json',
      'react.ts',
    ],
    { cwd: fixture }
  )
  assert.deepEqual(await scanArchitecture(fixture), expected, 'tracked root must be classified')
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
  assert.equal(
    classifyBoundary('app/page.tsx', 'proxy.js'),
    'runtime-module-must-not-import-root-entrypoint'
  )
  assert.equal(
    classifyBoundary('app/page.tsx', 'sentry.server.config.jsx'),
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
  for (const target of [
    'tooling/generate',
    'infra/deploy',
    'cloudflare-worker/src/index',
    'e2e/helpers',
    '__tests__/helpers',
    'android/app/build',
    'contracts/scripts/deploy',
    'docs/examples/runtime',
    'ios/App/runtime',
    'public/fixture.json',
    'script/Deploy',
    'specs/runtime-contract',
    'supabase/functions/helper',
    'vendor/runtime-helper',
  ]) {
    assert.equal(
      classifyBoundary('app/page.tsx', target),
      'runtime-must-not-import-non-runtime-root',
      target
    )
  }
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
  assert.equal(classifyBoundary('instrumentation.ts', 'sentry.server.config'), null)
  assert.equal(classifyBoundary('instrumentation.ts', 'sentry.server.config.js'), null)
  assert.equal(classifyBoundary('instrumentation.ts', 'sentry.server.config.jsx'), null)
  assert.equal(classifyBoundary('proxy.ts', 'lib/security/proxy-rate-limit'), null)
  const thirdPartyTarget = resolveRepositoryTarget('app/page.tsx', 'next/server')
  assert.equal(thirdPartyTarget, null)
  assert.equal(classifyBoundary('app/page.tsx', thirdPartyTarget), null)
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
