export type PostMediaUploadPurpose = 'post_image' | 'post_video' | 'group_avatar' | 'legacy_image'

export type PostMediaUploadRegistryIdentity = Readonly<{
  uploadId: string
  ownerId: string
  objectName: string
  purpose: PostMediaUploadPurpose
  mimeType: string
  sizeBytes: number
}>

type RegistryFailureReason =
  | 'client_unavailable'
  | 'rpc_rejected'
  | 'rpc_ambiguous'
  | 'invalid_result'
  | 'invalid_receipt'
  | 'unexpected_replay'

export type PostMediaUploadRegistryResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false
      reason: RegistryFailureReason
      canCleanupObject: boolean
      error?: unknown
    }>

type RegistryAttempt =
  | Readonly<{ outcome: 'confirmed' }>
  | Readonly<{
      outcome: 'rejected' | 'ambiguous' | 'unexpected_replay'
      reason: RegistryFailureReason
      error?: unknown
    }>

type RegistryOperation = 'reserve' | 'finalize'

const RPC_BY_OPERATION: Readonly<Record<RegistryOperation, string>> = {
  reserve: 'reserve_post_media_upload_atomic',
  finalize: 'finalize_post_media_upload_atomic',
}

const STATUS_BY_OPERATION: Readonly<Record<RegistryOperation, string>> = {
  reserve: 'reserved',
  finalize: 'uploaded',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    keys.length === sortedExpected.length &&
    sortedExpected.every((expectedKey, index) => keys[index] === expectedKey)
  )
}

function isConclusiveDatabaseRejection(value: Record<string, unknown>): boolean {
  const error = value.error
  return (
    value.data === null &&
    Number.isInteger(value.status) &&
    Number(value.status) >= 400 &&
    Number(value.status) <= 599 &&
    typeof value.statusText === 'string' &&
    isRecord(error) &&
    hasExactKeys(error, ['code', 'details', 'hint', 'message']) &&
    typeof error.message === 'string' &&
    typeof error.code === 'string' &&
    /^[0-9A-Z]{5}$/.test(error.code) &&
    (typeof error.details === 'string' || error.details === null) &&
    (typeof error.hint === 'string' || error.hint === null)
  )
}

function readReceiptReplay(
  value: unknown,
  operation: RegistryOperation,
  identity: PostMediaUploadRegistryIdentity
): boolean | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['status', 'upload_id', 'object_name', 'expires_at', 'replayed'])
  ) {
    return null
  }

  const expiresAt = typeof value.expires_at === 'string' ? Date.parse(value.expires_at) : Number.NaN
  if (
    value.status !== STATUS_BY_OPERATION[operation] ||
    value.upload_id !== identity.uploadId ||
    value.object_name !== identity.objectName ||
    !Number.isFinite(expiresAt) ||
    typeof value.replayed !== 'boolean'
  ) {
    return null
  }
  return value.replayed
}

async function attemptPostMediaUploadRegistryMutation(
  client: unknown,
  operation: RegistryOperation,
  identity: PostMediaUploadRegistryIdentity,
  allowReplay: boolean
): Promise<RegistryAttempt> {
  const rpc = isRecord(client) ? client.rpc : null
  if (typeof rpc !== 'function') {
    return { outcome: 'rejected', reason: 'client_unavailable' }
  }

  let rawResult: unknown
  try {
    rawResult = await (
      rpc as (this: unknown, name: string, args: Record<string, unknown>) => Promise<unknown>
    ).call(client, RPC_BY_OPERATION[operation], {
      p_upload_id: identity.uploadId,
      p_owner_id: identity.ownerId,
      p_object_name: identity.objectName,
      p_purpose: identity.purpose,
      p_mime_type: identity.mimeType,
      p_size_bytes: identity.sizeBytes,
    })
  } catch (error) {
    return { outcome: 'ambiguous', reason: 'rpc_ambiguous', error }
  }

  if (!isRecord(rawResult) || !Object.prototype.hasOwnProperty.call(rawResult, 'error')) {
    return {
      outcome: 'ambiguous',
      reason: 'invalid_result',
    }
  }
  if (rawResult.error !== null) {
    // Only a PostgreSQL SQLSTATE proves the database answered and rolled the
    // statement back. Fetch/PostgREST failures can also be wrapped in an
    // `error` field and therefore remain commit-ambiguous.
    if (isConclusiveDatabaseRejection(rawResult)) {
      return { outcome: 'rejected', reason: 'rpc_rejected', error: rawResult.error }
    }
    return { outcome: 'ambiguous', reason: 'invalid_result', error: rawResult.error }
  }
  if (
    !Number.isInteger(rawResult.status) ||
    Number(rawResult.status) < 200 ||
    Number(rawResult.status) > 299 ||
    typeof rawResult.statusText !== 'string'
  ) {
    return { outcome: 'ambiguous', reason: 'invalid_result' }
  }
  const replayed = readReceiptReplay(rawResult.data, operation, identity)
  if (replayed === null) {
    return { outcome: 'ambiguous', reason: 'invalid_receipt' }
  }
  if (replayed && !allowReplay) {
    return { outcome: 'unexpected_replay', reason: 'unexpected_replay' }
  }

  return { outcome: 'confirmed' }
}

async function mutatePostMediaUploadRegistry(
  client: unknown,
  operation: RegistryOperation,
  identity: PostMediaUploadRegistryIdentity
): Promise<PostMediaUploadRegistryResult> {
  const firstAttempt = await attemptPostMediaUploadRegistryMutation(
    client,
    operation,
    identity,
    false
  )
  if (firstAttempt.outcome === 'confirmed') return { ok: true }
  if (firstAttempt.outcome === 'unexpected_replay') {
    return {
      ok: false,
      reason: firstAttempt.reason,
      canCleanupObject: false,
    }
  }
  if (firstAttempt.outcome === 'rejected') {
    return {
      ok: false,
      reason: firstAttempt.reason,
      canCleanupObject: true,
      error: firstAttempt.error,
    }
  }

  // A thrown request or malformed success may have committed before its HTTP
  // response was lost. Retry the exact identity once. Only this confirmation
  // path accepts a replayed receipt; an exact first-attempt replay fails
  // immediately as a stale request identity.
  const confirmationAttempt = await attemptPostMediaUploadRegistryMutation(
    client,
    operation,
    identity,
    true
  )
  if (confirmationAttempt.outcome === 'confirmed') return { ok: true }

  return {
    ok: false,
    reason: confirmationAttempt.reason,
    canCleanupObject: false,
    error: confirmationAttempt.error,
  }
}

export function reservePostMediaUpload(
  client: unknown,
  identity: PostMediaUploadRegistryIdentity
): Promise<PostMediaUploadRegistryResult> {
  return mutatePostMediaUploadRegistry(client, 'reserve', identity)
}

export function finalizePostMediaUpload(
  client: unknown,
  identity: PostMediaUploadRegistryIdentity
): Promise<PostMediaUploadRegistryResult> {
  return mutatePostMediaUploadRegistry(client, 'finalize', identity)
}
