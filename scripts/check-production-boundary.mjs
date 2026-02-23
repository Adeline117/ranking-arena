#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = new URL('./', import.meta.url)
const allowlistPath = new URL('./PRODUCTION_ALLOWLIST.json', import.meta.url)
const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'))

const files = fs.readdirSync(scriptsDir).filter((name) => {
  const full = path.join(fileURLToPath(scriptsDir), name)
  return fs.statSync(full).isFile() && (name.endsWith('.mjs') || name.endsWith('.sh'))
})

const nonAllowed = files.filter((file) => !allowlist.allowed.includes(file))

console.log(`[boundary] production-allowed scripts: ${allowlist.allowed.length}`)
console.log(`[boundary] local scripts scanned: ${files.length}`)
if (nonAllowed.length > 0) {
  console.log('[boundary] non-production scripts (explicitly NOT prod-safe by default):')
  for (const f of nonAllowed.sort()) console.log(`  - ${f}`)
}
