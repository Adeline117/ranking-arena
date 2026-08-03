import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const source = readFileSync(join(process.cwd(), 'scripts/qa/button-sweep.mjs'), 'utf8')
const authSource = readFileSync(join(process.cwd(), 'scripts/qa/auth-button-sweep.mjs'), 'utf8')
const visualSource = readFileSync(join(process.cwd(), 'scripts/qa/visual-audit.mjs'), 'utf8')
const exhaustiveSource = readFileSync(
  join(process.cwd(), 'scripts/qa/exhaustive-sweep.mjs'),
  'utf8'
)
const traderRegressionSource = readFileSync(
  join(process.cwd(), 'e2e/trader-detail-500-regression.spec.ts'),
  'utf8'
)

test('public entity routes use live API samples instead of retired fixtures', () => {
  assert.doesNotMatch(source, /\/trader\/soul|\/wrapped\/soul|\/u\/arena_bot/)
  assert.match(source, /addDynamic\(\s*'\/trader\/\[handle\]'/)
  assert.match(source, /addDynamic\('\/wrapped\/\[handle\]'/)
  assert.match(source, /addDynamic\('\/u\/\[handle\]'/)
  assert.match(source, /if \(!response\.ok\) throw new Error/)
})

test('the dynamic trader sample participates in the locale sweep', () => {
  assert.match(source, /\{ coreLang: true \}/)
  assert.match(source, /for \(const route of coreLangRoutes\)/)
})

test('the authenticated write sweep has no retired trader fallback', () => {
  assert.doesNotMatch(authSource, /\/trader\/soul/)
  assert.match(authSource, /\?source=\$\{encodeURIComponent\(t0r\.platform\)\}/)
  assert.match(authSource, /不回退历史 fixture/)
})

test('the visual audit resolves public entities and reports missing samples', () => {
  assert.doesNotMatch(visualSource, /\/trader\/soul|\/u\/arena_bot/)
  assert.match(visualSource, /addDynamic\('\/trader\/\[handle\]'/)
  assert.match(visualSource, /addDynamic\('\/u\/\[handle\]'/)
  assert.match(visualSource, /显式跳过/)
})

test('the exhaustive audit resolves every public dynamic entity without dead fixtures', () => {
  assert.doesNotMatch(exhaustiveSource, /\/trader\/soul|\/wrapped\/soul|\/u\/arena_bot/)
  for (const route of [
    '/trader/\\[handle\\]',
    '/wrapped/\\[handle\\]',
    '/share/rank/\\[trader_key\\]',
    '/post/\\[id\\]',
    '/u/\\[handle\\]',
    '/groups/\\[id\\]',
    '/feed/\\[id\\]',
  ]) {
    assert.match(exhaustiveSource, new RegExp(`addDynamic\\('${route}'`))
  }
  assert.match(exhaustiveSource, /dynamic skips/)
})

test('the trader 500 regression samples live futures and on-chain identities', () => {
  assert.doesNotMatch(traderRegressionSource, /\/trader\/soul|Anointed-Connect|\?platform=/)
  assert.match(traderRegressionSource, /loadRankingSample\(request, 'futures'\)/)
  assert.match(traderRegressionSource, /loadRankingSample\(request, 'onchain'\)/)
  assert.match(traderRegressionSource, /\?source=\$\{encodeURIComponent\(trader\.source\)\}/)
})
