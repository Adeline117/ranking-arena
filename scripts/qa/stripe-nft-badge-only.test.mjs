import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const root = path.resolve(import.meta.dirname, '../..')

function source(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8')
}

function assertNoMatch(value, pattern, message) {
  const match = value.match(pattern)
  if (match) {
    assert.fail(`${message}; matched ${JSON.stringify(match[0])}`)
  }
}

test('membership NFT API stays read-only and cannot write Pro entitlement', () => {
  const route = source('app/api/membership/nft/route.ts')

  assertNoMatch(
    route,
    /\.(?:insert|update|upsert|delete)\s*\(/,
    'GET /api/membership/nft must be a read-only badge endpoint'
  )
  assertNoMatch(
    route,
    /subscription_tier\s*:\s*['"]pro['"]|tier\s*:\s*['"]pro['"]|plan\s*:\s*['"]nft['"]/,
    'NFT badge lookup must not synthesize a Pro subscription'
  )
})

test('premium hooks expose NFT only as badge state, never access authority', () => {
  const hooks = source('lib/premium/hooks.tsx')

  const forbiddenAuthorityPatterns = [
    /\bactualIsPremium\b[^\n;]*\|\|\s*hasNFT/,
    /\bhasNFT\s*\?\s*['"]pro['"]/,
    /\bsource\s*:\s*hasNFT\s*\?/,
    /\bsetSource\(\s*['"]nft['"]\s*\)/,
    /\b(?:nftSub|nftSubscription)\b/,
    /\bsetSubscription\([^)]*\bnft/i,
  ]

  for (const pattern of forbiddenAuthorityPatterns) {
    assertNoMatch(
      hooks,
      pattern,
      `lib/premium/hooks.tsx still maps NFT badge state into Pro authority: ${pattern}`
    )
  }
})

test('subscription reconciliation crons contain no NFT fallback or preserve-access branch', () => {
  for (const relativePath of [
    'app/api/cron/reconcile-subscriptions/route.ts',
    'app/api/cron/subscription-expiry/route.ts',
  ]) {
    const route = source(relativePath)
    assertNoMatch(
      route,
      /checkNFTMembership|@\/lib\/web3\/nft|\bnftUserIds\b|\bhasValidNFT\b|NFT fallback|NFT user/i,
      `${relativePath} still treats NFT state as subscription authority`
    )
  }
})

test('membership center never counts an NFT badge as a real Pro subscription', () => {
  const membership = source('app/(app)/user-center/MembershipContent.tsx')

  assertNoMatch(
    membership,
    /\bhas(?:Genuine|Real)Pro\b[\s\S]{0,160}\b(?:nft|hasNft)\b/i,
    'MembershipContent must not include NFT badge state in Pro authority'
  )
  assertNoMatch(
    membership,
    /\bhasRealSubscription\b\s*\|\|[\s\S]{0,80}\b(?:nft|hasNft)\b/i,
    'A real subscription cannot be replaced by an NFT badge'
  )
})

test('NFT-facing translations do not claim membership, Pro status, or feature unlocks', () => {
  const forbiddenClaims =
    /\bmembership(?:\s+via|\s*\(|\s+card|\s*$)|\bPro status\b|\bunlock\b|通过[^'"\n]*NFT[^'"\n]*(?:获得|解锁)[^'"\n]*Pro|NFT[^'"\n]*(?:获得|解锁)[^'"\n]*Pro|NFTによるProメンバーシップ|NFT[^'"\n]*Proステータス|ロック解除|NFT를 통한 Pro 멤버십|NFT[^'"\n]*Pro 상태|잠금 해제/i

  for (const relativePath of [
    'lib/i18n/en.ts',
    'lib/i18n/zh.ts',
    'lib/i18n/ja.ts',
    'lib/i18n/ko.ts',
  ]) {
    const translations = source(relativePath)
    for (const key of [
      'nftBadgeTitle',
      'walletProNft',
      'walletProStatus',
      'walletHoldNft',
      'nftMembershipCard',
      'nftMembershipLabel',
    ]) {
      const match = translations.match(new RegExp(`\\b${key}:\\s*(['"\`])([^\\n]*?)\\1`))
      assert.ok(match, `${relativePath} is missing ${key}`)
      assertNoMatch(
        match[2],
        forbiddenClaims,
        `${relativePath}:${key} still presents NFT as Pro entitlement: ${match[2]}`
      )
    }
  }
})

test('Stripe migrations and scheduled consumers contain no NFT entitlement effect', () => {
  const migrationSql = readdirSync(path.join(root, 'supabase/migrations'))
    .filter((file) => file.endsWith('.sql'))
    .map((file) => source(path.join('supabase/migrations', file)))
    .join('\n')
  const scheduledConsumers = [
    'app/api/cron/reconcile-subscriptions/route.ts',
    'app/api/cron/subscription-expiry/route.ts',
  ]
    .map(source)
    .join('\n')

  assertNoMatch(
    migrationSql,
    /pro_membership_nft_(?:mint|renew|revoke)/,
    'Stripe entitlement outbox must not enqueue NFT entitlement effects'
  )
  assertNoMatch(
    scheduledConsumers,
    /\b(?:mintNFTForUser|mintMembershipNFT|renewMembershipNFT)\b/,
    'Scheduled entitlement consumers must not mint or renew NFT authority'
  )
})
