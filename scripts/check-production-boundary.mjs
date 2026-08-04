#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_EXTENSIONS = new Set(['.mjs', '.sh'])
const scriptPath = fileURLToPath(import.meta.url)
const scriptsDir = path.dirname(scriptPath)
const allowlistPath = path.join(scriptsDir, 'PRODUCTION_ALLOWLIST.json')

export function validateProductionAllowlist(document, directory) {
  const errors = []

  if (document == null || typeof document !== 'object' || Array.isArray(document)) {
    return ['allowlist document must be a JSON object']
  }
  if (!Array.isArray(document.allowed)) {
    return ['allowlist.allowed must be an array']
  }
  if (document.allowed.length === 0) {
    errors.push('allowlist.allowed must not be empty')
  }

  const seen = new Set()
  const root = path.resolve(directory)

  for (const [index, entry] of document.allowed.entries()) {
    const label = `allowlist.allowed[${index}]`
    if (typeof entry !== 'string' || entry.length === 0 || entry.trim() !== entry) {
      errors.push(`${label} must be a non-empty trimmed string`)
      continue
    }
    if (seen.has(entry)) {
      errors.push(`${label} duplicates ${entry}`)
      continue
    }
    seen.add(entry)

    if (path.basename(entry) !== entry || path.dirname(path.resolve(root, entry)) !== root) {
      errors.push(`${label} must name a root-level script: ${entry}`)
      continue
    }
    if (!SCRIPT_EXTENSIONS.has(path.extname(entry))) {
      errors.push(`${label} must use a production script extension (.mjs or .sh): ${entry}`)
      continue
    }

    const fullPath = path.join(root, entry)
    let stat
    try {
      stat = fs.lstatSync(fullPath)
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        errors.push(`${label} does not exist: ${entry}`)
        continue
      }
      throw error
    }

    if (stat.isSymbolicLink()) {
      errors.push(`${label} must not be a symbolic link: ${entry}`)
    } else if (!stat.isFile()) {
      errors.push(`${label} must resolve to a regular file: ${entry}`)
    }
  }

  return errors
}

export function runBoundaryCheck({ directory = scriptsDir, manifestPath = allowlistPath } = {}) {
  let allowlist
  try {
    allowlist = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    console.error(
      `[boundary] invalid production allowlist: ${error instanceof Error ? error.message : String(error)}`
    )
    return 1
  }

  const errors = validateProductionAllowlist(allowlist, directory)
  if (errors.length > 0) {
    console.error('[boundary] production allowlist rejected:')
    for (const error of errors) console.error(`  - ${error}`)
    return 1
  }

  const files = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        SCRIPT_EXTENSIONS.has(path.extname(entry.name)) &&
        (entry.isFile() || entry.isSymbolicLink())
    )
    .map((entry) => entry.name)
  const allowed = new Set(allowlist.allowed)
  const nonAllowed = files.filter((file) => !allowed.has(file)).sort()

  console.log(`[boundary] production-allowed scripts: ${allowed.size}`)
  console.log(`[boundary] local scripts scanned: ${files.length}`)
  if (nonAllowed.length > 0) {
    console.log('[boundary] non-production scripts (reported only; never executed):')
    for (const file of nonAllowed) console.log(`  - ${file}`)
  }

  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  process.exitCode = runBoundaryCheck()
}
