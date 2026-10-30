/**
 * Shared fail-closed credential detector for canonical-baseline artifacts.
 * It intentionally targets connection identifiers and credential formats,
 * while allowing ordinary public URLs and SQL identifiers such as `token`.
 */

export const BASELINE_CREDENTIAL_PATTERNS = Object.freeze([
  /\bpostgres(?:ql)?:\/\/[^\s'"<>]+/iu,
  /\brediss?:\/\/[^\s'"<>]+/iu,
  /\bhttps?:\/\/[a-z0-9-]+\.supabase\.co\b/iu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{12,}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /https:\/\/hooks\.slack\.com\/services\//iu,
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/u,
  /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/u,
  /\b(?:(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,})\b/u,
  /\b[A-Za-z0-9_-]*(?:password|passwd|pwd|secret|token)[A-Za-z0-9_-]*\s*(?::=|=>|=|:)\s*['"][A-Za-z0-9_+./=-]{16,}['"]/iu,
])

export function containsBaselineCredentialLikeData(contents) {
  if (typeof contents !== 'string') return true
  return BASELINE_CREDENTIAL_PATTERNS.some((pattern) => pattern.test(contents))
}
