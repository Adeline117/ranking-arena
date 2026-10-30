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
const ROOT_RUNTIME_SOURCE_PATHS = [
  'instrumentation.ts',
  'proxy.ts',
  'sentry.client.config.ts',
  'sentry.edge.config.ts',
  'sentry.server.config.ts',
]
const ROOT_RUNTIME_SOURCES = new Set(ROOT_RUNTIME_SOURCE_PATHS)
const ROOT_RUNTIME_TARGETS = new Set(
  ROOT_RUNTIME_SOURCE_PATHS.flatMap((source) => [source, source.replace(/\.[^.]+$/u, '')])
)
const SOURCE_PATHS = [...SOURCE_ROOTS, ...ROOT_RUNTIME_SOURCE_PATHS]
const REPOSITORY_IMPORT_ROOTS = new Set([...SOURCE_ROOTS, 'connectors', 'scripts', 'workers'])
const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function trackedAndUntrackedSources(root) {
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...SOURCE_PATHS],
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

  if (parsed.parseDiagnostics.length > 0) {
    const diagnostic = parsed.parseDiagnostics[0]
    const position = parsed.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    throw new Error(
      `Cannot parse ${file}:${position.line + 1}:${position.character + 1}: ${message}`
    )
  }

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
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    ) {
      record(node.moduleReference.expression, 'import-equals')
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length >= 1) {
        record(node.arguments[0], 'dynamic-import')
      } else if (
        node.arguments.length === 1 &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require'
      ) {
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
  let candidate
  if (specifier.startsWith('@/')) {
    candidate = specifier.slice(2).replace(/^\/+/, '')
  } else if (specifier.startsWith('.')) {
    candidate = path.posix.join(path.posix.dirname(source), specifier)
  } else if (
    REPOSITORY_IMPORT_ROOTS.has(specifier.split('/')[0]) ||
    ROOT_RUNTIME_TARGETS.has(specifier)
  ) {
    candidate = specifier
  } else {
    return null
  }

  const target = path.posix.normalize(candidate)
  return target === '..' || target.startsWith('../') || path.posix.isAbsolute(target)
    ? null
    : target
}

export function classifyBoundary(source, target) {
  if (!target) return null

  const sourceRoot = source.split('/')[0]
  const rootRuntimeSource = ROOT_RUNTIME_SOURCES.has(source)
  if (!SOURCE_ROOTS.includes(sourceRoot) && !rootRuntimeSource) return null

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
  if (rootRuntimeSource && (target === 'app' || target.startsWith('app/'))) {
    return 'root-runtime-must-not-import-app'
  }
  if (rootRuntimeSource && (target === 'worker' || target.startsWith('worker/'))) {
    return 'root-runtime-must-not-import-worker'
  }
  if (!rootRuntimeSource && ROOT_RUNTIME_TARGETS.has(target)) {
    return 'runtime-module-must-not-import-root-entrypoint'
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
  const violations = new Map()

  for (const source of trackedAndUntrackedSources(root)) {
    const contents = await readFile(path.join(root, source), 'utf8')
    for (const dependency of collectModuleSpecifiers(contents, source)) {
      const target = resolveRepositoryTarget(source, dependency.specifier)
      const rule = classifyBoundary(source, target)
      if (!rule) continue
      const violation = {
        rule,
        source: toPosix(source),
        specifier: dependency.specifier,
        line: dependency.line,
        kind: dependency.kind,
      }
      const key = violationKey(violation)
      if (!violations.has(key)) violations.set(key, violation)
    }
  }

  return [...violations.values()].sort((a, b) => violationKey(a).localeCompare(violationKey(b)))
}

export function normalizeArchitectureBaseline(body, baselinePath = DEFAULT_BASELINE) {
  if (!body || typeof body !== 'object' || body.version !== 1 || !Array.isArray(body.violations)) {
    throw new Error(`Unsupported architecture baseline format: ${baselinePath}`)
  }

  const seen = new Set()
  return body.violations.map((violation, index) => {
    if (
      !violation ||
      typeof violation.rule !== 'string' ||
      violation.rule.length === 0 ||
      typeof violation.source !== 'string' ||
      violation.source.length === 0 ||
      typeof violation.specifier !== 'string' ||
      violation.specifier.length === 0
    ) {
      throw new Error(`Invalid architecture baseline entry ${index + 1}: ${baselinePath}`)
    }

    const normalized = {
      rule: violation.rule,
      source: violation.source,
      specifier: violation.specifier,
    }
    const key = violationKey(normalized)
    if (seen.has(key)) {
      throw new Error(`Duplicate architecture baseline entry ${index + 1}: ${baselinePath}`)
    }
    seen.add(key)
    return normalized
  })
}

export function baselineAdditions(current, previous) {
  const previousKeys = new Set(previous.map(violationKey))
  return current.filter((violation) => !previousKeys.has(violationKey(violation)))
}

async function readBaseline(root, baselinePath) {
  const body = JSON.parse(await readFile(path.join(root, baselinePath), 'utf8'))
  return normalizeArchitectureBaseline(body, baselinePath)
}

function readBaselineAtRef(root, baselinePath, ref) {
  let contents
  try {
    contents = execFileSync('git', ['show', `${ref}:${baselinePath}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    try {
      execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], {
        cwd: root,
        stdio: ['ignore', 'ignore', 'ignore'],
      })
    } catch {
      throw new Error(`Cannot resolve architecture baseline base ref: ${ref}`, { cause: error })
    }
    return null
  }

  return normalizeArchitectureBaseline(JSON.parse(contents), `${ref}:${baselinePath}`)
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
  const baseRef = process.env.ARCHITECTURE_BASE_REF?.trim()
  if (baseRef) {
    const previousBaseline = readBaselineAtRef(root, baselinePath, baseRef)
    if (previousBaseline) {
      const additions = baselineAdditions(baseline, previousBaseline)
      if (additions.length > 0) {
        console.error('Architecture baseline may only shrink; new waivers are forbidden:')
        for (const violation of additions) console.error(`- ${printable(violation)}`)
        process.exit(1)
      }
    }
  }
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
