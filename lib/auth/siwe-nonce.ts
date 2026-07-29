import { getSharedRedis } from '@/lib/cache/redis-client'

const SIWE_NONCE_TTL_SECONDS = 300
const SIWE_NONCE_PATTERN = /^[a-f0-9]{64}$/
const SIWE_NONCE_VALUE = 'pending'

function nonceKey(nonce: string): string {
  return `siwe:nonce:${nonce}`
}

/** Persist a nonce before exposing it to the browser. No memory fallback is safe. */
export async function storeSiweNonce(nonce: string): Promise<void> {
  if (!SIWE_NONCE_PATTERN.test(nonce)) throw new Error('Invalid SIWE nonce')
  const redis = await getSharedRedis()
  if (!redis) throw new Error('SIWE nonce store unavailable')
  const acknowledgement = await redis.set(nonceKey(nonce), SIWE_NONCE_VALUE, {
    ex: SIWE_NONCE_TTL_SECONDS,
    nx: true,
  })
  if (acknowledgement !== 'OK') throw new Error('SIWE nonce collision')
}

/** Atomically claim a verified nonce. Exactly one concurrent verifier wins. */
export async function consumeSiweNonce(nonce: string): Promise<boolean> {
  if (!SIWE_NONCE_PATTERN.test(nonce)) return false
  const redis = await getSharedRedis()
  if (!redis) throw new Error('SIWE nonce store unavailable')
  return (await redis.getdel<string>(nonceKey(nonce))) === SIWE_NONCE_VALUE
}
