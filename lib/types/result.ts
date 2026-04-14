/**
 * Discriminated result type for data layer functions.
 * Allows UI components to distinguish "no data" from "fetch failed".
 */
export type DataResult<T> =
  | { ok: true; data: T; error?: never }
  | { ok: false; data?: never; error: string }

export function success<T>(data: T): DataResult<T> {
  return { ok: true, data }
}

export function failure(error: string): DataResult<never> {
  return { ok: false, error }
}
