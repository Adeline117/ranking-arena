const { createHash, timingSafeEqual } = require('node:crypto')

const MAX_CANDIDATE_LENGTH = 512

function normalize(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function loadProxyKeyConfig(env = process.env) {
  const legacy = normalize(env.PROXY_KEY)
  const current = normalize(env.PROXY_KEY_CURRENT) || legacy
  const next = normalize(env.PROXY_KEY_NEXT)
  const accepted = [...new Set([current, next].filter(Boolean))]

  if (accepted.length === 0) {
    throw new Error('PROXY_KEY_CURRENT, PROXY_KEY_NEXT, or legacy PROXY_KEY is required')
  }

  return Object.freeze({
    current,
    next,
    accepted: Object.freeze(accepted),
    // Clients move first by sending NEXT while servers accept both. Once every
    // client has rotated, operators remove CURRENT in a separate restart.
    preferred: next || current,
  })
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest()
}

function verifyProxyKey(candidate, acceptedKeys) {
  if (
    typeof candidate !== 'string' ||
    candidate.length === 0 ||
    candidate.length > MAX_CANDIDATE_LENGTH ||
    !Array.isArray(acceptedKeys) ||
    acceptedKeys.length === 0
  ) {
    return false
  }

  const candidateDigest = digest(candidate)
  let valid = 0
  for (const expected of acceptedKeys) {
    valid |= timingSafeEqual(candidateDigest, digest(expected)) ? 1 : 0
  }
  return valid === 1
}

module.exports = { loadProxyKeyConfig, verifyProxyKey }
