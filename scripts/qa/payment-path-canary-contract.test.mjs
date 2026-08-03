import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync('scripts/openclaw/payment-path-canary.mjs', 'utf8')
const workflow = readFileSync('.github/workflows/openclaw-sentinels.yml', 'utf8')

assert.match(source, /BEGIN TRANSACTION READ ONLY/)
assert.match(source, /stripe_paid_launch_readiness_v2/)
assert.match(source, /stripe-entitlement-effects/)
assert.match(source, /api_tier_payment_ownership_anomalies/)
assert.match(source, /api_tier_payment_backfill_incomplete/)
assert.match(source, /api_tier_reversal_actions_incomplete/)
assert.doesNotMatch(source, /update_subscription_and_profile/)
assert.doesNotMatch(source, /QA_USER_ID/)
assert.doesNotMatch(source, /DELETE FROM subscriptions/i)
assert.doesNotMatch(source, /UPDATE user_profiles/i)
assert.match(workflow, /payment-path-canary:[\s\S]*READ ONLY/)

console.log('payment path canary read-only contract passed')
