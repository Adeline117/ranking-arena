#!/usr/bin/env node
/**
 * Supabase generated-type bypass ratchet.
 *
 * Production code is gated independently in three categories so deleting a
 * test mock (or one kind of bypass) cannot hide a new runtime bypass:
 *
 * 1. `as SupabaseClient` without `<Database>` strips the generated schema.
 * 2. `as any` on a Supabase `.from()` / `.rpc()` query receiver, argument, or
 *    whole query strips table, column, RPC argument, or result contracts.
 * 3. `as never` on RPC name/argument positions defeats generated RPC types.
 *
 * Test fixtures are reported separately but do not consume runtime budgets.
 * This scanner uses the TypeScript AST, counts cast nodes rather than lines,
 * and follows multiline query chains.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

export const RUNTIME_BASELINES = Object.freeze({
  bareSupabaseClient: 83,
  dbAny: 15,
  rpcNever: 0,
})

const CATEGORY_LABELS = Object.freeze({
  bareSupabaseClient: 'bare SupabaseClient',
  dbAny: 'Supabase query as any',
  rpcNever: 'RPC name/args as never',
})

const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const DIRS = ['app', 'lib']
const TEST_PATH_RE =
  /(?:^|\/)(?:__tests__|__mocks__|test|tests|fixtures)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/

function emptyCounts() {
  return {
    bareSupabaseClient: 0,
    dbAny: 0,
    rpcNever: 0,
  }
}

export function isTestFile(relativePath) {
  return TEST_PATH_RE.test(relativePath.replaceAll('\\', '/'))
}

function isCastExpression(node) {
  return ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
}

function rightmostTypeName(typeName) {
  let current = typeName
  while (ts.isQualifiedName(current)) current = current.right
  return ts.isIdentifier(current) ? current.text : null
}

function isBareSupabaseClientCast(node) {
  if (!isCastExpression(node) || !ts.isTypeReferenceNode(node.type)) return false
  return (
    rightmostTypeName(node.type.typeName) === 'SupabaseClient' &&
    (node.type.typeArguments?.length ?? 0) === 0
  )
}

function isAnyCast(node) {
  return isCastExpression(node) && node.type.kind === ts.SyntaxKind.AnyKeyword
}

function isNeverCast(node) {
  return isCastExpression(node) && node.type.kind === ts.SyntaxKind.NeverKeyword
}

function unwrapParentheses(node) {
  let current = node
  while (
    current.parent &&
    ts.isParenthesizedExpression(current.parent) &&
    current.parent.expression === current
  ) {
    current = current.parent
  }
  return current
}

function stripExpressionWrappers(node) {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAwaitExpression(current) ||
    ts.isNonNullExpression(current) ||
    isCastExpression(current)
  ) {
    current = current.expression
  }
  return current
}

/**
 * Follow only the receiver side of a fluent call chain. Arguments are
 * deliberately ignored so an unrelated callback containing `.from()` cannot
 * make its enclosing expression look like a Supabase query.
 */
function queryChainHasSupabaseRoot(node) {
  const current = stripExpressionWrappers(node)

  if (ts.isCallExpression(current)) {
    if (ts.isPropertyAccessExpression(current.expression)) {
      const method = current.expression.name.text
      if (method === 'from' || method === 'rpc') return true
      return queryChainHasSupabaseRoot(current.expression.expression)
    }
    return queryChainHasSupabaseRoot(current.expression)
  }

  if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    return queryChainHasSupabaseRoot(current.expression)
  }

  return false
}

function isSupabaseDbAnyCast(node) {
  if (!isAnyCast(node)) return false

  // `(await supabase.from(...).select(...)) as any`
  if (queryChainHasSupabaseRoot(node.expression)) return true

  // `(supabase as any)\n  .from(...)` and `(supabase as any).rpc(...)`
  const outer = unwrapParentheses(node)
  const receiverProperty = outer.parent
  if (
    receiverProperty &&
    ts.isPropertyAccessExpression(receiverProperty) &&
    receiverProperty.expression === outer &&
    (receiverProperty.name.text === 'from' || receiverProperty.name.text === 'rpc') &&
    receiverProperty.parent &&
    ts.isCallExpression(receiverProperty.parent) &&
    receiverProperty.parent.expression === receiverProperty
  ) {
    return true
  }

  // `.insert(payload as any)`, `.is(column as any, ...)`, and RPC arguments.
  const parentCall = outer.parent
  if (
    parentCall &&
    ts.isCallExpression(parentCall) &&
    parentCall.arguments.includes(outer) &&
    ts.isPropertyAccessExpression(parentCall.expression)
  ) {
    const method = parentCall.expression.name.text
    return (
      method === 'from' ||
      method === 'rpc' ||
      queryChainHasSupabaseRoot(parentCall.expression.expression)
    )
  }

  return false
}

function isRpcNeverCast(node) {
  if (!isNeverCast(node)) return false
  const outer = unwrapParentheses(node)
  const parentCall = outer.parent
  if (
    !parentCall ||
    !ts.isCallExpression(parentCall) ||
    !ts.isPropertyAccessExpression(parentCall.expression) ||
    parentCall.expression.name.text !== 'rpc'
  ) {
    return false
  }
  const argumentIndex = parentCall.arguments.indexOf(outer)
  return argumentIndex === 0 || argumentIndex === 1
}

function diagnosticMessage(diagnostic, sourceFile) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  if (diagnostic.start === undefined) return message
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(diagnostic.start)
  return `${line + 1}:${character + 1} ${message}`
}

function hitFor(category, node, sourceFile, relativePath) {
  const start = node.getStart(sourceFile)
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(start)
  return {
    category,
    file: relativePath.replaceAll('\\', '/'),
    line: line + 1,
    column: character + 1,
    text: node.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 180),
  }
}

export function scanSupabaseCasts(source, relativePath = 'fixture.ts') {
  const scriptKind = relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  )
  const parseErrors = (sourceFile.parseDiagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  )
  if (parseErrors.length > 0) {
    throw new SyntaxError(
      `Unable to parse ${relativePath}: ${parseErrors
        .map((diagnostic) => diagnosticMessage(diagnostic, sourceFile))
        .join('; ')}`
    )
  }

  const hits = []
  function visit(node) {
    if (isBareSupabaseClientCast(node)) {
      hits.push(hitFor('bareSupabaseClient', node, sourceFile, relativePath))
    }
    if (isSupabaseDbAnyCast(node)) {
      hits.push(hitFor('dbAny', node, sourceFile, relativePath))
    }
    if (isRpcNeverCast(node)) {
      hits.push(hitFor('rpcNever', node, sourceFile, relativePath))
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  return {
    file: relativePath.replaceAll('\\', '/'),
    scope: isTestFile(relativePath) ? 'test' : 'runtime',
    hits,
  }
}

export function summarizeScans(scans) {
  const summary = {
    runtime: { counts: emptyCounts(), hits: [] },
    test: { counts: emptyCounts(), hits: [] },
  }

  for (const scan of scans) {
    if (scan.scope !== 'runtime' && scan.scope !== 'test') {
      throw new Error(`Unknown scan scope for ${scan.file}: ${String(scan.scope)}`)
    }
    const bucket = summary[scan.scope]
    for (const hit of scan.hits) {
      if (!(hit.category in bucket.counts)) {
        throw new Error(`Unknown Supabase cast category: ${String(hit.category)}`)
      }
      bucket.counts[hit.category] += 1
      bucket.hits.push(hit)
    }
  }

  return summary
}

function walk(dir, acc = []) {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue
      walk(absolutePath, acc)
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      acc.push(absolutePath)
    }
  }
  return acc
}

export function scanRepository(repo = REPO) {
  const files = DIRS.flatMap((dir) => walk(path.join(repo, dir)))
  const scans = files.map((absolutePath) => {
    const relativePath = path.relative(repo, absolutePath)
    return scanSupabaseCasts(fs.readFileSync(absolutePath, 'utf8'), relativePath)
  })
  return summarizeScans(scans)
}

export function evaluateRuntimeCounts(counts, baselines = RUNTIME_BASELINES) {
  const failures = []
  const improvements = []

  for (const category of Object.keys(RUNTIME_BASELINES)) {
    const count = counts[category]
    const baseline = baselines[category]
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`Invalid runtime count for ${category}: ${String(count)}`)
    }
    if (!Number.isInteger(baseline) || baseline < 0) {
      throw new Error(`Invalid runtime baseline for ${category}: ${String(baseline)}`)
    }
    if (count > baseline) failures.push({ category, count, baseline })
    if (count < baseline) improvements.push({ category, count, baseline })
  }

  return {
    ok: failures.length === 0,
    failures,
    improvements,
  }
}

function formatCounts(counts) {
  return Object.keys(RUNTIME_BASELINES)
    .map((category) => `${category}=${counts[category]}`)
    .join(', ')
}

export function runCli(repo = REPO) {
  const summary = scanRepository(repo)
  const evaluation = evaluateRuntimeCounts(summary.runtime.counts)

  if (!evaluation.ok) {
    console.error('\n❌ Supabase generated-type bypass ratchet failed.')
    for (const failure of evaluation.failures) {
      console.error(
        `   ${CATEGORY_LABELS[failure.category]}: ${failure.count} > baseline ${failure.baseline} ` +
          `(+${failure.count - failure.baseline})`
      )
      const categoryHits = summary.runtime.hits.filter((hit) => hit.category === failure.category)
      for (const hit of categoryHits.slice(0, 12)) {
        console.error(`     ${hit.file}:${hit.line}:${hit.column}  ${hit.text}`)
      }
      if (categoryHits.length > 12) {
        console.error(`     … (+${categoryHits.length - 12})`)
      }
    }
    console.error(
      '   Keep SupabaseClient<Database>; remove query/RPC casts and fix the generated contract error.\n'
    )
    return 1
  }

  console.log(
    `✅ Supabase generated-type bypass ratchet: ${formatCounts(summary.runtime.counts)} ` +
      `(tests excluded: ${formatCounts(summary.test.counts)})`
  )
  for (const improvement of evaluation.improvements) {
    console.log(
      `   ↓ ${CATEGORY_LABELS[improvement.category]} is ${improvement.count}; ` +
        `lower its baseline from ${improvement.baseline} in a dedicated QA change.`
    )
  }
  return 0
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null
if (invokedPath === import.meta.url) {
  try {
    process.exitCode = runCli()
  } catch (error) {
    console.error(
      `\n❌ Supabase generated-type bypass scan could not complete: ${
        error instanceof Error ? error.stack || error.message : String(error)
      }`
    )
    process.exitCode = 1
  }
}
