const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const STRIPE_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_]{1,252}$/
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

type JsonRecord = Record<string, unknown>

export type TipCheckoutAcknowledgement = Readonly<{
  tipId: string
  sessionId: string
  expiresAt: string
  url: string
}>

export type VerifiedTipPayment = Readonly<{
  tipId: string
  sessionId: string
  fromUserId: string
  postId: string
  toUserId: string
  amountCents: number
  currency: 'usd'
  completedAt: string
}>

export type TipVerificationFailure = 'pending' | 'failed' | 'refunded' | 'unavailable'

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const canonical = [...expected].sort()
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  )
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    ISO_TIMESTAMP_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

function isStripeSessionId(value: unknown): value is string {
  return typeof value === 'string' && STRIPE_SESSION_ID_PATTERN.test(value)
}

function isTrustedCheckoutUrl(value: unknown, sessionId: string): value is string {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 4_096) return false

  try {
    const url = new URL(value)
    let pathSegments: string[]
    try {
      pathSegments = decodeURIComponent(url.pathname).split('/')
    } catch {
      return false
    }
    return (
      url.protocol === 'https:' &&
      url.hostname === 'checkout.stripe.com' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      pathSegments.includes(sessionId)
    )
  } catch {
    return false
  }
}

function readExactEnvelope(value: unknown): { data: JsonRecord; meta: JsonRecord } | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['data', 'meta', 'success']) ||
    value.success !== true ||
    !isRecord(value.data) ||
    !isRecord(value.meta) ||
    !hasExactKeys(value.meta, ['timestamp']) ||
    !isIsoTimestamp(value.meta.timestamp)
  ) {
    return null
  }
  return { data: value.data, meta: value.meta }
}

export function readTipCheckoutAcknowledgement(
  value: unknown,
  expected: {
    viewerId: string
    postId: string
    recipientId: string
    amountCents: number
  }
): TipCheckoutAcknowledgement | null {
  const envelope = readExactEnvelope(value)
  if (
    !envelope ||
    !hasExactKeys(envelope.data, ['checkout']) ||
    !isRecord(envelope.data.checkout)
  ) {
    return null
  }

  const checkout = envelope.data.checkout
  if (
    !hasExactKeys(checkout, [
      'amount_cents',
      'currency',
      'expires_at',
      'from_user_id',
      'post_id',
      'session_id',
      'status',
      'tip_id',
      'to_user_id',
      'url',
    ]) ||
    !isCanonicalUuid(expected.viewerId) ||
    !isCanonicalUuid(expected.postId) ||
    !isCanonicalUuid(expected.recipientId) ||
    !Number.isInteger(expected.amountCents) ||
    expected.amountCents < 100 ||
    expected.amountCents > 50_000 ||
    !isCanonicalUuid(checkout.tip_id) ||
    checkout.from_user_id !== expected.viewerId ||
    checkout.post_id !== expected.postId ||
    checkout.to_user_id !== expected.recipientId ||
    checkout.amount_cents !== expected.amountCents ||
    checkout.currency !== 'usd' ||
    checkout.status !== 'open' ||
    !isStripeSessionId(checkout.session_id) ||
    !isIsoTimestamp(checkout.expires_at) ||
    Date.parse(checkout.expires_at) <= Date.now() ||
    !isTrustedCheckoutUrl(checkout.url, checkout.session_id)
  ) {
    return null
  }

  return {
    tipId: checkout.tip_id,
    sessionId: checkout.session_id,
    expiresAt: checkout.expires_at,
    url: checkout.url,
  }
}

export function readVerifiedTipPayment(
  value: unknown,
  expected: { viewerId: string; sessionId: string }
): VerifiedTipPayment | null {
  const envelope = readExactEnvelope(value)
  if (
    !envelope ||
    !hasExactKeys(envelope.data, ['tip']) ||
    !isRecord(envelope.data.tip) ||
    !isCanonicalUuid(expected.viewerId) ||
    !isStripeSessionId(expected.sessionId)
  ) {
    return null
  }

  const tip = envelope.data.tip
  if (
    !hasExactKeys(tip, [
      'amount_cents',
      'completed_at',
      'currency',
      'from_user_id',
      'post_id',
      'session_id',
      'status',
      'tip_id',
      'to_user_id',
    ]) ||
    !isCanonicalUuid(tip.tip_id) ||
    tip.session_id !== expected.sessionId ||
    tip.from_user_id !== expected.viewerId ||
    !isCanonicalUuid(tip.post_id) ||
    !isCanonicalUuid(tip.to_user_id) ||
    typeof tip.amount_cents !== 'number' ||
    !Number.isInteger(tip.amount_cents) ||
    tip.amount_cents < 100 ||
    tip.amount_cents > 50_000 ||
    tip.currency !== 'usd' ||
    tip.status !== 'completed' ||
    !isIsoTimestamp(tip.completed_at)
  ) {
    return null
  }

  return {
    tipId: tip.tip_id,
    sessionId: tip.session_id,
    fromUserId: tip.from_user_id,
    postId: tip.post_id,
    toUserId: tip.to_user_id,
    amountCents: tip.amount_cents,
    currency: tip.currency,
    completedAt: tip.completed_at,
  }
}

export function readTipVerificationFailure(
  value: unknown,
  status: number
): TipVerificationFailure | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['code', 'error', 'success']) ||
    value.success !== false ||
    typeof value.error !== 'string'
  ) {
    return null
  }

  if (status === 409 && value.code === 'TIP_PAYMENT_PENDING') return 'pending'
  if (status === 410 && value.code === 'TIP_PAYMENT_FAILED') return 'failed'
  if (status === 410 && value.code === 'TIP_PAYMENT_REFUNDED') return 'refunded'
  if (
    (status === 404 && value.code === 'TIP_PAYMENT_NOT_FOUND') ||
    (status === 409 && value.code === 'TIP_PAYMENT_IDENTITY_CONFLICT') ||
    (status === 503 && value.code === 'TIP_PAYMENT_AUTHORITY_UNAVAILABLE')
  ) {
    return 'unavailable'
  }
  return null
}

export function isValidTipSessionId(value: string | null): value is string {
  return isStripeSessionId(value)
}
