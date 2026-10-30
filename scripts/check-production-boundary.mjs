#!/usr/bin/env node
/**
 * Verify that the review manifest names only existing, top-level read-only
 * diagnostic scripts. This checker neither executes nor blocks any script.
 */

import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDirectory = fileURLToPath(new URL('./', import.meta.url))
const allowlistPath = fileURLToPath(new URL('./PRODUCTION_ALLOWLIST.json', import.meta.url))

export function validateAllowlist(allowed, directory) {
  const errors = []
  if (!Array.isArray(allowed) || allowed.some((entry) => typeof entry !== 'string')) {
    return ['allowed must be a non-empty array of script names']
  }
  if (allowed.length === 0) return ['allowed must not be empty']

  const duplicates = allowed.filter((entry, index) => allowed.indexOf(entry) !== index)
  if (duplicates.length > 0) {
    errors.push(`duplicate allowlist entries: ${[...new Set(duplicates)].join(', ')}`)
  }

  for (const entry of allowed) {
    if (entry !== basename(entry) || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:mjs|sh)$/.test(entry)) {
      errors.push(`invalid allowlist entry: ${entry}`)
      continue
    }

    const target = join(directory, entry)
    if (!existsSync(target)) {
      errors.push(`missing allowlist file: ${entry}`)
      continue
    }

    const status = lstatSync(target)
    if (!status.isFile() || status.isSymbolicLink()) {
      errors.push(`allowlist entry must be a regular file: ${entry}`)
    }
  }

  return errors
}

function main() {
  const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'))
  const errors = validateAllowlist(allowlist.allowed, scriptsDirectory)
  if (errors.length > 0) {
    for (const error of errors) console.error(`[boundary] ERROR: ${error}`)
    process.exitCode = 1
    return
  }

  const files = readdirSync(scriptsDirectory).filter((name) => {
    const target = join(scriptsDirectory, name)
    return statSync(target).isFile() && (name.endsWith('.mjs') || name.endsWith('.sh'))
  })
  const nonAllowed = files.filter((file) => !allowlist.allowed.includes(file)).sort()

  console.log(`[boundary] documented read-only diagnostics: ${allowlist.allowed.length}`)
  console.log(`[boundary] top-level scripts scanned: ${files.length}`)
  console.log(`[boundary] scripts outside allowlist: ${nonAllowed.length}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
