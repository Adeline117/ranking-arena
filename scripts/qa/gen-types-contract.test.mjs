import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  PRODUCTION_PROJECT_REF,
  attestProductionTypesSource,
  validateDatabaseUrl,
} from '../attest-production-types-source.mjs'
import {
  GROUP_CUTOVER_NULLABLE_RPC_ARGS,
  NULLABLE_RPC_ARGS,
  NULLABLE_RPC_RETURNS,
  VIEW_OVERRIDES,
  postprocessDatabaseTypes,
} from '../postprocess-database-types.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const TYPES_PATH = join(ROOT, 'lib/supabase/database.types.ts')
const GEN_TYPES_PATH = join(ROOT, 'scripts/gen-types.sh')
const TYPEGEN_IMAGE_SEED_PATH = join(ROOT, 'scripts/maintenance/seed-supabase-typegen-image.sh')
const CI_PATH = join(ROOT, '.github/workflows/ci.yml')
const DEPLOY_GATE_PATH = join(ROOT, '.github/workflows/deploy-gate.yml')
const PACKAGE_PATH = join(ROOT, 'package.json')
const CANONICAL = readFileSync(TYPES_PATH, 'utf8')
const POSTGREST_VERSION = CANONICAL.match(/^\s+PostgrestVersion: '([^']+)'$/m)?.[1]

assert.ok(POSTGREST_VERSION, 'canonical types must declare PostgrestVersion')

const INTERNAL_BLOCK = `  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: '${POSTGREST_VERSION}'
  }
`

const VALID_ENV = {
  DATABASE_URL: `postgresql://postgres.${PRODUCTION_PROJECT_REF}:database-secret@aws-0-us-west-2.pooler.supabase.com:6543/postgres`,
  SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
  SUPABASE_SECRET_KEY: 'supabase-secret-marker',
}

function fieldCount(manifest) {
  return Object.values(manifest).reduce((count, fields) => count + Object.keys(fields).length, 0)
}

function cleanEnv(overrides = {}) {
  const env = { ...process.env }
  for (const name of [
    'DATABASE_URL',
    'GEN_TYPES_ATTESTOR_BIN',
    'GEN_TYPES_OUT',
    'SUPABASE_ACCESS_TOKEN',
    'SUPABASE_CLI_BIN',
    'SUPABASE_SECRET_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_URL',
  ]) {
    delete env[name]
  }
  return { ...env, ...overrides }
}

function runGenTypes(env) {
  return spawnSync('bash', [GEN_TYPES_PATH], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  })
}

function workflowJobBlock(workflow, jobName) {
  const marker = `  ${jobName}:\n`
  const start = workflow.indexOf(marker)
  assert.notEqual(start, -1, `${jobName} workflow job is missing`)
  const nextJob = workflow.slice(start + marker.length).search(/\n  [a-z0-9-]+:\n/)
  return nextJob === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + marker.length + nextJob)
}

function workflowStepBlock(job, stepName) {
  const marker = `      - name: ${stepName}\n`
  const start = job.indexOf(marker)
  assert.notEqual(start, -1, `${stepName} workflow step is missing`)
  const nextStep = job.slice(start + marker.length).search(/\n      - (?:name|uses): /)
  return nextStep === -1 ? job.slice(start) : job.slice(start, start + marker.length + nextStep)
}

function fakeOpenApiResponse({
  status = 200,
  projectRef = PRODUCTION_PROJECT_REF,
  version = POSTGREST_VERSION,
  contentType = 'application/openapi+json; charset=utf-8',
  contentProfile = 'public',
  swagger = '2.0',
  jsonError = false,
} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        switch (name.toLowerCase()) {
          case 'sb-project-ref':
            return projectRef
          case 'content-type':
            return contentType
          case 'content-profile':
            return contentProfile
          default:
            return null
        }
      },
    },
    async json() {
      if (jsonError) throw new Error('untrusted-response-secret')
      return {
        swagger,
        info: version === undefined ? {} : { version },
      }
    },
  }
}

function canonicalView(name, fields) {
  const rows = Object.entries(fields).map(([fieldName, contract]) => {
    const nullable = contract.nullable ? ' | null' : ''
    return `          ${fieldName}: ${contract.type}${nullable}`
  })
  return [
    `      ${name}: {`,
    '        Row: {',
    ...rows,
    '        }',
    '        Relationships: []',
    '      }',
  ].join('\n')
}

function generatedView(name, fields) {
  const rows = Object.entries(fields).map(
    ([fieldName, contract]) => `          ${fieldName}: ${contract.type} | null`
  )
  const writes = Object.entries(fields).map(
    ([fieldName, contract]) => `          ${fieldName}?: ${contract.type} | null`
  )
  return [
    `      ${name}: {`,
    '        Row: {',
    ...rows,
    '        }',
    '        Insert: {',
    ...writes,
    '        }',
    '        Update: {',
    ...writes,
    '        }',
    '        Relationships: [{}]',
    '      }',
  ].join('\n')
}

function functionRange(source, functionName) {
  const marker = `      ${functionName}: {`
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `${functionName} fixture is missing`)
  const next = source.slice(start + marker.length).search(/\n      [a-z0-9_]+: \{/)
  const end = next === -1 ? source.indexOf('\n    }', start) : start + marker.length + next
  assert.notEqual(end, -1, `${functionName} fixture boundary is missing`)
  return { start, end }
}

function tableRange(source, tableName) {
  const marker = `      ${tableName}: {`
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `${tableName} fixture is missing`)
  const next = source.slice(start + marker.length).search(/\n      [a-z0-9_]+: \{/)
  const end = next === -1 ? source.indexOf('\n    }', start) : start + marker.length + next
  assert.notEqual(end, -1, `${tableName} fixture boundary is missing`)
  return { start, end }
}

function replaceFunctionArg(source, functionName, argName, contract, nullable) {
  const { start, end } = functionRange(source, functionName)
  const block = source.slice(start, end)
  const optional = contract.optional ? '?' : ''
  const from = `${argName}${optional}: ${contract.type}${nullable ? ' | null' : ''}`
  const to = `${argName}${optional}: ${contract.type}${nullable ? '' : ' | null'}`
  assert.ok(block.includes(from), `${functionName}.${argName} fixture shape changed`)
  return source.slice(0, start) + block.replace(from, to) + source.slice(end)
}

function replaceFunctionReturn(source, functionName, fieldName, contract, nullable) {
  const { start, end } = functionRange(source, functionName)
  const block = source.slice(start, end)
  const from = `${fieldName}: ${contract.type}${nullable ? ' | null' : ''}`
  const to = `${fieldName}: ${contract.type}${nullable ? '' : ' | null'}`
  assert.ok(block.includes(from), `${functionName}.Returns[].${fieldName} fixture shape changed`)
  return source.slice(0, start) + block.replace(from, to) + source.slice(end)
}

function fullCutoverGeneratorFixture() {
  let source = CANONICAL.replace(INTERNAL_BLOCK, '')
  assert.notEqual(source, CANONICAL, 'internal fixture removal failed')

  for (const [viewName, fields] of Object.entries(VIEW_OVERRIDES)) {
    source = source.replace(canonicalView(viewName, fields), generatedView(viewName, fields))
  }
  for (const [functionName, args] of Object.entries(NULLABLE_RPC_ARGS)) {
    for (const [argName, contract] of Object.entries(args)) {
      source = replaceFunctionArg(source, functionName, argName, contract, true)
    }
  }
  for (const [functionName, args] of Object.entries(GROUP_CUTOVER_NULLABLE_RPC_ARGS)) {
    for (const [argName, contract] of Object.entries(args)) {
      source = replaceFunctionArg(source, functionName, argName, contract, true)
    }
  }
  for (const [functionName, fields] of Object.entries(NULLABLE_RPC_RETURNS)) {
    for (const [fieldName, contract] of Object.entries(fields)) {
      source = replaceFunctionReturn(source, functionName, fieldName, contract, true)
    }
  }
  return source
}

function assertManifestArgsNullable(source, manifest) {
  for (const [functionName, args] of Object.entries(manifest)) {
    const { start, end } = functionRange(source, functionName)
    const block = source.slice(start, end)
    for (const [argName, contract] of Object.entries(args)) {
      const optional = contract.optional ? '?' : ''
      assert.ok(
        block.includes(`${argName}${optional}: ${contract.type} | null`),
        `${functionName}.${argName} was not made nullable`
      )
    }
  }
}

function assertManifestReturnsNullable(source, manifest) {
  for (const [functionName, fields] of Object.entries(manifest)) {
    const { start, end } = functionRange(source, functionName)
    const block = source.slice(start, end)
    for (const [fieldName, contract] of Object.entries(fields)) {
      assert.ok(
        block.includes(`${fieldName}: ${contract.type} | null`),
        `${functionName}.Returns[].${fieldName} was not made nullable`
      )
    }
  }
}

test('semantic override manifest stays narrow and auditable', () => {
  assert.deepEqual(Object.keys(VIEW_OVERRIDES).sort(), [
    'group_member_directory',
    'group_member_moderation_directory',
    'own_group_memberships',
  ])
  assert.equal(Object.keys(NULLABLE_RPC_ARGS).length, 12)
  assert.equal(fieldCount(NULLABLE_RPC_ARGS), 32)
  assert.equal(Object.keys(GROUP_CUTOVER_NULLABLE_RPC_ARGS).length, 7)
  assert.equal(fieldCount(GROUP_CUTOVER_NULLABLE_RPC_ARGS), 11)
  assert.deepEqual(Object.keys(NULLABLE_RPC_RETURNS).sort(), [
    'moderate_report_queue_atomic',
    'moderate_report_queue_atomic_v1_internal',
    'resolve_content_report_atomic',
  ])
  assert.equal(fieldCount(NULLABLE_RPC_RETURNS), 9)
})

test('database URL must be bound to the fixed project by host or pooler username', () => {
  assert.doesNotThrow(() =>
    validateDatabaseUrl(
      `postgresql://postgres:secret@db.${PRODUCTION_PROJECT_REF}.supabase.co:5432/postgres`
    )
  )
  assert.doesNotThrow(() => validateDatabaseUrl(VALID_ENV.DATABASE_URL))
  assert.throws(
    () =>
      validateDatabaseUrl(
        'postgresql://postgres:secret@db.wrongprojectref.supabase.co:5432/postgres'
      ),
    /not bound to the production project/
  )
  assert.throws(
    () =>
      validateDatabaseUrl(
        `postgresql://postgres.${PRODUCTION_PROJECT_REF}:secret@attacker.invalid:5432/postgres`
      ),
    /not bound to the production project/
  )
})

test('REST OpenAPI attests HTTP, project ref, supported version, and env-only key', async () => {
  const calls = []
  const result = await attestProductionTypesSource({
    env: VALID_ENV,
    fetchImpl: async (...args) => {
      calls.push(args)
      return fakeOpenApiResponse({ version: '13.0.4' })
    },
  })

  assert.deepEqual(result, {
    projectRef: PRODUCTION_PROJECT_REF,
    postgrestVersion: '13.0.4',
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0].href, `${VALID_ENV.SUPABASE_URL}/rest/v1/`)
  assert.equal(calls[0][1].headers.apikey, VALID_ENV.SUPABASE_SECRET_KEY)
  assert.equal(calls[0][1].headers.Authorization, undefined)
  assert.equal(calls[0][1].headers['Accept-Profile'], 'public')

  const { SUPABASE_SECRET_KEY: _unused, ...legacyEnv } = VALID_ENV
  let legacyHeaders
  await attestProductionTypesSource({
    env: {
      ...legacyEnv,
      SUPABASE_SERVICE_ROLE_KEY: 'legacy-service-role-marker',
    },
    fetchImpl: async (_url, options) => {
      legacyHeaders = options.headers
      return fakeOpenApiResponse()
    },
  })
  assert.equal(legacyHeaders.apikey, 'legacy-service-role-marker')
  assert.equal(legacyHeaders.Authorization, undefined)
})

test('REST OpenAPI rejects HTTP, wrong project, missing version, and unsupported major without leaking keys', async () => {
  const cases = [
    {
      response: fakeOpenApiResponse({ status: 401 }),
      expected: /HTTP 401/,
    },
    {
      response: fakeOpenApiResponse({ status: 204 }),
      expected: /HTTP 204/,
    },
    {
      response: fakeOpenApiResponse({ projectRef: 'wrongprojectref' }),
      expected: /project ref does not match production/,
    },
    {
      response: fakeOpenApiResponse({ contentType: 'application/json' }),
      expected: /content-type is not OpenAPI JSON/,
    },
    {
      response: fakeOpenApiResponse({ contentProfile: null }),
      expected: /content-profile is not public/,
    },
    {
      response: fakeOpenApiResponse({ swagger: '3.0' }),
      expected: /document is not Swagger 2.0/,
    },
    {
      response: fakeOpenApiResponse({ version: null }),
      expected: /info.version is missing or malformed/,
    },
    {
      response: fakeOpenApiResponse({ version: '15.0.0' }),
      expected: /PostgREST major 15 is not supported/,
    },
  ]

  for (const { response, expected } of cases) {
    await assert.rejects(
      attestProductionTypesSource({
        env: VALID_ENV,
        fetchImpl: async () => response,
      }),
      (error) => {
        assert.match(error.message, expected)
        assert.doesNotMatch(error.message, new RegExp(VALID_ENV.SUPABASE_SECRET_KEY))
        return true
      }
    )
  }

  await assert.rejects(
    attestProductionTypesSource({
      env: VALID_ENV,
      fetchImpl: async () => {
        throw new Error(VALID_ENV.SUPABASE_SECRET_KEY)
      },
    }),
    (error) => {
      assert.match(error.message, /REST OpenAPI request failed/)
      assert.doesNotMatch(error.message, /supabase-secret-marker/)
      return true
    }
  )

  let attackerFetches = 0
  await assert.rejects(
    attestProductionTypesSource({
      env: { ...VALID_ENV, SUPABASE_URL: 'https://attacker.invalid' },
      fetchImpl: async () => {
        attackerFetches += 1
        return fakeOpenApiResponse()
      },
    }),
    /SUPABASE_URL host does not match the production project/
  )
  assert.equal(attackerFetches, 0)
})

test('checked-in canonical types are attested and idempotent', () => {
  const once = postprocessDatabaseTypes(CANONICAL, TYPES_PATH, POSTGREST_VERSION)
  const twice = postprocessDatabaseTypes(once, TYPES_PATH, POSTGREST_VERSION)
  assert.equal(once, CANONICAL)
  assert.equal(twice, CANONICAL)
})

test('db-url generator output gets exact internal metadata and all semantic overrides idempotently', () => {
  const generated = fullCutoverGeneratorFixture()
  assert.doesNotMatch(generated, /^\s+__InternalSupabase:/m)

  const processed = postprocessDatabaseTypes(generated, 'cutover.types.ts', POSTGREST_VERSION)
  assert.ok(processed.includes(INTERNAL_BLOCK.trimEnd()))
  for (const [viewName, fields] of Object.entries(VIEW_OVERRIDES)) {
    assert.ok(processed.includes(canonicalView(viewName, fields)))
  }
  assertManifestArgsNullable(processed, NULLABLE_RPC_ARGS)
  assertManifestArgsNullable(processed, GROUP_CUTOVER_NULLABLE_RPC_ARGS)
  assertManifestReturnsNullable(processed, NULLABLE_RPC_RETURNS)
  assert.equal(
    postprocessDatabaseTypes(processed, 'cutover.types.ts', POSTGREST_VERSION),
    processed
  )
})

test('postprocessor verifies existing internal metadata and fails closed on missing targets or partial cutovers', () => {
  assert.throws(
    () =>
      postprocessDatabaseTypes(
        CANONICAL,
        TYPES_PATH,
        POSTGREST_VERSION === '14.5' ? '13.0.4' : '14.5'
      ),
    /PostgrestVersion mismatch/
  )

  const missingArg = CANONICAL.replace(
    'p_checkout_session_id: string | null',
    'p_checkout_session_id_drift: string | null'
  )
  assert.throws(
    () => postprocessDatabaseTypes(missingArg, TYPES_PATH, POSTGREST_VERSION),
    /p_checkout_session_id is missing/
  )

  const returnRange = functionRange(CANONICAL, 'moderate_report_queue_atomic')
  const returnBlock = CANONICAL.slice(returnRange.start, returnRange.end)
  const missingReturn =
    CANONICAL.slice(0, returnRange.start) +
    returnBlock.replace('strike_id: string | null', 'strike_id_drift: string | null') +
    CANONICAL.slice(returnRange.end)
  assert.throws(
    () => postprocessDatabaseTypes(missingReturn, TYPES_PATH, POSTGREST_VERSION),
    /Returns\[\]\.strike_id is missing/
  )

  const changedReturnType =
    CANONICAL.slice(0, returnRange.start) +
    returnBlock.replace(
      'content_soft_deleted: boolean | null',
      'content_soft_deleted: string | null'
    ) +
    CANONICAL.slice(returnRange.end)
  assert.throws(
    () => postprocessDatabaseTypes(changedReturnType, TYPES_PATH, POSTGREST_VERSION),
    /Returns\[\]\.content_soft_deleted changed type/
  )

  const marker = tableRange(CANONICAL, 'group_mute_operations')
  const partialCutover = CANONICAL.slice(0, marker.start) + CANONICAL.slice(marker.end)
  assert.throws(
    () => postprocessDatabaseTypes(partialCutover, TYPES_PATH, POSTGREST_VERSION),
    /partial group cutover schema/
  )
})

test('gen-types fails when DATABASE_URL is unavailable', () => {
  const result = runGenTypes(cleanEnv({ CHECK: '1' }))
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /DATABASE_URL is required/)
})

test('gen-types uses only db-url, offline injected attestation, and never logs credentials', () => {
  const temp = mkdtempSync(join(tmpdir(), 'arena-gen-types-contract.'))
  try {
    const body = CANONICAL.replace(INTERNAL_BLOCK, '').slice(CANONICAL.indexOf('export type Json'))
    const bodyPath = join(temp, 'body.ts')
    const expectedPath = join(temp, 'expected.ts')
    const argsPath = join(temp, 'args.txt')
    const attestorArgsPath = join(temp, 'attestor-args.txt')
    const fakeCli = join(temp, 'fake-supabase')
    const fakeAttestor = join(temp, 'fake-attestor')
    writeFileSync(bodyPath, body)
    writeFileSync(expectedPath, CANONICAL)
    writeFileSync(
      fakeCli,
      `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_ARGS_PATH"
cat "$FAKE_TYPES_BODY"
`
    )
    writeFileSync(
      fakeAttestor,
      `#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_ATTESTOR_ARGS_PATH"
printf '%s\\n' "$FAKE_POSTGREST_VERSION"
`
    )
    chmodSync(fakeCli, 0o755)
    chmodSync(fakeAttestor, 0o755)

    const result = runGenTypes(
      cleanEnv({
        CHECK: '1',
        DATABASE_URL: VALID_ENV.DATABASE_URL,
        FAKE_ARGS_PATH: argsPath,
        FAKE_ATTESTOR_ARGS_PATH: attestorArgsPath,
        FAKE_POSTGREST_VERSION: POSTGREST_VERSION,
        FAKE_TYPES_BODY: bodyPath,
        GEN_TYPES_ATTESTOR_BIN: fakeAttestor,
        GEN_TYPES_OUT: expectedPath,
        SUPABASE_ACCESS_TOKEN: 'must-not-select-project-mode',
        SUPABASE_CLI_BIN: fakeCli,
        SUPABASE_SECRET_KEY: VALID_ENV.SUPABASE_SECRET_KEY,
        SUPABASE_URL: VALID_ENV.SUPABASE_URL,
      })
    )
    assert.equal(result.status, 0, result.stderr)

    const cliArgs = readFileSync(argsPath, 'utf8')
    assert.match(cliArgs, /--db-url/)
    assert.doesNotMatch(cliArgs, /--project-id/)
    assert.match(cliArgs, /database-secret/)
    assert.equal(readFileSync(attestorArgsPath, 'utf8'), '\n')

    const output = result.stdout + result.stderr
    assert.doesNotMatch(output, /database-secret/)
    assert.doesNotMatch(output, /supabase-secret-marker/)
    assert.doesNotMatch(output, /must-not-select-project-mode/)
    assert.deepEqual(
      readdirSync(temp).filter((name) => name.startsWith('.arena-database-types.')),
      []
    )
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('CI keeps type contracts secret-scoped, push-main only, and deployment-blocking', () => {
  const workflow = readFileSync(CI_PATH, 'utf8')
  const deployGate = readFileSync(DEPLOY_GATE_PATH, 'utf8')
  const imageSeed = readFileSync(TYPEGEN_IMAGE_SEED_PATH, 'utf8')
  const packageJson = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'))
  const contractJob = workflowJobBlock(workflow, 'types-contract')
  const liveJob = workflowJobBlock(workflow, 'types-live-drift')
  const seedStep = workflowStepBlock(liveJob, 'Seed pinned postgres-meta image')
  const regenerateStep = workflowStepBlock(liveJob, 'Regenerate from attested production and diff')
  const lintJob = workflowJobBlock(workflow, 'lint-typecheck')
  const buildJob = workflowJobBlock(workflow, 'build')
  const e2eJob = workflowJobBlock(workflow, 'e2e')

  assert.match(contractJob, /Types generation contract \(offline, no secrets\)/)
  assert.doesNotMatch(contractJob, /secrets\./)
  assert.doesNotMatch(contractJob, /DATABASE_URL|SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY/)

  assert.match(liveJob, /Types live drift check \(push main only\)/)
  assert.match(liveJob, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/)
  assert.match(seedStep, /scripts\/maintenance\/seed-supabase-typegen-image\.sh/)
  assert.doesNotMatch(seedStep, /secrets\./)
  assert.match(imageSeed, /MIRROR_IMAGE="supabase\/postgres-meta@\$POSTGRES_META_DIGEST"/)
  assert.match(
    imageSeed,
    /ECR_IMAGE="public\.ecr\.aws\/supabase\/postgres-meta@\$POSTGRES_META_DIGEST"/
  )
  assert.match(
    imageSeed,
    /CLI_IMAGE="public\.ecr\.aws\/supabase\/postgres-meta:\$POSTGRES_META_VERSION"/
  )
  assert.match(
    imageSeed,
    /POSTGRES_META_DIGEST="sha256:a84cc713585eea7b401e4a2561ec4a1e48c87083d1c7ecb4502f204bb4391300"/
  )
  assert.match(readFileSync(GEN_TYPES_PATH, 'utf8'), /SUPABASE_CLI_VERSION="2\.109\.1"/)
  assert.match(imageSeed, /POSTGRES_META_VERSION="v0\.96\.6"/)
  assert.match(imageSeed, /docker tag "\$source_image" "\$CLI_IMAGE"/)
  assert.match(imageSeed, /MAX_ATTEMPTS=3/)
  assert.match(
    regenerateStep,
    /DATABASE_URL: \$\{\{ secrets\.DATABASE_URL \}\}[\s\S]*SUPABASE_URL: \$\{\{ secrets\.SUPABASE_URL \}\}[\s\S]*SUPABASE_SECRET_KEY: \$\{\{ secrets\.SUPABASE_SECRET_KEY \|\| secrets\.SUPABASE_SERVICE_ROLE_KEY \}\}/
  )
  assert.equal(regenerateStep.match(/SUPABASE_SERVICE_ROLE_KEY/g)?.length, 1)
  assert.match(regenerateStep, /for attempt in 1 2 3/)
  assert.match(liveJob, /npm run qa:schema/)
  assert.match(liveJob, /npm run qa:insert-drift/)
  assert.match(liveJob, /npm run qa:read-drift/)
  assert.match(lintJob, /npm run gen:types:contract/)
  assert.doesNotMatch(
    lintJob,
    /DATABASE_URL|SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|npm run qa:(?:schema|insert-drift|read-drift)/
  )
  assert.doesNotMatch(buildJob, /secrets\./)
  assert.match(e2eJob, /Production E2E Canary \(read-only\)/)
  assert.match(e2eJob, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/)
  assert.match(e2eJob, /PLAYWRIGHT_BASE_URL: https:\/\/www\.arenafi\.org/)
  assert.doesNotMatch(e2eJob, /secrets\.|download-artifact|needs: build|npm start|path: \.next/)
  for (const gateJob of [
    'Types generation contract (offline, no secrets)',
    'Types live drift check (push main only)',
    'Pre-flight Checks',
    'Lint & Type Check',
    'Unit Tests',
    'Build',
  ]) {
    assert.ok(deployGate.includes(`"${gateJob}"`), `${gateJob} is missing from deploy gate`)
  }
  assert.match(deployGate, /workflow_run\.event == 'push'/)
  assert.match(deployGate, /jobs\?per_page=100/)
  assert.match(deployGate, /\[ "\$C" = "success" \] \|\| PASS=false/)
  assert.equal(
    packageJson.scripts['gen:types:contract'],
    'node --test scripts/qa/gen-types-contract.test.mjs'
  )
  assert.equal(packageJson.scripts['gen:types:check'], 'CHECK=1 bash scripts/gen-types.sh')
})
