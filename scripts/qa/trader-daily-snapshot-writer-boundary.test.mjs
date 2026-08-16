import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

const ROOT = resolve(import.meta.dirname, '../..')
const TARGET_TABLE = 'trader_daily_snapshots'
const GENERATED_TYPE_ALLOWLIST = new Set(['lib/supabase/database.types.ts'])
const MIGRATION_ROOT = 'supabase/migrations'
const MAINTENANCE_ALLOWLIST = new Map()
const READ_ONLY_ALLOWLIST = new Map(
  ['app/api/admin/observability/route.ts'].map((file) => [file, 1])
)

const RUNTIME_ROOTS = [
  'app',
  'cloudflare-worker',
  'connectors',
  'infra',
  'k6',
  'lib',
  'script',
  'scripts',
  'supabase/functions',
  'worker',
  'workers',
]
const CODE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])
const PLAIN_RUNTIME_EXTENSIONS = new Set(['.bash', '.sh', '.sql'])
const IGNORED_DIRECTORIES = new Set([
  '.next',
  '.turbo',
  '__fixtures__',
  '__integration__',
  '__tests__',
  'build',
  'coverage',
  'dist',
  'fixtures',
  'node_modules',
  'test-results',
  'tests',
])
const EXPLICIT_MUTATING_RPCS = new Set([
  // General-purpose dynamic SQL can bypass a target-specific static scan and
  // table ACL when deployed SECURITY DEFINER. It is retired for all runtime
  // callers, even when a particular call looks read-only.
  'exec_sql',
  // The production-generated type survived after the defining migration was
  // lost from repository history. Keep this explicit rather than trusting SQL
  // discovery alone.
  'cleanup_all_data_violations',
  // The former route used this as its fallback. It does not belong in the
  // retired repair chain even though its checked-in body targeted v2 history.
  'cleanup_snapshot_violations',
])
const MUTATION_METHODS = new Set(['delete', 'insert', 'update', 'upsert'])
const SQL_EXECUTOR_NAMES = new Set([
  '$executeRaw',
  '$queryRaw',
  'exec',
  'execute',
  'executeRaw',
  'query',
  'queryRaw',
  'unsafe',
])
const RETIRED_WRITER_HELPER =
  /^(?:persist|publish|save|store|write|insert|upsert|update|delete).*DailySnapshots?$/i
const TARGET_RELATION = String.raw`(?:(?:"public"|public)\s*\.\s*)?(?:"trader_daily_snapshots"|trader_daily_snapshots)(?![A-Za-z0-9_$])`
const TARGET_REFERENCE = new RegExp(TARGET_RELATION, 'i')
const ROW_DML = new RegExp(
  String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|COPY|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?${TARGET_RELATION}`,
  'i'
)
const STRICT_ANALYZE = new RegExp(String.raw`^\s*ANALYZE\s+${TARGET_RELATION}\s*;?\s*$`, 'i')
const REST_TARGET = /\/rest\/v1\/trader_daily_snapshots(?:[/?#]|$)/i

function normalizePath(path) {
  return path.replaceAll('\\', '/')
}

function isTestFile(file) {
  return (
    /(?:^|\/)(?:__fixtures__|__integration__|__tests__|fixtures|tests)(?:\/|$)/.test(file) ||
    /\.(?:fixture|spec|test)\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/.test(file)
  )
}

function productionFiles(directory) {
  const files = []
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    const file = normalizePath(relative(ROOT, path))
    const stat = statSync(path)
    if (stat.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(name) || file === 'scripts/qa') continue
      files.push(...productionFiles(path))
      continue
    }

    const extension = extname(name)
    if (
      (CODE_EXTENSIONS.has(extension) || PLAIN_RUNTIME_EXTENSIONS.has(extension)) &&
      !isTestFile(file)
    ) {
      files.push(file)
    }
  }
  return files
}

function migrationFiles(directory) {
  const files = []
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(name)) continue
      files.push(...migrationFiles(path))
    } else if (name.endsWith('.sql')) {
      files.push(path)
    }
  }
  return files
}

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (/\.(?:js|cjs|mjs)$/.test(file)) return ts.ScriptKind.JS
  return ts.ScriptKind.TS
}

function unwrap(node) {
  let current = node
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function bindingName(node) {
  const value = unwrap(node)
  if (ts.isIdentifier(value)) return value.text
  if (ts.isStringLiteralLike(value)) return value.text
  return null
}

function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const argument = unwrap(node.argumentExpression)
    if (ts.isStringLiteralLike(argument)) return argument.text
  }
  return null
}

function callName(call) {
  const expression = unwrap(call.expression)
  if (ts.isIdentifier(expression)) return expression.text
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    return propertyName(expression)
  }
  return null
}

function declarationScope(declaration) {
  let current = declaration.parent
  while (current) {
    if (ts.isSourceFile(current) || ts.isBlock(current) || ts.isFunctionLike(current))
      return current
    current = current.parent
  }
  return null
}

function isInside(node, container) {
  return node.pos >= container.pos && node.end <= container.end
}

function resolveImportFile(importer, moduleName, entryFiles) {
  let base
  if (moduleName.startsWith('@/')) {
    base = moduleName.slice(2)
  } else if (moduleName.startsWith('.')) {
    base = normalizePath(join(dirname(importer), moduleName))
  } else {
    return null
  }

  const candidates = [base]
  for (const extension of CODE_EXTENSIONS) candidates.push(`${base}${extension}`)
  for (const extension of CODE_EXTENSIONS) candidates.push(`${base}/index${extension}`)
  return candidates.find((candidate) => entryFiles.has(candidate)) ?? null
}

function collectExportedConstants(entries) {
  const constantsByFile = new Map()
  for (const { file, source } of entries) {
    if (!CODE_EXTENSIONS.has(extname(file))) continue
    const sourceFile = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file)
    )
    const constants = new Map()
    for (const statement of sourceFile.statements) {
      if (
        !ts.isVariableStatement(statement) ||
        !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        continue
      }
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
        const initializer = unwrap(declaration.initializer)
        if (ts.isStringLiteralLike(initializer)) {
          constants.set(declaration.name.text, new Set([initializer.text]))
        }
      }
    }
    if (constants.size > 0) constantsByFile.set(file, constants)
  }
  return constantsByFile
}

function collectContext(file, source, constantsByFile = new Map(), entryFiles = new Set()) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file)
  )
  const variables = new Map()
  const importAliases = new Map()
  const importedConstants = new Map()

  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const entries = variables.get(node.name.text) ?? []
      entries.push(node)
      variables.set(node.name.text, entries)
    }
    if (ts.isImportSpecifier(node)) {
      const importedName = node.propertyName?.text ?? node.name.text
      importAliases.set(node.name.text, importedName)
      const declaration = node.parent?.parent?.parent
      if (
        declaration &&
        ts.isImportDeclaration(declaration) &&
        ts.isStringLiteralLike(declaration.moduleSpecifier)
      ) {
        const importedFile = resolveImportFile(file, declaration.moduleSpecifier.text, entryFiles)
        const values = importedFile && constantsByFile.get(importedFile)?.get(importedName)
        if (values) importedConstants.set(node.name.text, values)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { file, importAliases, importedConstants, source, sourceFile, variables }
}

function resolveIdentifier(identifier, context, seen) {
  const name = identifier.text
  let ancestor = identifier.parent

  while (ancestor) {
    if (ts.isForOfStatement(ancestor) && isInside(identifier, ancestor.statement)) {
      const declaration = ancestor.initializer.declarations?.[0]
      if (declaration && ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return resolveStrings(ancestor.expression, context, seen)
      }
    }

    if (ts.isFunctionLike(ancestor)) {
      const parameterIndex = ancestor.parameters.findIndex(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name
      )
      if (parameterIndex >= 0) {
        const parent = ancestor.parent
        if (ts.isCallExpression(parent) && parent.arguments.includes(ancestor)) {
          const expression = unwrap(parent.expression)
          if (
            (ts.isPropertyAccessExpression(expression) ||
              ts.isElementAccessExpression(expression)) &&
            ['filter', 'flatMap', 'forEach', 'map'].includes(propertyName(expression) ?? '')
          ) {
            return resolveStrings(expression.expression, context, seen)
          }
        }
        return new Set()
      }
    }
    ancestor = ancestor.parent
  }

  const declarations = (context.variables.get(name) ?? [])
    .filter((declaration) => {
      if (!declaration.initializer || declaration.getStart() >= identifier.getStart()) return false
      const scope = declarationScope(declaration)
      return scope ? isInside(identifier, scope) : false
    })
    .sort((left, right) => right.getStart() - left.getStart())

  if (declarations[0]?.initializer) {
    return resolveStrings(declarations[0].initializer, context, seen)
  }
  if (context.importedConstants.has(name)) {
    return new Set(context.importedConstants.get(name))
  }
  return new Set()
}

function cartesianJoin(left, right) {
  const values = new Set()
  for (const first of left) {
    for (const second of right) {
      if (values.size >= 64) return values
      values.add(`${first}${second}`)
    }
  }
  return values
}

function resolveStrings(expression, context, seen = new Set()) {
  const node = unwrap(expression)
  if (seen.has(node)) return new Set()
  const nextSeen = new Set(seen)
  nextSeen.add(node)

  if (ts.isStringLiteralLike(node)) return new Set([node.text])
  if (ts.isIdentifier(node)) return resolveIdentifier(node, context, nextSeen)

  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(unwrap(node.expression)) &&
    unwrap(node.expression).text === 'URL' &&
    node.arguments?.[0]
  ) {
    return resolveStrings(node.arguments[0], context, nextSeen)
  }

  if (ts.isArrayLiteralExpression(node)) {
    const values = new Set()
    for (const element of node.elements) {
      for (const value of resolveStrings(element, context, nextSeen)) values.add(value)
    }
    return values
  }

  if (ts.isConditionalExpression(node)) {
    return new Set([
      ...resolveStrings(node.whenTrue, context, nextSeen),
      ...resolveStrings(node.whenFalse, context, nextSeen),
    ])
  }

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveStrings(node.left, context, nextSeen)
    const right = resolveStrings(node.right, context, nextSeen)
    return left.size > 0 && right.size > 0 ? cartesianJoin(left, right) : new Set()
  }

  if (ts.isTemplateExpression(node)) {
    let values = new Set([node.head.text])
    for (const span of node.templateSpans) {
      const substitutions = resolveStrings(span.expression, context, nextSeen)
      if (substitutions.size === 0) return new Set()
      values = cartesianJoin(values, substitutions)
      values = new Set([...values].map((value) => `${value}${span.literal.text}`))
    }
    return values
  }

  if (ts.isPropertyAccessExpression(node)) {
    const receiver = unwrap(node.expression)
    if (ts.isIdentifier(receiver)) {
      const declarations = context.variables.get(receiver.text) ?? []
      for (const declaration of declarations) {
        const initializer = declaration.initializer && unwrap(declaration.initializer)
        if (!initializer || !ts.isObjectLiteralExpression(initializer)) continue
        const match = initializer.properties.find((property) => {
          return ts.isPropertyAssignment(property) && bindingName(property.name) === node.name.text
        })
        if (match && ts.isPropertyAssignment(match)) {
          return resolveStrings(match.initializer, context, nextSeen)
        }
      }
    }
  }

  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const receiver = unwrap(node.expression)
    const indexes = resolveStrings(node.argumentExpression, context, nextSeen)
    if (ts.isIdentifier(receiver) && indexes.size === 1) {
      const declarations = context.variables.get(receiver.text) ?? []
      for (const declaration of declarations) {
        const initializer = declaration.initializer && unwrap(declaration.initializer)
        if (!initializer || !ts.isObjectLiteralExpression(initializer)) continue
        const key = [...indexes][0]
        const match = initializer.properties.find((property) => {
          return ts.isPropertyAssignment(property) && bindingName(property.name) === key
        })
        if (match && ts.isPropertyAssignment(match)) {
          return resolveStrings(match.initializer, context, nextSeen)
        }
      }
    }
  }

  return new Set()
}

function chainMethods(fromCall) {
  const methods = []
  let cursor = fromCall
  while (cursor.parent) {
    const parent = cursor.parent
    if (
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === cursor
    ) {
      const name = propertyName(parent)
      if (name) methods.push(name)
      if (ts.isCallExpression(parent.parent) && parent.parent.expression === parent) {
        cursor = parent.parent
      } else {
        cursor = parent
      }
      continue
    }
    if (ts.isAwaitExpression(parent) || ts.isParenthesizedExpression(parent)) {
      cursor = parent
      continue
    }
    break
  }
  return methods
}

function containingWriterParameter(identifier) {
  if (!ts.isIdentifier(unwrap(identifier))) return null
  const name = unwrap(identifier).text
  let current = identifier.parent
  while (current) {
    if (ts.isFunctionLike(current)) {
      const parameterIndex = current.parameters.findIndex(
        (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name
      )
      if (parameterIndex >= 0) return { fn: current, parameterIndex }
    }
    current = current.parent
  }
  return null
}

function functionName(fn) {
  if (fn.name) return bindingName(fn.name)
  const parent = fn.parent
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)) {
    return bindingName(parent.name)
  }
  return null
}

function lineOf(context, node) {
  return context.sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
}

function addOffense(result, context, node, reason) {
  result.offenses.add(`${context.file}:${lineOf(context, node)} [${reason}]`)
}

function targetValues(values) {
  return [...values].filter((value) => value === TARGET_TABLE)
}

function sqlValuesFromRpc(call, context) {
  const options = call.arguments[1] && unwrap(call.arguments[1])
  if (!options || !ts.isObjectLiteralExpression(options)) return new Set()
  for (const property of options.properties) {
    if (ts.isPropertyAssignment(property) && bindingName(property.name) === 'sql') {
      return resolveStrings(property.initializer, context)
    }
  }
  return new Set()
}

function classifySql(values, context, node, result) {
  for (const sql of values) {
    if (!TARGET_REFERENCE.test(sql)) continue
    if (ROW_DML.test(sql)) {
      addOffense(result, context, node, 'raw-sql-row-dml')
    } else if (STRICT_ANALYZE.test(sql)) {
      if (MAINTENANCE_ALLOWLIST.has(context.file)) {
        result.maintenance.push({ file: context.file, sql: sql.trim().replace(/;$/, '') })
      } else {
        addOffense(result, context, node, 'unreviewed-analyze')
      }
    } else if (/^\s*(?:EXPLAIN|SELECT|WITH)\b/i.test(sql)) {
      result.reads.push({ file: context.file, mechanism: 'sql' })
    } else {
      addOffense(result, context, node, 'unclassified-target-sql')
    }
  }
}

function objectPropertyValues(expression, key, context) {
  const options = expression && unwrap(expression)
  if (!options) return new Set()
  if (ts.isIdentifier(options)) {
    const declarations = context.variables.get(options.text) ?? []
    const declaration = declarations.find((candidate) => candidate.initializer)
    return declaration?.initializer
      ? objectPropertyValues(declaration.initializer, key, context)
      : new Set()
  }
  if (!ts.isObjectLiteralExpression(options)) return new Set()
  const property = options.properties.find(
    (candidate) => ts.isPropertyAssignment(candidate) && bindingName(candidate.name) === key
  )
  return property && ts.isPropertyAssignment(property)
    ? resolveStrings(property.initializer, context)
    : new Set()
}

function requestMethod(options, context, defaultMethod = 'GET') {
  const values = objectPropertyValues(options, 'method', context)
  if (values.size === 0) return defaultMethod
  return values.size === 1 ? [...values][0].toUpperCase() : null
}

function restMethod(call, context) {
  return requestMethod(call.arguments[1], context)
}

function baseIdentifier(expression) {
  const node = unwrap(expression)
  if (ts.isIdentifier(node)) return node.text
  if (ts.isCallExpression(node)) return baseIdentifier(node.expression)
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return baseIdentifier(node.expression)
  }
  return null
}

function variableReceiving(node) {
  let current = node
  while (current.parent) {
    const parent = current.parent
    if (ts.isVariableDeclaration(parent) && parent.initializer === current) {
      return ts.isIdentifier(parent.name) ? parent.name.text : null
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === current
    ) {
      return ts.isIdentifier(unwrap(parent.left)) ? unwrap(parent.left).text : null
    }
    if (
      ts.isCallExpression(parent) ||
      ts.isPropertyAccessExpression(parent) ||
      ts.isElementAccessExpression(parent) ||
      ts.isAwaitExpression(parent) ||
      ts.isParenthesizedExpression(parent)
    ) {
      current = parent
      continue
    }
    break
  }
  return null
}

function analyzeCode(
  file,
  source,
  blockedRpcs,
  constantsByFile = new Map(),
  entryFiles = new Set()
) {
  const context = collectContext(file, source, constantsByFile, entryFiles)
  const result = {
    calls: [],
    context,
    genericWriters: [],
    maintenance: [],
    offenses: new Set(),
    reads: [],
    targetBuilders: new Set(),
  }

  function firstVisit(node) {
    if (
      ts.isIdentifier(node) &&
      (node.text === 'persistDailySnapshots' || RETIRED_WRITER_HELPER.test(node.text))
    ) {
      addOffense(result, context, node, `retired-writer-helper:${node.text}`)
    }

    if (ts.isCallExpression(node)) {
      const name = callName(node)
      const canonicalName = (name && context.importAliases.get(name)) || name
      result.calls.push({ call: node, name: canonicalName })

      if (name === 'from' && node.arguments[0]) {
        const tableValues = resolveStrings(node.arguments[0], context)
        const methods = chainMethods(node)
        const mutator = methods.find((method) => MUTATION_METHODS.has(method))

        if (targetValues(tableValues).length > 0) {
          if (mutator) {
            addOffense(result, context, node, `postgrest-${mutator}`)
          } else {
            result.reads.push({ file: context.file, mechanism: 'postgrest' })
            const receiver = variableReceiving(node)
            if (receiver) result.targetBuilders.add(receiver)
          }
        } else if (tableValues.size === 0 && mutator) {
          const parameter = containingWriterParameter(node.arguments[0])
          const owner = parameter && functionName(parameter.fn)
          if (parameter && owner) {
            result.genericWriters.push({ name: owner, parameterIndex: parameter.parameterIndex })
          }
        }
      }

      if (name === 'rpc' && node.arguments[0]) {
        const rpcNames = resolveStrings(node.arguments[0], context)
        for (const rpcName of rpcNames) {
          if (blockedRpcs.has(rpcName)) {
            addOffense(result, context, node, `mutating-rpc:${rpcName}`)
          }
          if (rpcName === 'exec_sql')
            classifySql(sqlValuesFromRpc(node, context), context, node, result)
        }
      }

      if (name !== 'rpc') {
        for (const argument of node.arguments) {
          for (const rpcName of resolveStrings(argument, context)) {
            if (blockedRpcs.has(rpcName)) {
              addOffense(result, context, node, `mutating-rpc-wrapper:${rpcName}`)
            }
          }
        }
      }

      if (name && SQL_EXECUTOR_NAMES.has(name) && name !== 'rpc') {
        for (const argument of node.arguments) {
          classifySql(resolveStrings(argument, context), context, node, result)
        }
      }

      if (name === 'fetch' && node.arguments[0]) {
        const urls = resolveStrings(node.arguments[0], context)
        if ([...urls].some((url) => REST_TARGET.test(url))) {
          const method = restMethod(node, context)
          if (!method || ['DELETE', 'PATCH', 'POST', 'PUT'].includes(method)) {
            addOffense(result, context, node, `postgrest-rest:${method ?? 'dynamic-method'}`)
          } else {
            result.reads.push({ file: context.file, mechanism: 'rest' })
          }
        }
      }

      if (name === 'request' && node.arguments[0]) {
        const urls = objectPropertyValues(node.arguments[0], 'url', context)
        if ([...urls].some((url) => REST_TARGET.test(url))) {
          const method = requestMethod(node.arguments[0], context, null)
          if (!method || ['DELETE', 'PATCH', 'POST', 'PUT'].includes(method)) {
            addOffense(result, context, node, `postgrest-request:${method ?? 'dynamic-method'}`)
          } else {
            result.reads.push({ file: context.file, mechanism: 'rest' })
          }
        }
      }

      if (
        name &&
        ['delete', 'patch', 'post', 'put'].includes(name.toLowerCase()) &&
        node.arguments[0]
      ) {
        const urls = resolveStrings(node.arguments[0], context)
        if ([...urls].some((url) => REST_TARGET.test(url))) {
          addOffense(result, context, node, `postgrest-rest:${name.toUpperCase()}`)
        }
      }
    }

    if (ts.isTaggedTemplateExpression(node)) {
      const tag = unwrap(node.tag)
      const name = ts.isIdentifier(tag)
        ? tag.text
        : ts.isPropertyAccessExpression(tag) || ts.isElementAccessExpression(tag)
          ? propertyName(tag)
          : null
      if (name && SQL_EXECUTOR_NAMES.has(name)) {
        classifySql(resolveStrings(node.template, context), context, node, result)
      }
    }
    ts.forEachChild(node, firstVisit)
  }
  firstVisit(context.sourceFile)

  function builderVisit(node) {
    if (ts.isCallExpression(node)) {
      const name = callName(node)
      if (name && MUTATION_METHODS.has(name)) {
        const expression = unwrap(node.expression)
        if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
          const base = baseIdentifier(expression.expression)
          if (base && result.targetBuilders.has(base)) {
            addOffense(result, context, node, `aliased-postgrest-${name}`)
          }
        }
      }
    }
    ts.forEachChild(node, builderVisit)
  }
  builderVisit(context.sourceFile)
  return result
}

function stripPlainComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '')
    .replace(/^\s*#.*$/gm, '')
}

function analyzePlain(file, source, blockedRpcs) {
  const body = stripPlainComments(source)
  const offenses = new Set()
  if (ROW_DML.test(body)) offenses.add(`${file}:1 [plain-runtime-row-dml]`)
  for (const rpc of blockedRpcs) {
    if (new RegExp(`\\b${rpc}\\b`).test(body)) offenses.add(`${file}:1 [mutating-rpc:${rpc}]`)
  }
  if (/\bpersistDailySnapshots\b/.test(body)) {
    offenses.add(`${file}:1 [retired-writer-helper:persistDailySnapshots]`)
  }
  return { maintenance: [], offenses, reads: [] }
}

function mutatingFunctionsFromSql(source) {
  const functions = new Set()
  const header =
    /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+((?:(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*)?(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))\s*\(/gi
  let match
  while ((match = header.exec(source))) {
    const tail = source.slice(header.lastIndex)
    const dollarQuote = /\bAS\s+(\$[A-Za-z0-9_]*\$)/i.exec(tail)
    if (!dollarQuote) continue
    const delimiter = dollarQuote[1]
    const bodyStart = header.lastIndex + dollarQuote.index + dollarQuote[0].length
    const bodyEnd = source.indexOf(delimiter, bodyStart)
    if (bodyEnd < 0) continue
    const body = source.slice(bodyStart, bodyEnd)
    if (ROW_DML.test(body)) {
      const name = match[1].split('.').at(-1).trim().replace(/^"|"$/g, '')
      functions.add(name)
    }
    header.lastIndex = bodyEnd + delimiter.length
  }
  return functions
}

function discoverMigrationMutators() {
  const directory = resolve(ROOT, MIGRATION_ROOT)
  const names = new Set()
  if (!existsSync(directory)) return names
  for (const file of migrationFiles(directory)) {
    for (const name of mutatingFunctionsFromSql(readFileSync(file, 'utf8'))) names.add(name)
  }
  return names
}

function scanEntries(entries, blockedRpcs = EXPLICIT_MUTATING_RPCS) {
  const codeResults = []
  const plainResults = []
  const constantsByFile = collectExportedConstants(entries)
  const entryFiles = new Set(entries.map(({ file }) => file))

  for (const { file, source } of entries) {
    if (GENERATED_TYPE_ALLOWLIST.has(file) || file.startsWith(`${MIGRATION_ROOT}/`)) continue
    if (CODE_EXTENSIONS.has(extname(file))) {
      codeResults.push(analyzeCode(file, source, blockedRpcs, constantsByFile, entryFiles))
    } else if (PLAIN_RUNTIME_EXTENSIONS.has(extname(file))) {
      plainResults.push(analyzePlain(file, source, blockedRpcs))
    }
  }

  const summaries = new Map()
  for (const result of codeResults) {
    for (const summary of result.genericWriters) {
      const indexes = summaries.get(summary.name) ?? new Set()
      indexes.add(summary.parameterIndex)
      summaries.set(summary.name, indexes)
    }
  }

  for (const result of codeResults) {
    for (const { call, name } of result.calls) {
      if (!name || !summaries.has(name)) continue
      for (const parameterIndex of summaries.get(name)) {
        const argument = call.arguments[parameterIndex]
        if (argument && targetValues(resolveStrings(argument, result.context)).length > 0) {
          addOffense(result, result.context, call, `generic-writer:${name}`)
        }
      }
    }
  }

  return {
    maintenance: [...codeResults, ...plainResults].flatMap((result) => result.maintenance),
    offenses: [
      ...new Set([...codeResults, ...plainResults].flatMap((result) => [...result.offenses])),
    ].sort(),
    reads: [...codeResults, ...plainResults].flatMap((result) => result.reads),
  }
}

function scanVirtual(file, source) {
  return scanEntries([{ file, source }])
}

function countByFile(events) {
  const counts = new Map()
  for (const event of events) counts.set(event.file, (counts.get(event.file) ?? 0) + 1)
  return new Map([...counts].sort(([left], [right]) => left.localeCompare(right)))
}

test('writer detector catches direct, aliased, dynamic, helper, RPC, SQL, and REST writes', () => {
  const fixtures = [
    "db.from('trader_daily_snapshots').insert(rows)",
    'db\n  .from("trader_daily_snapshots")\n  .upsert(rows)',
    "const table = 'trader_daily_snapshots'; db.from(table).update(row)",
    "for (const table of ['trader_daily_snapshots']) db.from(table).delete()",
    "const query = db.from('trader_daily_snapshots').select('*'); query.update(row)",
    "db.query('UPDATE public.trader_daily_snapshots SET roi = NULL')",
    [
      "for (const table of ['trader_daily_snapshots']) {",
      '  db.query(`DELETE FROM public.${table} WHERE date < now()`)',
      '}',
    ].join('\n'),
    "const repair = 'cleanup_all_data_violations'; db.rpc(repair, {})",
    "invoke(db, 'cleanup_all_data_violations')",
    'db.$executeRaw`DELETE FROM trader_daily_snapshots WHERE date < now()`',
    "let query; query = db.from('trader_daily_snapshots'); query.delete()",
    [
      'function writeRows(client, table, rows) {',
      '  return client.from(table).upsert(rows)',
      '}',
      "writeRows(db, 'trader_daily_snapshots', rows)",
    ].join('\n'),
    'class Storage { persistDailySnapshots(rows) { return rows } }',
    ["fetch('/rest/v1/trader_daily_snapshots', {", "  method: 'PATCH',", "  body: '{}'", '})'].join(
      '\n'
    ),
    [
      "fetch(new URL('/rest/v1/trader_daily_snapshots', origin), {",
      "  method: 'PATCH',",
      '})',
    ].join('\n'),
    [
      'client.request({',
      "  url: '/rest/v1/trader_daily_snapshots',",
      "  method: 'DELETE',",
      '})',
    ].join('\n'),
  ]

  for (const [index, fixture] of fixtures.entries()) {
    const result = scanVirtual(`app/api/fixture-${index}/route.ts`, fixture)
    assert.notDeepEqual(result.offenses, [], `writer fixture was missed:\n${fixture}`)
  }

  const importedTable = scanEntries([
    {
      file: 'lib/daily-table.ts',
      source: "export const DAILY_TABLE = 'trader_daily_snapshots'",
    },
    {
      file: 'app/api/imported-writer/route.ts',
      source: [
        "import { DAILY_TABLE } from '@/lib/daily-table'",
        'db.from(DAILY_TABLE).upsert(rows)',
      ].join('\n'),
    },
  ])
  assert.notDeepEqual(importedTable.offenses, [], 'imported table constant writer was missed')
})

test('writer detector does not confuse a reviewed read or another table write with target DML', () => {
  const source = [
    "const snapshots = await db.from('trader_daily_snapshots').select('date, roi')",
    "await db.from('notifications').insert(snapshots)",
  ].join('\n')
  const result = scanVirtual('app/api/cron/broadcast-trader-events/route.ts', source)
  assert.deepEqual(result.offenses, [])
  assert.deepEqual(result.reads, [
    { file: 'app/api/cron/broadcast-trader-events/route.ts', mechanism: 'postgrest' },
  ])
})

test('detects legacy ANALYZE access and excludes migrations and generated types', () => {
  const analyze = scanVirtual(
    'app/api/cron/cleanup-data/route.ts',
    [
      "for (const table of ['trader_daily_snapshots']) {",
      "  db.rpc('exec_sql', { sql: `ANALYZE ${table}` })",
      '}',
    ].join('\n')
  )
  assert.notDeepEqual(analyze.offenses, [])
  assert.deepEqual(analyze.maintenance, [])

  assert.deepEqual(
    scanEntries([
      {
        file: 'supabase/migrations/20990101000000_fixture.sql',
        source: 'DELETE FROM trader_daily_snapshots;',
      },
      {
        file: 'lib/supabase/database.types.ts',
        source: 'type T = { trader_daily_snapshots: { Insert: unknown; Update: unknown } }',
      },
    ]).offenses,
    []
  )
})

test('discovers mutating RPC bodies in historical SQL', () => {
  const names = mutatingFunctionsFromSql(`
    CREATE OR REPLACE FUNCTION public.fixture_cleanup()
    RETURNS void AS $body$
    BEGIN
      DELETE FROM public.trader_daily_snapshots WHERE date < CURRENT_DATE;
    END;
    $body$ LANGUAGE plpgsql;
  `)
  assert.deepEqual([...names], ['fixture_cleanup'])
})

test('repository production runtime has no trader_daily_snapshots row writer', () => {
  const discoveredMutators = discoverMigrationMutators()
  assert.ok(
    discoveredMutators.has('cleanup_stale_data'),
    'historical mutating RPC discovery must include cleanup_stale_data'
  )
  const blockedRpcs = new Set([...EXPLICIT_MUTATING_RPCS, ...discoveredMutators])
  const entries = []
  for (const sourceRoot of RUNTIME_ROOTS) {
    const absoluteRoot = resolve(ROOT, sourceRoot)
    if (!existsSync(absoluteRoot)) continue
    for (const file of productionFiles(absoluteRoot)) {
      entries.push({ file, source: readFileSync(resolve(ROOT, file), 'utf8') })
    }
  }

  const result = scanEntries(entries, blockedRpcs)
  assert.deepEqual(
    result.offenses,
    [],
    `trader_daily_snapshots must have no runtime row writer:\n${result.offenses.join('\n')}`
  )
  assert.deepEqual(countByFile(result.reads), READ_ONLY_ALLOWLIST)
  assert.deepEqual(countByFile(result.maintenance), MAINTENANCE_ALLOWLIST)
  assert.deepEqual(result.maintenance, [])
})
