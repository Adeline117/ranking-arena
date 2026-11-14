#!/usr/bin/env node
/**
 * Fails when a tracked file contains a live-looking server secret literal.
 *
 * Why: the repository is public. Earlier history committed Supabase
 * service_role JWTs as `process.env.X || '<key>'` fallbacks in scripts; any key
 * that lands in a commit is readable by anyone, forever. GitHub push protection
 * does not reliably recognise legacy Supabase JWTs, so this guard checks them by
 * decoding the payload role rather than by prefix alone.
 *
 * Scope is deliberately narrow (no entropy heuristics) so it never needs an
 * allowlist: public keys (Supabase anon/publishable) and placeholders pass.
 *
 * Usage: node scripts/qa/secret-literal-guard.mjs   (scans `git ls-files`)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'

const MAX_FILE_BYTES = 2 * 1024 * 1024

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{20,}/g
const SUPABASE_SECRET = /\bsb_secret_[A-Za-z0-9_-]{20,}/g
const STRIPE_LIVE = /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g
const STRIPE_WEBHOOK = /\bwhsec_[A-Za-z0-9]{24,}/g
const PEM_BODY =
  /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\s*(?:[A-Za-z0-9+/=]{40,}\s*){3,}/g

/**
 * Documentation/test placeholders: a run of one character (sk_live_xxxxxxxx),
 * an alphabet or digit sequence (whsec_ABCDEFGH…), or a self-describing word.
 */
function isPlaceholder(value) {
  return (
    /(.)\1{5,}/.test(value) ||
    /ABCDEFGH|abcdefgh|12345678/.test(value) ||
    /example|placeholder|dummy|fake/i.test(value)
  )
}

function jwtRole(payloadSegment) {
  try {
    const json = Buffer.from(payloadSegment, 'base64url').toString('utf8')
    return JSON.parse(json).role ?? null
  } catch {
    return null
  }
}

/** Returns findings for one file's text: [{ line, kind }]. Never returns the secret. */
export function scanText(text) {
  const findings = []
  const lineOf = (index) => text.slice(0, index).split('\n').length

  for (const match of text.matchAll(JWT)) {
    if (jwtRole(match[1]) === 'service_role') {
      findings.push({ line: lineOf(match.index), kind: 'Supabase service_role JWT' })
    }
  }
  const simple = [
    [SUPABASE_SECRET, 'Supabase secret key (sb_secret_)'],
    [STRIPE_LIVE, 'Stripe live secret key'],
    [STRIPE_WEBHOOK, 'Stripe webhook signing secret'],
    [PEM_BODY, 'PEM private key'],
  ]
  for (const [pattern, kind] of simple) {
    for (const match of text.matchAll(pattern)) {
      if (!isPlaceholder(match[0])) findings.push({ line: lineOf(match.index), kind })
    }
  }
  return findings
}

function main() {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  const problems = []
  for (const file of files) {
    let size
    try {
      size = statSync(file).size
    } catch {
      continue // deleted in the working tree
    }
    if (size > MAX_FILE_BYTES) continue
    const buffer = readFileSync(file)
    if (buffer.includes(0)) continue // binary
    for (const finding of scanText(buffer.toString('utf8'))) {
      problems.push(`${file}:${finding.line} ${finding.kind}`)
    }
  }
  if (problems.length > 0) {
    console.error('Secret literal guard: server secrets must come from the environment.')
    for (const problem of problems) console.error(`  ${problem}`)
    console.error('Remove the literal and rotate the key: the repository is public.')
    process.exit(1)
  }
  console.log(`Secret literal guard: ${files.length} tracked files clean.`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
