import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function source(relativePath) {
  return readFileSync(resolve(ROOT, relativePath), 'utf8')
}

function codeOnly(value) {
  return value.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const publication = source('lib/referral/v1-publication.ts')
const referralCard = codeOnly(source('app/components/profile/ReferralCard.tsx'))
const referralPage = codeOnly(source('app/(app)/referral/ReferralClient.tsx'))
const shareActions = codeOnly(source('app/components/trader/TraderShareActions.tsx'))
const shareButtons = codeOnly(source('app/components/trader/ShareRankCardButtons.tsx'))
const shareRedirect = codeOnly(source('app/(app)/share/rank/[trader_key]/page.tsx'))
const rankCard = codeOnly(source('app/api/share/rank-card/route.tsx'))
const docs = [
  source('README.md'),
  source('docs/API_ROUTES.md'),
  source('docs/ARCHITECTURE.md'),
].join('\n')

test('V1 referral-program publication is fixed false and has no environment override', () => {
  assert.match(publication, /V1_REFERRAL_PROGRAM_PUBLISHED\s*=\s*false\s+as const/)
  assert.match(publication, /REFERRAL_PROGRAM_NOT_PUBLISHED/)
  assert.doesNotMatch(publication, /process\.env|NEXT_PUBLIC_|REFERRAL_PROGRAM.*(?:ENV|FLAG)/)
  for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) {
    assert.match(publication, new RegExp(`['"]${header}['"]`))
  }
})

test('referral UI is status-only and cannot acquire, copy, or promise a referral reward', () => {
  for (const component of [referralCard, referralPage]) {
    assert.match(component, /isV1ReferralProgramPublished\(\)/)
    assert.match(component, /referralUnavailableTitle/)
    assert.match(component, /referralUnavailableDescription/)
    assert.match(component, /referralUnavailableHistoryNote/)
    assert.doesNotMatch(
      component,
      /\/api\/referral|\bnavigator\.clipboard\b|referral_link|referral_count/
    )
    assert.doesNotMatch(component, /<button\b|<a\b|<Link\b/)
  }
})

test('rank sharing cannot generate or propagate referral parameters during the V1 hold', () => {
  for (const component of [shareActions, shareButtons]) {
    assert.doesNotMatch(component, /\/api\/referral|\breferralCode\b|params\.set\(['"]ref['"]/)
  }
  assert.doesNotMatch(shareRedirect, /\bref\?:|\bref\s*}\s*=|redirectParams\.set\(['"]ref['"]/)
  assert.doesNotMatch(rankCard, /sp\.get\(['"]ref['"]|\?ref=|caller-provided referral/)
  assert.match(rankCard, /const cta = 'arenafi\.org'/)
})

test('every locale has V1 unavailable copy instead of the retired invitation reward promise', () => {
  const locales = ['en', 'zh', 'ja', 'ko'].map((locale) => source(`lib/i18n/${locale}.ts`))
  for (const locale of locales) {
    assert.match(locale, /referralUnavailableTitle:/)
    assert.match(locale, /referralUnavailableDescription:/)
    assert.match(locale, /referralUnavailableHistoryNote:/)
    assert.doesNotMatch(locale, /Refer \{count\} friends, get \{days\} days of Pro free/)
    assert.doesNotMatch(locale, /邀请 \{count\} 位好友，免费获得 \{days\} 天 Pro/)
    assert.doesNotMatch(locale, /友達を\{count\}人招待して、Proを\{days\}日間無料でゲット/)
    assert.doesNotMatch(locale, /친구 \{count\}명을 초대하고 Pro \{days\}일 무료 받기/)
  }
})

test('source documentation scopes the referral hold without claiming external state', () => {
  assert.match(docs, /V1_REFERRAL_PROGRAM_PUBLISHED=false/)
  assert.match(
    docs,
    /existing referral history is not a promise of automatic rewards|已有推荐历史不构成自动发奖承诺/
  )
  assert.match(
    docs,
    /does not stop, inspect, or\s+prove deployed code, historical records, or external reward state/
  )
})
