import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const contractPath = 'scripts/qa/flash-news-translation-retirement.test.mjs'
const retiredStem = ['retranslate', 'all'].join('-')
const retiredPath = ['scripts', 'flash-news', `${retiredStem}.mjs`].join('/')
const classifierPath = 'scripts/backfill-flash-news-classify.mjs'
const backfillPath = 'scripts/backfill-flash-news-translate.mjs'
const translatorPath = 'lib/services/translate-server.ts'
const ingestPath = 'app/api/cron/flash-news-fetch/route.ts'

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function git(args, expectedStatuses = [0]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.ok(
    expectedStatuses.includes(result.status),
    result.stderr || `git ${args.join(' ')} exited ${result.status}`
  )
  return result
}

function trackedPaths(pathspec) {
  return git(['ls-files', '-z', '--', pathspec])
    .stdout.split('\0')
    .filter(Boolean)
    .filter((path) => lstatSync(resolve(root, path), { throwIfNoEntry: false }) !== undefined)
}

function trackedReferences(value) {
  const result = git(
    ['grep', '-n', '-I', '--fixed-strings', value, '--', '.', `:!${contractPath}`],
    [0, 1]
  )
  return result.status === 0 ? result.stdout.trim().split('\n').filter(Boolean) : []
}

function isFlashNewsRowUpdater(source) {
  const accessesFlashNews = /\bflash_news\b/.test(source)
  const updatesExistingRows =
    /\.from\s*\([^)]*\)[\s\S]{0,400}\.(?:update|upsert)\s*\(/.test(source) ||
    /method\s*:\s*['"]PATCH['"]/.test(source) ||
    /\bUPDATE\s+(?:public\.)?flash_news\b/i.test(source)
  return accessesFlashNews && updatesExistingRows
}

function canonicalSafetyViolations(source) {
  const violations = []
  const checks = [
    ['requires explicit --apply', /const APPLY = args\.includes\(['"]--apply['"]\)/],
    ['defaults to a 30-day window', /const DAYS = parseInt\([\s\S]*\|\| ['"]30['"], 10\)/],
    ['bounds rows by publication date', /published_at=gte\.\$\{sinceISO\}/],
    [
      'selects only rows missing a localized title',
      /or=\(title_zh\.is\.null,title_ja\.is\.null,title_ko\.is\.null\)/,
    ],
    [
      'translates only missing targets',
      /const wanted = TARGETS\.filter\(\(tl\) => isEmpty\(row\[`title_\$\{tl\}`\]\)\)/,
    ],
    [
      'preserves an existing English title',
      /if \(isEmpty\(row\.title_en\)\) update\.title_en = row\.title/,
    ],
  ]
  for (const [description, pattern] of checks) {
    if (!pattern.test(source)) violations.push(description)
  }

  const mainStart = source.indexOf('async function main()')
  if (mainStart === -1) {
    violations.push('retains the audited main function')
  } else {
    const main = source.slice(mainStart)
    const dryRunGuard = main.indexOf('if (!APPLY)')
    if (
      dryRunGuard === -1 ||
      !/if \(!APPLY\) \{[\s\S]*?DRY-RUN[\s\S]*?return\n\s*\}/.test(main.slice(dryRunGuard))
    ) {
      violations.push('returns before translation or writes in dry-run mode')
    }
    for (const sideEffect of ['await translateText', 'await patchRow']) {
      const sideEffectIndex = main.indexOf(sideEffect)
      if (dryRunGuard === -1 || sideEffectIndex <= dryRunGuard) {
        violations.push(`${sideEffect} remains behind the apply guard`)
      }
    }
  }

  if (/OPENAI_API_KEY|api\.openai\.com|gpt-4o-mini/.test(source)) {
    violations.push('does not restore the direct OpenAI translation path')
  }
  if (/\.update\(\s*\{\s*title_(?:zh|ja|ko)\s*:/.test(source)) {
    violations.push('does not restore direct localized-title overwrites')
  }
  return violations
}

test('keeps the unsafe full-table translation entrypoint retired', () => {
  assert.equal(
    lstatSync(resolve(root, retiredPath), { throwIfNoEntry: false }),
    undefined,
    `${retiredPath} must remain absent, including dangling symbolic links`
  )
  assert.deepEqual(trackedPaths(retiredPath), [])
  assert.deepEqual(trackedReferences(retiredPath), [])
  assert.deepEqual(trackedReferences(retiredStem), [])

  const runtimeExtensions = new Set(['.cjs', '.cts', '.js', '.mjs', '.mts', '.ts', '.tsx'])
  const existingRowWriters = []
  for (const path of trackedPaths('scripts')) {
    if (!runtimeExtensions.has(extname(path))) continue
    if (path === contractPath) continue
    const source = read(path)
    if (isFlashNewsRowUpdater(source)) existingRowWriters.push(path)
  }

  assert.deepEqual(existingRowWriters, [classifierPath, backfillPath])
})

test('flash-news row-writer inventory catches renamed and computed-field mutations', () => {
  const renamedAndCommentPadded = `
    // Claims such as --apply and title_zh.is.null must not create an exception.
    async function repaintEverything(client, nextTitle) {
      await client.from('flash_news').select('*')
      const payload = { title_zh: nextTitle }
      return client.from('flash_news').update(payload)
    }
  `
  const renamedRestWriter = `
    async function repaintViaRest(url, title) {
      return fetch(url + '/flash_news?id=neq.null', {
        method: 'PATCH',
        body: JSON.stringify({ title_ja: title }),
      })
    }
  `
  const dynamicTableAndPayloadWriter = `
    const TABLE = 'flash_news'
    const payload = { title_zh: 'fixture' }
    client.from(TABLE).update(payload)
  `
  const upsertWriter = `
    client.from('flash_news').upsert({ title_ko: 'fixture' })
  `
  const unrelatedCategoryPatch = `
    fetch('/flash_news?id=eq.fixture', {
      method: 'PATCH',
      body: JSON.stringify({ category: 'defi' }),
    })
  `
  const computedLocalizedFieldWriter = `
    const field = ['title', language].join('_')
    client.from('flash_news').update({ [field]: translated })
  `

  assert.equal(isFlashNewsRowUpdater(renamedAndCommentPadded), true)
  assert.equal(isFlashNewsRowUpdater(renamedRestWriter), true)
  assert.equal(isFlashNewsRowUpdater(dynamicTableAndPayloadWriter), true)
  assert.equal(isFlashNewsRowUpdater(upsertWriter), true)
  assert.equal(isFlashNewsRowUpdater(unrelatedCategoryPatch), true)
  assert.equal(isFlashNewsRowUpdater(computedLocalizedFieldWriter), true)
})

test('the allowed category writer performs only an intercepted GET by default', (t) => {
  assert.deepEqual(trackedPaths(classifierPath), [classifierPath])
  const source = read(classifierPath)
  assert.match(source, /const APPLY = args\.includes\(['"]--apply['"]\)/)

  const fixtureRoot = mkdtempSync(join(tmpdir(), 'arena-classifier-dry-run.'))
  const preloadPath = join(fixtureRoot, 'block-network.mjs')
  const requestLogPath = join(fixtureRoot, 'requests.json')
  t.after(() => rmSync(fixtureRoot, { force: true, recursive: true }))

  writeFileSync(
    preloadPath,
    `
      import { writeFileSync } from 'node:fs'

      const requestLogPath = process.env.FLASH_NEWS_CLASSIFIER_REQUEST_LOG
      if (!requestLogPath) throw new Error('missing isolated request log path')
      const requests = []

      globalThis.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input?.url ?? String(input)
        const method = String(init.method ?? input?.method ?? 'GET').toUpperCase()
        requests.push({ method, url })

        if (method !== 'GET' || !url.startsWith('https://fixture.invalid/rest/v1/flash_news?')) {
          throw new Error(\`blocked non-fixture request: \${method} \${url}\`)
        }

        return new Response(
          JSON.stringify([
            {
              id: 'fixture-news-1',
              title: 'Bitcoin fixture headline',
              content: 'Bitcoin market update',
              category: 'other'
            }
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      process.on('exit', () => writeFileSync(requestLogPath, JSON.stringify(requests)))
    `
  )

  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--import', pathToFileURL(preloadPath).href, resolve(root, classifierPath)],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        FLASH_NEWS_CLASSIFIER_REQUEST_LOG: requestLogPath,
        NEXT_PUBLIC_SUPABASE_URL: 'https://fixture.invalid',
        PATH: process.env.PATH ?? '',
        SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role-key',
      },
    }
  )

  assert.equal(result.signal, null)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /mode=DRY-RUN/)
  assert.match(result.stdout, /scanned 1 rows/)
  assert.match(result.stdout, /no writes/)

  const requests = JSON.parse(readFileSync(requestLogPath, 'utf8'))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'GET')
  const requestUrl = new URL(requests[0].url)
  assert.equal(requestUrl.origin, 'https://fixture.invalid')
  assert.equal(requestUrl.pathname, '/rest/v1/flash_news')
  assert.equal(
    requests.some(({ method }) => method === 'PATCH'),
    false
  )
})

test('the canonical backfill is dry-run by default and fills only missing recent fields', () => {
  assert.deepEqual(trackedPaths(backfillPath), [backfillPath])
  const source = read(backfillPath)

  assert.deepEqual(canonicalSafetyViolations(source), [])
})

test('canonical static safety checks reject unsafe mutations', () => {
  const source = read(backfillPath)
  const mutations = [
    source.replace("const APPLY = args.includes('--apply')", 'const APPLY = true'),
    source.replace(
      '&or=(title_zh.is.null,title_ja.is.null,title_ko.is.null)',
      '&title_zh=not.is.null'
    ),
    source.replace(
      'const wanted = TARGETS.filter((tl) => isEmpty(row[`title_${tl}`]))',
      'const wanted = TARGETS'
    ),
    source.replace('if (!APPLY) {', 'if (false) {'),
  ]

  for (const mutation of mutations) {
    assert.notEqual(mutation, source, 'mutation fixture must alter the canonical source')
    assert.notDeepEqual(canonicalSafetyViolations(mutation), [])
  }
})

test('canonical default execution performs only the intercepted fixture GET', (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'arena-translation-dry-run.'))
  const preloadPath = join(fixtureRoot, 'block-network.mjs')
  const requestLogPath = join(fixtureRoot, 'requests.json')
  t.after(() => rmSync(fixtureRoot, { force: true, recursive: true }))

  writeFileSync(
    preloadPath,
    `
      import { writeFileSync } from 'node:fs'

      const requestLogPath = process.env.FLASH_NEWS_TRANSLATION_REQUEST_LOG
      if (!requestLogPath) throw new Error('missing isolated request log path')
      const requests = []

      globalThis.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : input?.url ?? String(input)
        const method = String(init.method ?? input?.method ?? 'GET').toUpperCase()
        requests.push({ method, url })

        if (method !== 'GET' || !url.startsWith('https://fixture.invalid/rest/v1/flash_news?')) {
          throw new Error(\`blocked non-fixture request: \${method} \${url}\`)
        }

        return new Response(
          JSON.stringify([
            {
              id: 'fixture-news-1',
              title: 'Bitcoin fixture headline',
              title_en: 'Bitcoin fixture headline',
              title_zh: null,
              title_ja: 'fixture-ja',
              title_ko: 'fixture-ko'
            }
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }

      process.on('exit', () => writeFileSync(requestLogPath, JSON.stringify(requests)))
    `
  )

  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--import', pathToFileURL(preloadPath).href, resolve(root, backfillPath)],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        FLASH_NEWS_TRANSLATION_REQUEST_LOG: requestLogPath,
        NEXT_PUBLIC_SUPABASE_URL: 'https://fixture.invalid',
        PATH: process.env.PATH ?? '',
        SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role-key',
      },
    }
  )

  assert.equal(result.signal, null)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /mode=DRY-RUN/)
  assert.match(result.stdout, /1 rows missing/)
  assert.match(result.stdout, /no gtx calls, no writes/)

  const requests = JSON.parse(readFileSync(requestLogPath, 'utf8'))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].method, 'GET')
  const requestUrl = new URL(requests[0].url)
  assert.equal(requestUrl.origin, 'https://fixture.invalid')
  assert.equal(requestUrl.pathname, '/rest/v1/flash_news')
  assert.match(requestUrl.search, /or=\(title_zh\.is\.null,title_ja\.is\.null,title_ko\.is\.null\)/)
  assert.equal(
    requests.some(({ method }) => method === 'PATCH'),
    false
  )
  assert.equal(
    requests.some(({ url }) => url.includes('translate.googleapis.com')),
    false
  )
})

test('ingest and backfill share the bounded server translation implementation', () => {
  assert.deepEqual(trackedPaths(translatorPath), [translatorPath])
  assert.deepEqual(trackedPaths(ingestPath), [ingestPath])

  const backfill = read(backfillPath)
  const translator = read(translatorPath)
  const ingest = read(ingestPath)

  assert.match(
    backfill,
    /import \{ translateText \} from ['"]\.\.\/lib\/services\/translate-server\.ts['"]/
  )
  assert.match(
    ingest,
    /import \{ translateText, type TranslateTarget \} from ['"]@\/lib\/services\/translate-server['"]/
  )
  assert.match(backfill, /await translateText\(source, tl, ['"]en['"]\)/)
  assert.match(ingest, /translateText\(item\.title, tl, ['"]en['"], 4000\)/)
  assert.match(translator, /export async function translateText\(/)
  assert.match(translator, /fetch\(url, \{ signal: AbortSignal\.timeout\(timeoutMs\) \}\)/)
  assert.match(translator, /catch \{[\s\S]*return null\n\s*\}/)
})
