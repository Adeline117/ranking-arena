#!/usr/bin/env node
/* eslint-disable no-console -- repository architecture gate */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const DEFAULT_BASELINE = 'scripts/qa/architecture-boundary-baseline.json'
const SOURCE_ROOTS = ['app', 'lib', 'worker']
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx'])

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function trackedAndUntrackedSources(root) {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...SOURCE_ROOTS],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  )

  return output
    .split('\0')
    .filter(Boolean)
    .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)))
    .filter((file) => existsSync(path.join(root, file)))
    .sort()
}

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) {
    return ts.ScriptKind.JS
  }
  return ts.ScriptKind.TS
}

function stringArgument(node) {
  return ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null
}

export function collectModuleSpecifiers(source, file = 'source.ts') {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file))
  const imports = []

  function record(node, kind) {
    const specifier = stringArgument(node)
    if (!specifier) return
    const position = parsed.getLineAndCharacterOfPosition(node.getStart(parsed))
    imports.push({ kind, line: position.line + 1, specifier })
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier)
        record(node.moduleSpecifier, ts.isImportDeclaration(node) ? 'import' : 'export')
    } else if (ts.isCallExpression(node) && node.arguments.length === 1) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        record(node.arguments[0], 'dynamic-import')
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        record(node.arguments[0], 'require')
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      record(node.argument.literal, 'import-type')
    }
    ts.forEachChild(node, visit)
  }

  visit(parsed)
  return imports
}

export function resolveRepositoryTarget(source, specifier) {
  if (specifier.startsWith('@/')) return specifier.slice(2)
  if (!specifier.startsWith('.')) return null

  const target = path.posix.normalize(path.posix.join(path.posix.dirname(source), specifier))
  return target.startsWith('../') ? null : target
}

export function classifyBoundary(source, target) {
  if (!target) return null

  const sourceRoot = source.split('/')[0]
  if (!SOURCE_ROOTS.includes(sourceRoot)) return null

  if (sourceRoot === 'lib' && (target === 'app' || target.startsWith('app/'))) {
    return 'lib-must-not-import-app'
  }
  if (sourceRoot === 'lib' && (target === 'worker' || target.startsWith('worker/'))) {
    return 'lib-must-not-import-worker'
  }
  if (sourceRoot === 'worker' && (target === 'app' || target.startsWith('app/'))) {
    return 'worker-must-not-import-app'
  }
  if (
    sourceRoot === 'app' &&
    !source.startsWith('app/api/') &&
    (target === 'app/api' || target.startsWith('app/api/'))
  ) {
    return 'app-ui-must-not-import-api-route'
  }
  if (sourceRoot === 'app' && (target === 'worker' || target.startsWith('worker/'))) {
    return 'app-must-not-import-worker'
  }
  if (target === 'scripts' || target.startsWith('scripts/')) {
    return 'runtime-must-not-import-scripts'
  }
  if (target === 'connectors' || target.startsWith('connectors/')) {
    return 'runtime-must-not-import-legacy-connectors'
  }
  if (target === 'workers' || target.startsWith('workers/')) {
    return 'runtime-must-not-import-legacy-workers'
  }
  return null
}

export function violationKey(violation) {
  return `${violation.rule}\0${violation.source}\0${violation.specifier}`
}

export async function scanArchitecture(root) {
  const violations = []

  for (const source of trackedAndUntrackedSources(root)) {
    const contents = await readFile(path.join(root, source), 'utf8')
    for (const dependency of collectModuleSpecifiers(contents, source)) {
      const target = resolveRepositoryTarget(source, dependency.specifier)
      const rule = classifyBoundary(source, target)
      if (!rule) continue
      violations.push({
        rule,
        source: toPosix(source),
        specifier: dependency.specifier,
        line: dependency.line,
        kind: dependency.kind,
      })
    }
  }

  return violations.sort((a, b) => violationKey(a).localeCompare(violationKey(b)))
}

async function readBaseline(root, baselinePath) {
  const body = JSON.parse(await readFile(path.join(root, baselinePath), 'utf8'))
  if (body.version !== 1 || !Array.isArray(body.violations)) {
    throw new Error(`Unsupported architecture baseline format: ${baselinePath}`)
  }
  return body.violations
}

function printable(violation) {
  return `${violation.rule}: ${violation.source}:${violation.line ?? '?'} -> ${violation.specifier}`
}

async function main() {
  const root = process.cwd()
  const baselinePath = process.env.ARCHITECTURE_BASELINE || DEFAULT_BASELINE
  const violations = await scanArchitecture(root)

  if (process.argv.includes('--write-baseline')) {
    const baseline = {
      version: 1,
      violations: violations.map(({ rule, source, specifier }) => ({ rule, source, specifier })),
    }
    await writeFile(path.join(root, baselinePath), `${JSON.stringify(baseline, null, 2)}\n`)
    console.log(`Architecture baseline updated: ${violations.length} violations`)
    return
  }

  const baseline = await readBaseline(root, baselinePath)
  const currentByKey = new Map(violations.map((violation) => [violationKey(violation), violation]))
  const baselineByKey = new Map(baseline.map((violation) => [violationKey(violation), violation]))
  const added = violations.filter((violation) => !baselineByKey.has(violationKey(violation)))
  const resolved = baseline.filter((violation) => !currentByKey.has(violationKey(violation)))

  if (added.length || resolved.length) {
    console.error('Architecture boundary check failed.')
    if (added.length) {
      console.error('\nNew forbidden dependencies:')
      for (const violation of added) console.error(`- ${printable(violation)}`)
    }
    if (resolved.length) {
      console.error('\nResolved baseline entries (remove them from the baseline):')
      for (const violation of resolved) console.error(`- ${printable(violation)}`)
    }
    console.error('\nRun with --write-baseline only after reviewing the complete diff.')
    process.exit(1)
  }

  console.log(
    `Architecture boundary check passed: ${violations.length} known violations, no new dependency inversions.`
  )
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
