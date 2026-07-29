export const ATTEMPT_BOUND_CAPTURE_ENV = 'INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED' as const

function startupGateError(reason: string): Error {
  return new Error(`[ingest-worker] partitioned V4 startup gate failed closed: ${reason}`)
}

/**
 * This is an explicit rollout authority, not a feature default. Missing,
 * differently-cased, or otherwise truthy values must all fail closed.
 */
export function assertAttemptBoundCaptureRuntimeEnabled(
  env: Readonly<Record<string, string | undefined>>
): void {
  if (env[ATTEMPT_BOUND_CAPTURE_ENV] !== 'true') {
    throw startupGateError('attempt-bound capture must be explicitly enabled')
  }
}

export function assertAttemptBoundCaptureEnvironmentFile(loaded: {
  error?: Error
  parsed?: Record<string, string>
}): void {
  if (loaded.error !== undefined || loaded.parsed === undefined) {
    throw startupGateError('worker/.env is unavailable')
  }
  assertAttemptBoundCaptureRuntimeEnabled(loaded.parsed)
}
