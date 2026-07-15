/**
 * Edge-compatible cron authentication.
 *
 * Node's `crypto.timingSafeEqual` cannot be bundled into Edge routes. Hash both
 * values to a fixed length with Web Crypto, then compare every digest byte so
 * mismatched input lengths do not create an early-return timing signal.
 */

async function digest(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value)
  const result = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return new Uint8Array(result)
}

export async function safeCompareEdge(a: string, b: string): Promise<boolean> {
  const [digestA, digestB] = await Promise.all([digest(a), digest(b)])
  let difference = 0

  for (let index = 0; index < digestA.length; index += 1) {
    difference |= digestA[index] ^ digestB[index]
  }

  return difference === 0
}

export async function verifyEdgeCronSecret(request: Request): Promise<boolean> {
  const cronSecret = process.env.CRON_SECRET
  const authorization = request.headers.get('authorization')
  if (!cronSecret || !authorization) return false

  return safeCompareEdge(authorization, `Bearer ${cronSecret}`)
}
