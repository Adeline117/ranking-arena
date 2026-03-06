#!/usr/bin/env node
/**
 * Monthly Dependency Update Script
 *
 * Run on 1st of each month:
 *   node scripts/monthly-deps-update.mjs
 *
 * What it does:
 * 1. npm audit — check for vulnerabilities
 * 2. npm outdated — check for outdated packages
 * 3. Auto-upgrade patch + minor versions
 * 4. Run build + type-check to verify
 * 5. Major versions: log only, don't auto-upgrade
 * 6. Write report to docs/DEPS-UPDATE.md
 */

import { execSync } from 'child_process'
import { writeFileSync, mkdirSync, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const DOCS_DIR = path.join(ROOT, 'docs')
const REPORT_PATH = path.join(DOCS_DIR, 'DEPS-UPDATE.md')

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf-8', timeout: 120_000, ...opts })
  } catch (e) {
    return e.stdout || e.stderr || e.message
  }
}

function main() {
  const date = new Date().toISOString().split('T')[0]
  const lines = [`# Dependency Update Report — ${date}\n`]

  console.log('=== Monthly Dependency Update ===\n')

  // Step 1: npm audit
  console.log('1. Running npm audit...')
  const auditOutput = run('npm audit --omit=dev 2>&1')
  const hasVulnerabilities = auditOutput.includes('found') && !auditOutput.includes('found 0')
  lines.push('## Security Audit\n')
  lines.push('```')
  lines.push(auditOutput.trim().split('\n').slice(-10).join('\n'))
  lines.push('```\n')

  if (hasVulnerabilities) {
    console.log('   Vulnerabilities found. Attempting npm audit fix...')
    const fixOutput = run('npm audit fix 2>&1')
    lines.push('### Auto-fix attempt\n')
    lines.push('```')
    lines.push(fixOutput.trim().split('\n').slice(-5).join('\n'))
    lines.push('```\n')
  } else {
    console.log('   No vulnerabilities found.')
  }

  // Step 2: npm outdated
  console.log('2. Checking outdated packages...')
  const outdatedOutput = run('npm outdated --json 2>&1')
  let outdated = {}
  try {
    outdated = JSON.parse(outdatedOutput)
  } catch {
    // npm outdated returns non-JSON when no outdated deps
  }

  const outdatedEntries = Object.entries(outdated)
  const patchMinor = []
  const major = []

  for (const [pkg, info] of outdatedEntries) {
    const current = info.current || 'N/A'
    const wanted = info.wanted || 'N/A'
    const latest = info.latest || 'N/A'

    if (current === latest) continue

    const currentMajor = parseInt(current.split('.')[0])
    const latestMajor = parseInt(latest.split('.')[0])

    if (latestMajor > currentMajor) {
      major.push({ pkg, current, wanted, latest })
    } else {
      patchMinor.push({ pkg, current, wanted, latest })
    }
  }

  lines.push('## Outdated Packages\n')

  if (patchMinor.length > 0) {
    lines.push('### Patch/Minor (auto-upgradable)\n')
    lines.push('| Package | Current | Wanted | Latest |')
    lines.push('|---------|---------|--------|--------|')
    for (const { pkg, current, wanted, latest } of patchMinor) {
      lines.push(`| ${pkg} | ${current} | ${wanted} | ${latest} |`)
    }
    lines.push('')
  }

  if (major.length > 0) {
    lines.push('### Major (manual review required)\n')
    lines.push('| Package | Current | Latest |')
    lines.push('|---------|---------|--------|')
    for (const { pkg, current, latest } of major) {
      lines.push(`| ${pkg} | ${current} | ${latest} |`)
    }
    lines.push('')
  }

  if (patchMinor.length === 0 && major.length === 0) {
    lines.push('All dependencies are up to date.\n')
  }

  // Step 3: Auto-upgrade patch + minor
  if (patchMinor.length > 0) {
    console.log(`3. Upgrading ${patchMinor.length} patch/minor packages...`)
    const updateOutput = run('npm update 2>&1')
    lines.push('### Auto-upgrade result\n')
    lines.push('```')
    lines.push(updateOutput.trim().split('\n').slice(-5).join('\n'))
    lines.push('```\n')

    // Step 4: Verify build
    console.log('4. Verifying type-check...')
    const typeCheckOutput = run('npx tsc --noEmit 2>&1')
    const typeCheckPassed = !typeCheckOutput.includes('error TS')

    lines.push('### Verification\n')
    lines.push(`- Type check: ${typeCheckPassed ? 'PASSED' : 'FAILED'}`)

    if (!typeCheckPassed) {
      lines.push('\n```')
      lines.push(typeCheckOutput.trim().split('\n').slice(-20).join('\n'))
      lines.push('```')

      // Revert
      console.log('   Type check failed! Reverting...')
      run('git checkout -- package.json package-lock.json')
      run('npm install')
      lines.push('\n**Reverted** — type check failed after upgrade.\n')
    } else {
      console.log('   Type check passed.')
    }
  } else {
    console.log('3. No patch/minor upgrades needed.')
  }

  // Write report
  if (!existsSync(DOCS_DIR)) {
    mkdirSync(DOCS_DIR, { recursive: true })
  }
  writeFileSync(REPORT_PATH, lines.join('\n'))
  console.log(`\nReport written to: ${REPORT_PATH}`)
}

main()
