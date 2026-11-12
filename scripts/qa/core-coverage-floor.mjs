#!/usr/bin/env node
// Holds core-path files to a coverage floor. The repository-wide percentage can
// stay flat while a core file loses all of its tests; this cannot. Raise a floor
// after adding tests. Lowering one needs a reason in the pull request.
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..', '..')

export function findViolations(summary, floors, root = ROOT) {
  const byPath = new Map(
    Object.entries(summary)
      .filter(([key]) => key !== 'total')
      .map(([key, value]) => [relative(root, key), value])
  )
  const violations = []
  for (const [file, floor] of Object.entries(floors)) {
    const actual = byPath.get(file)
    if (!actual) {
      violations.push(`${file}: missing from the coverage report`)
      continue
    }
    for (const metric of Object.keys(floor)) {
      if (actual[metric].pct < floor[metric]) {
        violations.push(`${file}: ${metric} ${actual[metric].pct}% is below ${floor[metric]}%`)
      }
    }
  }
  return violations
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const summary = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  const { floors } = JSON.parse(
    readFileSync(resolve(import.meta.dirname, 'core-coverage-floor.json'), 'utf8')
  )
  const violations = findViolations(summary, floors)
  if (violations.length > 0) {
    console.error(`Core path coverage dropped:\n${violations.join('\n')}`)
    process.exit(1)
  }
  console.log(`Core path coverage floor holds for ${Object.keys(floors).length} files`)
}
