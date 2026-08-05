#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import ts from 'typescript'

import {
  buildLaunchMigrationInventory,
  canonicalJsonSha256,
} from './launch-migration-inventory.mjs'

export const V1_MISSING_RPC_CROSSWALK_CONTRACT = 'arena.v1-missing-rpc-crosswalk@1'
export const V1_MISSING_RPC_CROSSWALK_STATUS = 'analysis/historical-live-gap-not-current-proof'

export const REQUIRED_RANKING_MIGRATION_ORDER = Object.freeze([
  '20260729223000_rerank_public_eligible_rows_only.sql',
  '20260729224000_rank_eligible_leaderboard_count_cache.sql',
  '20260729225000_token_trader_rank_authority.sql',
  '20260729230000_token_ranking_generation_barrier.sql',
  '20260804043000_retire_legacy_token_rankings.sql',
])

export const MISSING_RPC_DEFINITIONS = Object.freeze([
  Object.freeze({
    aclEvidence: Object.freeze({
      kind: 'explicit-service-role',
      migration: '20260729223000_rerank_public_eligible_rows_only.sql',
    }),
    consumers: Object.freeze([
      'app/api/cron/compute-leaderboard/database-contract.ts',
      'app/api/cron/compute-leaderboard/rerank-cleanup.ts',
    ]),
    definingMigration: '20260729223000_rerank_public_eligible_rows_only.sql',
    endState: 'service-only/ranking-authority-writer',
    expectedAcl: 'service_role-execute-only',
    name: 'rerank_public_eligible_leaderboard',
    signature: 'public.rerank_public_eligible_leaderboard(text)',
    tests: Object.freeze([
      'supabase/migrations/__tests__/rerank-public-eligible-rows-only.test.ts',
      'supabase/migrations/__tests__/rerank-public-eligible-rows-only.pg17.sh',
    ]),
  }),
  Object.freeze({
    aclEvidence: Object.freeze({
      kind: 'explicit-service-role',
      migration: '20260729224000_rank_eligible_leaderboard_count_cache.sql',
    }),
    consumers: Object.freeze([
      'app/api/cron/compute-leaderboard/database-contract.ts',
      'app/api/cron/compute-leaderboard/route.ts',
    ]),
    definingMigration: '20260729224000_rank_eligible_leaderboard_count_cache.sql',
    endState: 'service-only/rank-count-cache-writer',
    expectedAcl: 'service_role-execute-only',
    name: 'refresh_public_rank_count_cache_for_seasons',
    signature: 'public.refresh_public_rank_count_cache_for_seasons(text[])',
    tests: Object.freeze([
      'supabase/migrations/__tests__/rank-eligible-leaderboard-count-cache.test.ts',
      'supabase/migrations/__tests__/rank-eligible-leaderboard-count-cache.pg17.sh',
    ]),
  }),
  Object.freeze({
    aclEvidence: Object.freeze({
      kind: 'retirement-pg17-matrix',
      migration: '20260804043000_retire_legacy_token_rankings.sql',
      test: 'supabase/migrations/__tests__/token-ranking-generation-barrier.pg17.sh',
    }),
    consumers: Object.freeze(['lib/rankings/token-ranking-snapshot.ts']),
    definingMigration: '20260729230000_token_ranking_generation_barrier.sql',
    endState: 'service-only/head-reader-retained-after-http-containment',
    expectedAcl: 'service_role-execute-only',
    name: 'get_token_ranking_publication_head',
    signature: 'public.get_token_ranking_publication_head()',
    tests: Object.freeze([
      'supabase/migrations/__tests__/token-ranking-generation-barrier.test.ts',
      'supabase/migrations/__tests__/token-ranking-generation-barrier.pg17.sh',
      'supabase/migrations/__tests__/retire-legacy-token-rankings.test.ts',
    ]),
  }),
  Object.freeze({
    aclEvidence: Object.freeze({
      kind: 'retirement-pg17-matrix',
      migration: '20260804043000_retire_legacy_token_rankings.sql',
      test: 'supabase/migrations/__tests__/token-ranking-generation-barrier.pg17.sh',
    }),
    consumers: Object.freeze(['lib/rankings/token-ranking-snapshot.ts']),
    definingMigration: '20260729230000_token_ranking_generation_barrier.sql',
    endState: 'retired/fail-closed-reader-after-http-containment',
    expectedAcl: 'owner-only/no-non-owner-execute',
    name: 'get_token_trader_rankings_v2',
    signature: 'public.get_token_trader_rankings_v2(text,integer,integer,integer,bigint)',
    tests: Object.freeze([
      'supabase/migrations/__tests__/token-ranking-generation-barrier.test.ts',
      'supabase/migrations/__tests__/token-ranking-generation-barrier.pg17.sh',
      'supabase/migrations/__tests__/retire-legacy-token-rankings.test.ts',
    ]),
  }),
  Object.freeze({
    aclEvidence: Object.freeze({
      kind: 'retirement-pg17-matrix',
      migration: '20260804043000_retire_legacy_token_rankings.sql',
      test: 'supabase/migrations/__tests__/token-ranking-generation-barrier.pg17.sh',
    }),
    consumers: Object.freeze(['lib/rankings/token-ranking-snapshot.ts']),
    definingMigration: '20260729230000_token_ranking_generation_barrier.sql',
    endState: 'retired/fail-closed-reader-after-http-containment',
    expectedAcl: 'owner-only/no-non-owner-execute',
    name: 'get_popular_tokens_v2',
    signature: 'public.get_popular_tokens_v2(integer,integer,bigint)',
    tests: Object.freeze([
      'supabase/migrations/__tests__/token-ranking-generation-barrier.test.ts',
      'supabase/migrations/__tests__/token-ranking-generation-barrier.pg17.sh',
      'supabase/migrations/__tests__/retire-legacy-token-rankings.test.ts',
    ]),
  }),
])

const DATABASE_TYPES_PATH = 'lib/supabase/database.types.ts'
const EXPECTED_ACL_VALUES = new Set([
  'owner-only/no-non-owner-execute',
  'service_role-execute-only',
])
const ACL_EVIDENCE_KINDS = new Set(['explicit-service-role', 'retirement-pg17-matrix'])
const RETIREMENT_ACL_FUNCTION_SIGNATURES = Object.freeze([
  'arena.token_trader_ranking_page_payload_v1(text,integer,integer,integer,date)',
  'public.get_token_trader_rankings(text,integer,integer,integer)',
  'public.get_popular_tokens(integer,integer)',
  'public.get_token_ranking_publication_head()',
  'public.get_token_trader_rankings_v2(text,integer,integer,integer,bigint)',
  'public.get_popular_tokens_v2(integer,integer,bigint)',
  'public.refresh_popular_tokens_mv()',
])

function fail(message) {
  throw new Error(message)
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

function readTrustedFile(physicalRepoRoot, relativePath) {
  if (
    typeof relativePath !== 'string' ||
    path.isAbsolute(relativePath) ||
    relativePath.includes('\0') ||
    relativePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    fail(`crosswalk path is unsafe: ${relativePath}`)
  }
  let current = physicalRepoRoot
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment)
    let metadata
    try {
      metadata = lstatSync(current)
    } catch {
      fail(`crosswalk file is missing: ${relativePath}`)
    }
    if (metadata.isSymbolicLink()) fail(`crosswalk path contains a symlink: ${relativePath}`)
  }
  let descriptor
  try {
    const metadata = lstatSync(current)
    if (!metadata.isFile()) fail(`crosswalk path is not a regular file: ${relativePath}`)
    const physicalPath = realpathSync(current)
    const relative = path.relative(physicalRepoRoot, physicalPath)
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      fail(`crosswalk path resolves outside repository: ${relativePath}`)
    }
    if (typeof fsConstants.O_NOFOLLOW !== 'number') {
      fail('O_NOFOLLOW is unavailable; refusing to read crosswalk evidence')
    }
    descriptor = openSync(current, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const before = fstatSync(descriptor)
    if (!before.isFile() || before.dev !== metadata.dev || before.ino !== metadata.ino) {
      fail(`crosswalk file changed while opening: ${relativePath}`)
    }
    const contents = readFileSync(descriptor)
    const after = fstatSync(descriptor)
    const finalMetadata = lstatSync(current)
    for (const field of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) {
      if (before[field] !== after[field] || after[field] !== finalMetadata[field]) {
        fail(`crosswalk file changed while reading: ${relativePath}`)
      }
    }
    if (
      finalMetadata.isSymbolicLink() ||
      !finalMetadata.isFile() ||
      realpathSync(current) !== physicalPath
    ) {
      fail(`crosswalk file changed while reading: ${relativePath}`)
    }
    return contents
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function definitionArgumentTypes(definition) {
  const expectedPrefix = `public.${definition.name}(`
  if (!definition.signature.startsWith(expectedPrefix) || !definition.signature.endsWith(')')) {
    fail(`V1 missing RPC signature does not match its name: ${definition.name}`)
  }
  const argumentsText = definition.signature.slice(expectedPrefix.length, -1)
  const types = argumentsText === '' ? [] : argumentsText.split(',')
  if (types.some((type) => !/^[a-z][a-z0-9_]*(?:\[\])?(?: [a-z]+)*$/u.test(type))) {
    fail(`V1 missing RPC signature contains an unsupported type: ${definition.name}`)
  }
  return types
}

function exactCreateHeaderPattern(definition) {
  const types = definitionArgumentTypes(definition)
  const argumentsPattern = types
    .map((type) => `(?:[a-z_][a-z0-9_]*\\s+)?${escapeRegex(type).replaceAll(' ', '\\s+')}`)
    .join('\\s*,\\s*')
  return new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${escapeRegex(definition.name)}\\s*\\(\\s*${argumentsPattern}\\s*\\)`,
    'iu'
  )
}

function exactFunctionIdentityPattern(definition) {
  const argumentsPattern = definitionArgumentTypes(definition)
    .map((type) => escapeRegex(type).replaceAll(' ', '\\s+'))
    .join('\\s*,\\s*')
  return new RegExp(
    `public\\s*\\.\\s*${escapeRegex(definition.name)}\\s*\\(\\s*${argumentsPattern}\\s*\\)`,
    'iu'
  )
}

function lexSql(source, label) {
  if (typeof source !== 'string') fail(`${label} must be text`)
  const masked = new Array(source.length).fill(' ')
  const dollarQuoted = []
  const singleQuoted = []
  let index = 0
  while (index < source.length) {
    if (source.startsWith('--', index)) {
      index += 2
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
        index += 1
      }
      continue
    }
    if (source.startsWith('/*', index)) {
      let depth = 1
      index += 2
      while (index < source.length && depth > 0) {
        if (source.startsWith('/*', index)) {
          depth += 1
          index += 2
        } else if (source.startsWith('*/', index)) {
          depth -= 1
          index += 2
        } else {
          index += 1
        }
      }
      if (depth !== 0) fail(`${label} contains an unterminated block comment`)
      continue
    }
    if (source[index] === "'" || source[index] === '"') {
      const start = index
      const quote = source[index]
      index += 1
      let terminated = false
      let value = ''
      while (index < source.length) {
        if (source[index] === quote) {
          if (source[index + 1] === quote) {
            if (quote === "'") value += quote
            index += 2
            continue
          }
          index += 1
          terminated = true
          break
        }
        if (quote === "'" && source[index] === '\\' && index + 1 < source.length) {
          value += source[index + 1]
          index += 2
        } else {
          if (quote === "'") value += source[index]
          index += 1
        }
      }
      if (!terminated) fail(`${label} contains an unterminated quoted value`)
      if (quote === "'") singleQuoted.push({ end: index, start, value })
      continue
    }
    if (source[index] === '$') {
      const delimiter = source.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u)?.[0]
      if (delimiter) {
        const start = index
        const end = source.indexOf(delimiter, index + delimiter.length)
        if (end === -1) fail(`${label} contains an unterminated dollar-quoted value`)
        dollarQuoted.push({
          body: source.slice(index + delimiter.length, end),
          delimiter,
          end: end + delimiter.length,
          start,
        })
        index = end + delimiter.length
        continue
      }
    }
    masked[index] = source[index]
    index += 1
  }
  return { dollarQuoted, masked: masked.join(''), singleQuoted }
}

function maskSqlNonCode(source, label) {
  return lexSql(source, label).masked
}

function decodeUtf8(contents, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(contents)
  } catch {
    fail(`${label} must contain valid UTF-8 text`)
  }
}

function parseTypeScriptEvidence(contents, relativePath) {
  if (!/\.tsx?$/u.test(relativePath)) {
    fail(`crosswalk TypeScript evidence has an unsupported path: ${relativePath}`)
  }
  const source = decodeUtf8(contents, relativePath)
  const scriptKind = relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  )
  if (sourceFile.parseDiagnostics.length > 0) {
    fail(`crosswalk TypeScript evidence does not parse: ${relativePath}`)
  }
  return sourceFile
}

function visitTypeScript(sourceFile, predicate) {
  let matched = false
  const visit = (node) => {
    if (matched) return
    if (predicate(node)) {
      matched = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return matched
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text
  return null
}

function hasGeneratedRpcProperty(sourceFile, rpcName) {
  return visitTypeScript(
    sourceFile,
    (node) =>
      ts.isPropertySignature(node) &&
      propertyNameText(node.name) === rpcName &&
      node.type !== undefined &&
      ts.isTypeLiteralNode(node.type)
  )
}

function hasRuntimeRpcCall(sourceFile, rpcName) {
  return visitTypeScript(sourceFile, (node) => {
    if (
      !ts.isCallExpression(node) ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== 'rpc'
    ) {
      return false
    }
    const firstArgument = node.arguments[0]
    return (
      firstArgument !== undefined &&
      ts.isStringLiteralLike(firstArgument) &&
      firstArgument.text === rpcName
    )
  })
}

const EXPECT_MATCHERS_WITH_EVIDENCE_ARGUMENTS = new Set([
  'toContain',
  'toEqual',
  'toHaveProperty',
  'toMatch',
  'toStrictEqual',
])
const EXPECT_MODIFIERS = new Set(['not', 'rejects', 'resolves'])
const ASSERT_METHODS = new Set([
  'deepEqual',
  'doesNotMatch',
  'equal',
  'match',
  'notDeepEqual',
  'notEqual',
  'ok',
  'strictEqual',
])
const ASSERT_METHODS_WITH_EVIDENCE_ARGUMENTS = new Set([
  'deepEqual',
  'doesNotMatch',
  'equal',
  'match',
  'notDeepEqual',
  'notEqual',
  'strictEqual',
])

function visitTypeScriptNode(root, predicate) {
  let matched = false
  const visit = (node) => {
    if (matched) return
    if (predicate(node)) {
      matched = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return matched
}

function containsRpcLiteral(root, rpcName) {
  return visitTypeScriptNode(root, (node) => {
    if (ts.isStringLiteralLike(node)) return node.text.includes(rpcName)
    return ts.isRegularExpressionLiteral(node) && node.text.includes(rpcName)
  })
}

function containsIdentifier(root, predicate) {
  return visitTypeScriptNode(root, (node) => ts.isIdentifier(node) && predicate(node.text))
}

function collectTaintedEvidenceIdentifiers(sourceFile) {
  const directReadFileBindings = new Set()
  const fsNamespaceBindings = new Set()
  visitTypeScriptNode(sourceFile, (node) => {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== 'node:fs' ||
      node.importClause?.namedBindings === undefined
    ) {
      return false
    }
    if (ts.isNamespaceImport(node.importClause.namedBindings)) {
      fsNamespaceBindings.add(node.importClause.namedBindings.name.text)
      return false
    }
    for (const element of node.importClause.namedBindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === 'readFileSync') {
        directReadFileBindings.add(element.name.text)
      }
    }
    return false
  })
  const isReadFileCall = (node) => {
    if (!ts.isCallExpression(node)) return false
    if (ts.isIdentifier(node.expression)) return directReadFileBindings.has(node.expression.text)
    return (
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      fsNamespaceBindings.has(node.expression.expression.text) &&
      node.expression.name.text === 'readFileSync'
    )
  }

  const declarations = []
  visitTypeScriptNode(sourceFile, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      declarations.push({ initializer: node.initializer, name: node.name.text })
    }
    return false
  })

  const tainted = new Set()
  for (const declaration of declarations) {
    if (visitTypeScriptNode(declaration.initializer, isReadFileCall)) {
      tainted.add(declaration.name)
    }
  }

  let changed = true
  while (changed) {
    changed = false
    for (const declaration of declarations) {
      if (
        !tainted.has(declaration.name) &&
        containsIdentifier(declaration.initializer, (name) => tainted.has(name))
      ) {
        tainted.add(declaration.name)
        changed = true
      }
    }
  }
  return tainted
}

function expectAssertion(call) {
  if (!ts.isPropertyAccessExpression(call.expression)) return null
  const matcher = call.expression.name.text
  let receiver = call.expression.expression
  while (ts.isPropertyAccessExpression(receiver) && EXPECT_MODIFIERS.has(receiver.name.text)) {
    receiver = receiver.expression
  }
  if (
    !ts.isCallExpression(receiver) ||
    !ts.isIdentifier(receiver.expression) ||
    receiver.expression.text !== 'expect' ||
    receiver.arguments.length !== 1
  ) {
    return null
  }
  return { actual: receiver.arguments[0], evidenceArguments: call.arguments, matcher }
}

function assertAssertion(call) {
  if (
    !ts.isPropertyAccessExpression(call.expression) ||
    !ts.isIdentifier(call.expression.expression) ||
    call.expression.expression.text !== 'assert' ||
    !ASSERT_METHODS.has(call.expression.name.text) ||
    call.arguments.length === 0
  ) {
    return null
  }
  return {
    actual: call.arguments[0],
    evidenceArguments: call.arguments.slice(1),
    matcher: call.expression.name.text,
  }
}

function assertionDetails(call) {
  return expectAssertion(call) ?? assertAssertion(call)
}

function assertionUsesTaintedEvidence(assertion, tainted) {
  return containsIdentifier(assertion.actual, (name) => tainted.has(name))
}

function assertionDirectlyReferencesRpc(assertion, rpcName, tainted) {
  if (!assertionUsesTaintedEvidence(assertion, tainted)) return false
  if (containsRpcLiteral(assertion.actual, rpcName)) return true
  return (
    (EXPECT_MATCHERS_WITH_EVIDENCE_ARGUMENTS.has(assertion.matcher) ||
      ASSERT_METHODS_WITH_EVIDENCE_ARGUMENTS.has(assertion.matcher)) &&
    assertion.evidenceArguments.some((argument) => containsRpcLiteral(argument, rpcName))
  )
}

function loopBindsRpcToAssertion(node, rpcName, tainted) {
  if (
    !ts.isForOfStatement(node) ||
    !ts.isVariableDeclarationList(node.initializer) ||
    node.initializer.declarations.length !== 1
  ) {
    return false
  }
  const declaration = node.initializer.declarations[0]
  if (!ts.isIdentifier(declaration.name) || !ts.isArrayLiteralExpression(node.expression)) {
    return false
  }
  if (!node.expression.elements.some((element) => containsRpcLiteral(element, rpcName))) {
    return false
  }
  const binding = declaration.name.text
  return visitTypeScriptNode(node.statement, (candidate) => {
    if (!ts.isCallExpression(candidate)) return false
    const assertion = assertionDetails(candidate)
    return (
      assertion !== null &&
      assertionUsesTaintedEvidence(assertion, tainted) &&
      containsIdentifier(assertion.actual, (name) => name === binding)
    )
  })
}

function hasTypeScriptTestReference(sourceFile, rpcName) {
  const tainted = collectTaintedEvidenceIdentifiers(sourceFile)
  if (tainted.size === 0) return false
  return visitTypeScriptNode(sourceFile, (node) => {
    if (ts.isCallExpression(node)) {
      const assertion = assertionDetails(node)
      if (assertion && assertionDirectlyReferencesRpc(assertion, rpcName, tainted)) return true
    }
    return loopBindsRpcToAssertion(node, rpcName, tainted)
  })
}

function maskShellComments(source, label) {
  if (typeof source !== 'string') fail(`${label} must be text`)
  const masked = source.split('')
  let quote = null
  let escaped = false
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (quote !== null) {
      if (escaped) {
        escaped = false
      } else if (character === '\\' && quote === '"') {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character !== '#') continue
    while (index < source.length && source[index] !== '\n' && source[index] !== '\r') {
      masked[index] = ' '
      index += 1
    }
    index -= 1
  }
  if (quote !== null) fail(`${label} contains an unterminated shell quote`)
  return masked.join('')
}

function shellHeredocDelimiter(line, label) {
  const delimiters = []
  let quote = null
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (quote !== null) {
      if (escaped) {
        escaped = false
      } else if (character === '\\' && quote === '"') {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === '#') break
    if (character !== '<' || line[index + 1] !== '<' || line[index + 2] === '<') continue
    let cursor = index + 2
    let stripTabs = false
    if (line[cursor] === '-') {
      stripTabs = true
      cursor += 1
    }
    while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1
    let delimiter = ''
    if (line[cursor] === "'" || line[cursor] === '"') {
      const delimiterQuote = line[cursor]
      cursor += 1
      const end = line.indexOf(delimiterQuote, cursor)
      if (end === -1) fail(`${label} contains an unterminated heredoc delimiter`)
      delimiter = line.slice(cursor, end)
      cursor = end + 1
    } else {
      const match = line.slice(cursor).match(/^[A-Za-z_][A-Za-z0-9_]*/u)
      if (match) {
        delimiter = match[0]
        cursor += delimiter.length
      }
    }
    if (delimiter === '') fail(`${label} contains an unsupported heredoc delimiter`)
    delimiters.push({ delimiter, stripTabs })
    index = cursor - 1
  }
  if (delimiters.length > 1) fail(`${label} contains multiple heredocs on one command`)
  return delimiters[0] ?? null
}

function maskShellHeredocBodies(source, label) {
  const masked = source.split('')
  let pending = null
  const linePattern = /[^\r\n]*(?:\r\n|\r|\n|$)/gu
  for (const match of source.matchAll(linePattern)) {
    if (match[0] === '') continue
    const line = match[0].replace(/(?:\r\n|\r|\n)$/u, '')
    if (pending !== null) {
      for (let index = match.index; index < match.index + line.length; index += 1) {
        masked[index] = ' '
      }
      const candidate = pending.stripTabs ? line.replace(/^\t+/u, '') : line
      if (candidate === pending.delimiter) pending = null
      continue
    }
    pending = shellHeredocDelimiter(line, label)
  }
  if (pending !== null) fail(`${label} contains an unterminated heredoc body`)
  return masked.join('')
}

function topLevelShellMatches(source, matches, label) {
  const matchesByIndex = new Map(matches.map((match) => [match.index, match]))
  const accepted = []
  let quote = null
  let escaped = false
  let index = 0
  while (index < source.length) {
    const candidate = matchesByIndex.get(index)
    if (quote === null && candidate !== undefined) {
      accepted.push(candidate)
      index += candidate[0].length
      continue
    }
    const character = source[index]
    if (quote !== null) {
      if (escaped) {
        escaped = false
      } else if (character === '\\' && quote === '"') {
        escaped = true
      } else if (character === quote) {
        quote = null
      }
    } else if (character === "'" || character === '"') {
      quote = character
    } else if (character === '\\') {
      index += 1
    }
    index += 1
  }
  if (quote !== null) fail(`${label} contains an unterminated quoted value`)
  return accepted
}

function assertedPsqlQueries(source, label) {
  const executable = maskShellComments(maskShellHeredocBodies(source, label), label)
  const assignments = []
  const assignmentPattern =
    /^([A-Z][A-Z0-9_]*)="\$\(psql_db[ \t]+-Atqc[ \t]+"([\s\S]*?)"\)"[ \t]*$/gmu
  const assignmentMatches = [...executable.matchAll(assignmentPattern)]
  for (const match of topLevelShellMatches(executable, assignmentMatches, label)) {
    const [, variable, query] = match
    if (query.includes('$(') || query.includes('`')) {
      fail(`${label} asserted psql query contains shell execution: ${variable}`)
    }
    assignments.push({ index: match.index, query, variable })
  }

  const shellSpace = '(?:[ \\t]|\\\\\\r?\\n[ \\t]*)+'
  const assertionPattern = new RegExp(
    `^[ \\t]*assert_equal${shellSpace}"(?:[^"\\\\]|\\\\.)*"${shellSpace}"((?:[^"\\\\]|\\\\.)*)"${shellSpace}"\\$(?:\\{([A-Z][A-Z0-9_]*)\\}|([A-Z][A-Z0-9_]*))"[ \\t]*$`,
    'gmu'
  )
  const asserted = []
  const assertionMatches = [...executable.matchAll(assertionPattern)]
  for (const match of topLevelShellMatches(executable, assertionMatches, label)) {
    const variable = match[2] ?? match[3]
    const assignment = assignments
      .filter((candidate) => candidate.variable === variable && candidate.index < match.index)
      .at(-1)
    if (assignment === undefined) continue
    asserted.push({ expected: match[1], query: assignment.query, variable })
  }
  return asserted
}

function assertedPsqlQueryReferencesRpc(source, label, rpcName) {
  return assertedPsqlQueries(source, label).some(({ query, variable }) => {
    const lexical = lexSql(query, `${label} ${variable} query`)
    return (
      new RegExp(`\\b${escapeRegex(rpcName)}\\b`, 'u').test(lexical.masked) ||
      lexical.singleQuoted.some((literal) => literal.value.includes(rpcName))
    )
  })
}

function hasTestReference(contents, relativePath, rpcName) {
  if (relativePath.endsWith('.test.ts') || relativePath.endsWith('.test.tsx')) {
    return hasTypeScriptTestReference(parseTypeScriptEvidence(contents, relativePath), rpcName)
  }
  if (relativePath.endsWith('.pg17.sh')) {
    const source = decodeUtf8(contents, relativePath)
    return assertedPsqlQueryReferencesRpc(source, relativePath, rpcName)
  }
  fail(`crosswalk test evidence has an unsupported path: ${relativePath}`)
}

function structuredSql(source, label) {
  const lexical = lexSql(source, label)
  let cursor = 0
  let structured = ''
  for (const literal of lexical.singleQuoted) {
    structured += lexical.masked.slice(cursor, literal.start)
    structured += ` ${literalMarker(literal.value)} `
    cursor = literal.end
  }
  structured += lexical.masked.slice(cursor)
  return structured.replace(/\s+/gu, ' ').trim()
}

function literalMarker(value) {
  return `__sql_literal_${sha256(value).slice(0, 16)}__`
}

function topLevelSqlStatements(source, label) {
  const lexical = lexSql(source, label)
  const statements = []
  let start = 0
  for (let index = 0; index < lexical.masked.length; index += 1) {
    if (lexical.masked[index] !== ';') continue
    const code = lexical.masked.slice(start, index).trim()
    if (code !== '') statements.push({ code, raw: source.slice(start, index) })
    start = index + 1
  }
  if (lexical.masked.slice(start).trim() !== '') {
    fail(`${label} contains an unterminated top-level SQL statement`)
  }
  return statements
}

function uniqueDoBlock(source, delimiter, label) {
  const lexical = lexSql(source, label)
  const blocks = lexical.dollarQuoted.filter((block) => {
    if (block.delimiter !== delimiter) return false
    const statementStart = lexical.masked.lastIndexOf(';', block.start - 1) + 1
    const statementEnd = lexical.masked.indexOf(';', block.end)
    if (statementEnd === -1) return false
    return (
      /^DO$/iu.test(lexical.masked.slice(statementStart, block.start).trim()) &&
      lexical.masked.slice(block.end, statementEnd).trim() === ''
    )
  })
  if (blocks.length !== 1) fail(`${label} must contain exactly one real ${delimiter} DO block`)
  return blocks[0].body
}

function normalSqlStatements(source, label) {
  return topLevelSqlStatements(source, label).map((statement) => statement.code)
}

function matchingAclStatements(statements, definition, verb) {
  const signaturePattern = exactFunctionIdentityPattern(definition)
  const headPattern =
    verb === 'GRANT'
      ? /^GRANT\s+EXECUTE\s+ON\s+FUNCTION\b/iu
      : /^REVOKE\s+ALL(?:\s+PRIVILEGES)?\s+ON\s+FUNCTION\b/iu
  return statements.filter(
    (statement) => headPattern.test(statement) && signaturePattern.test(statement)
  )
}

function assertExplicitServiceRoleAcl(statements, definition) {
  const revokes = matchingAclStatements(statements, definition, 'REVOKE')
  const grants = matchingAclStatements(statements, definition, 'GRANT')
  if (
    revokes.length !== 1 ||
    !/\bFROM\s+PUBLIC\s*,\s*anon\s*,\s*authenticated\s*,\s*service_role\s*$/iu.test(revokes[0])
  ) {
    fail(`ACL evidence does not explicitly close non-owner EXECUTE: ${definition.name}`)
  }
  if (grants.length !== 1 || !/\bTO\s+service_role\s*$/iu.test(grants[0])) {
    fail(`ACL evidence does not grant only service_role EXECUTE: ${definition.name}`)
  }
}

function assertOneStructuralMatch(structure, pattern, message) {
  const flags = [...new Set(`${pattern.flags.replace('g', '')}g`)].join('')
  const matches = [...structure.matchAll(new RegExp(pattern.source, flags))]
  if (matches.length !== 1) fail(message)
  return matches[0].index
}

function assertRetirementExpectedOidSet(source) {
  const label = 'retirement ACL evidence migration'
  const statements = topLevelSqlStatements(source, label)
  const expectedSetStatements = statements.filter((statement) =>
    /^INSERT\s+INTO\s+pg_temp\.token_ranking_retirement_expected_functions\s*\(/iu.test(
      statement.code
    )
  )
  if (expectedSetStatements.length !== 1) {
    fail('retirement ACL evidence must contain one real expected-function INSERT')
  }
  const expectedSetLexical = lexSql(expectedSetStatements[0].raw, label)
  const signatures = expectedSetLexical.singleQuoted
    .filter((literal) =>
      /^\s*::\s*pg_catalog\.regprocedure\b/iu.test(expectedSetLexical.masked.slice(literal.end))
    )
    .map((literal) => literal.value)
    .sort()
  const expected = [...RETIREMENT_ACL_FUNCTION_SIGNATURES].sort()
  if (
    signatures.length !== expected.length ||
    signatures.some((signature, index) => signature !== expected[index])
  ) {
    fail('retirement ACL expected OID set must contain exactly all seven function signatures')
  }

  const oidSnapshotStatements = statements.filter((statement) =>
    /^CREATE\s+TEMP\s+TABLE\s+token_ranking_retirement_function_oids\b/iu.test(statement.code)
  )
  if (
    oidSnapshotStatements.length !== 1 ||
    !/^CREATE\s+TEMP\s+TABLE\s+token_ranking_retirement_function_oids\s+ON\s+COMMIT\s+DROP\s+AS\s+SELECT\s+expected\.function_oid\s+FROM\s+pg_temp\.token_ranking_retirement_expected_functions\s+AS\s+expected$/iu.test(
      oidSnapshotStatements[0].code
    )
  ) {
    fail('retirement ACL OID snapshot must derive exactly from the seven-function expected set')
  }
}

function assertRetirementNormalizeBlock(source) {
  const body = uniqueDoBlock(
    source,
    '$normalize_function_acls$',
    'retirement ACL evidence migration'
  )
  const structure = structuredSql(body, 'retirement function ACL normalize block')
  const outerLoop = assertOneStructuralMatch(
    structure,
    /FOR\s+v_function\s+IN\s+SELECT\s+function_row\.oid\s*,\s*namespace_row\.nspname\s*,\s*function_row\.proname\s*,\s*pg_catalog\.pg_get_function_identity_arguments\s*\(\s*function_row\.oid\s*\)\s+AS\s+arguments\s+FROM\s+pg_catalog\.pg_proc\s+AS\s+function_row\s+JOIN\s+pg_catalog\.pg_namespace\s+AS\s+namespace_row\s+ON\s+namespace_row\.oid\s*=\s*function_row\.pronamespace\s+JOIN\s+pg_temp\.token_ranking_retirement_function_oids\s+AS\s+expected\s+ON\s+expected\.function_oid\s*=\s*function_row\.oid\s+LOOP/iu,
    'retirement ACL normalize block must iterate the exact snapshotted function OIDs'
  )
  const publicRevoke = assertOneStructuralMatch(
    structure,
    new RegExp(
      `EXECUTE\\s+pg_catalog\\.format\\s*\\(\\s*${escapeRegex(
        literalMarker('REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM PUBLIC CASCADE')
      )}\\s*,\\s*v_function\\.nspname\\s*,\\s*v_function\\.proname\\s*,\\s*v_function\\.arguments\\s*\\)\\s*;`,
      'iu'
    ),
    'retirement ACL normalize block must dynamically revoke PUBLIC with CASCADE'
  )
  const granteeLoop = assertOneStructuralMatch(
    structure,
    new RegExp(
      `FOR\\s+v_grantee\\s+IN\\s+SELECT\\s+DISTINCT\\s+privilege\\.grantee\\s+FROM\\s+pg_catalog\\.pg_proc\\s+AS\\s+function_row\\s+CROSS\\s+JOIN\\s+LATERAL\\s+pg_catalog\\.aclexplode\\s*\\(\\s*COALESCE\\s*\\(\\s*function_row\\.proacl\\s*,\\s*pg_catalog\\.acldefault\\s*\\(\\s*${escapeRegex(
        literalMarker('f')
      )}\\s*,\\s*function_row\\.proowner\\s*\\)\\s*\\)\\s*\\)\\s+AS\\s+privilege\\s+WHERE\\s+function_row\\.oid\\s*=\\s*v_function\\.oid\\s+AND\\s+privilege\\.grantee\\s*<>\\s*0\\s+AND\\s+privilege\\.grantee\\s*<>\\s*function_row\\.proowner\\s+LOOP`,
      'iu'
    ),
    'retirement ACL normalize block must enumerate every direct non-owner grantee'
  )
  const roleLookup = assertOneStructuralMatch(
    structure,
    /SELECT\s+role_row\.rolname\s+INTO\s+STRICT\s+v_grantee_name\s+FROM\s+pg_catalog\.pg_roles\s+AS\s+role_row\s+WHERE\s+role_row\.oid\s*=\s*v_grantee\s*;/iu,
    'retirement ACL normalize block must resolve every enumerated grantee exactly'
  )
  const granteeRevoke = assertOneStructuralMatch(
    structure,
    new RegExp(
      `EXECUTE\\s+pg_catalog\\.format\\s*\\(\\s*${escapeRegex(
        literalMarker('REVOKE ALL PRIVILEGES ON FUNCTION %I.%I(%s) FROM %I CASCADE')
      )}\\s*,\\s*v_function\\.nspname\\s*,\\s*v_function\\.proname\\s*,\\s*v_function\\.arguments\\s*,\\s*v_grantee_name\\s*\\)\\s*;`,
      'iu'
    ),
    'retirement ACL normalize block must dynamically revoke every named grantee with CASCADE'
  )
  if (
    !(
      outerLoop < publicRevoke &&
      publicRevoke < granteeLoop &&
      granteeLoop < roleLookup &&
      roleLookup < granteeRevoke
    ) ||
    !/END\s+LOOP\s*;\s*END\s+LOOP\s*;\s*END$/iu.test(structure)
  ) {
    fail('retirement ACL normalize block control flow is incomplete')
  }
}

function assertRetirementPostflight(source) {
  const body = uniqueDoBlock(source, '$postflight$', 'retirement ACL evidence migration')
  const structure = structuredSql(body, 'retirement ACL postflight')
  assertOneStructuralMatch(
    structure,
    new RegExp(
      `v_head\\s+pg_catalog\\.regprocedure\\s*:=\\s*${escapeRegex(
        literalMarker('public.get_token_ranking_publication_head()')
      )}\\s*::\\s*pg_catalog\\.regprocedure\\s*;`,
      'iu'
    ),
    'retirement ACL postflight must pin the exact publication-head OID'
  )
  const aclDefault = `pg_catalog\\.acldefault\\s*\\(\\s*${escapeRegex(
    literalMarker('f')
  )}\\s*,\\s*function_row\\.proowner\\s*\\)`
  const exactServicePrivilege =
    `privilege\\.grantee\\s*=\\s*${escapeRegex(
      literalMarker('service_role')
    )}\\s*::\\s*pg_catalog\\.regrole\\s+AND\\s+` +
    `privilege\\.grantor\\s*=\\s*function_row\\.proowner\\s+AND\\s+` +
    `privilege\\.privilege_type\\s*=\\s*${escapeRegex(
      literalMarker('EXECUTE')
    )}\\s+AND\\s+NOT\\s+privilege\\.is_grantable`
  const ownerOnlyCheck = assertOneStructuralMatch(
    structure,
    new RegExp(
      `OR\\s+EXISTS\\s*\\(\\s*SELECT\\s+1\\s+FROM\\s+pg_temp\\.token_ranking_retirement_function_oids\\s+AS\\s+expected\\s+JOIN\\s+pg_catalog\\.pg_proc\\s+AS\\s+function_row\\s+ON\\s+function_row\\.oid\\s*=\\s*expected\\.function_oid\\s+CROSS\\s+JOIN\\s+LATERAL\\s+pg_catalog\\.aclexplode\\s*\\(\\s*COALESCE\\s*\\(\\s*function_row\\.proacl\\s*,\\s*${aclDefault}\\s*\\)\\s*\\)\\s+AS\\s+privilege\\s+WHERE\\s+privilege\\.grantee\\s*<>\\s*function_row\\.proowner\\s+AND\\s+NOT\\s*\\(\\s*function_row\\.oid\\s*=\\s*v_head\\s+AND\\s+${exactServicePrivilege}\\s*\\)\\s*\\)`,
      'iu'
    ),
    'retirement ACL postflight must reject every non-owner ACL except exact head service EXECUTE'
  )
  const exactHeadCount = assertOneStructuralMatch(
    structure,
    new RegExp(
      `OR\\s*\\(\\s*SELECT\\s+pg_catalog\\.count\\s*\\(\\s*\\*\\s*\\)\\s+FROM\\s+pg_catalog\\.pg_proc\\s+AS\\s+function_row\\s+CROSS\\s+JOIN\\s+LATERAL\\s+pg_catalog\\.aclexplode\\s*\\(\\s*COALESCE\\s*\\(\\s*function_row\\.proacl\\s*,\\s*${aclDefault}\\s*\\)\\s*\\)\\s+AS\\s+privilege\\s+WHERE\\s+function_row\\.oid\\s*=\\s*v_head\\s+AND\\s+${exactServicePrivilege}\\s*\\)\\s*<>\\s*1\\s+THEN\\s+RAISE\\s+EXCEPTION\\s+${escapeRegex(
        literalMarker('legacy token-ranking function ACL postflight failed')
      )}\\s*;`,
      'iu'
    ),
    'retirement ACL postflight must require exactly one non-grantable head service EXECUTE'
  )
  if (ownerOnlyCheck >= exactHeadCount) {
    fail('retirement ACL postflight catalog checks are out of order')
  }
}

function assertRetirementMigrationAclContract(source) {
  assertRetirementExpectedOidSet(source)
  assertRetirementNormalizeBlock(source)
  assertRetirementPostflight(source)
}

function uniqueAssertedPsqlQuery(source, label, expected, errorMessage) {
  const matches = assertedPsqlQueries(source, label).filter(
    (binding) => binding.expected === expected
  )
  if (matches.length !== 1) fail(errorMessage)
  const binding = matches[0]
  const statements = topLevelSqlStatements(binding.query, `${label} ${binding.variable} query`)
  if (statements.length !== 1) fail(errorMessage)
  return structuredSql(binding.query, `${label} ${binding.variable} query`)
}

function exactHasFunctionPrivilegePattern(role, signature) {
  return new RegExp(
    `pg_catalog\\.has_function_privilege\\s*\\(\\s*${escapeRegex(
      literalMarker(role)
    )}\\s*,\\s*${escapeRegex(literalMarker(signature))}\\s*,\\s*${escapeRegex(
      literalMarker('EXECUTE')
    )}\\s*\\)`,
    'iu'
  )
}

function assertServiceAclPsqlEvidence(source, definition) {
  const errorMessage = `retirement PG17 ACL evidence is incomplete: ${definition.name}`
  const structure = uniqueAssertedPsqlQuery(
    source,
    definition.aclEvidence.test,
    'true|false|false|false|false|false|false',
    errorMessage
  )
  const exactCall = exactHasFunctionPrivilegePattern('service_role', definition.signature)
  const firstResult = new RegExp(
    `^SELECT\\s+${exactCall.source}\\s*\\|\\|\\s*${escapeRegex(literalMarker('|'))}\\s*\\|\\|`,
    'iu'
  )
  if (!firstResult.test(structure)) fail(errorMessage)
}

function assertOwnerOnlyAclPsqlEvidence(source, definition) {
  const errorMessage = `retirement PG17 owner-only ACL evidence is incomplete: ${definition.name}`
  const structure = uniqueAssertedPsqlQuery(
    source,
    definition.aclEvidence.test,
    '0|0|1|true',
    errorMessage
  )
  const closedFunctionsStart = structure.search(
    /\bclosed_functions\s*\(\s*function_oid\s*\)\s+AS\s*\(\s*VALUES\b/iu
  )
  const closedRelationsStart = structure.search(
    /\bclosed_relations\s*\(\s*relation_oid\s*\)\s+AS\s*\(\s*VALUES\b/iu
  )
  if (closedFunctionsStart === -1 || closedRelationsStart <= closedFunctionsStart) {
    fail(errorMessage)
  }
  const closedFunctionSet = structure.slice(closedFunctionsStart, closedRelationsStart)
  if (
    !new RegExp(
      `${escapeRegex(literalMarker(definition.signature))}\\s*::\\s*pg_catalog\\.regprocedure`,
      'iu'
    ).test(closedFunctionSet)
  ) {
    fail(errorMessage)
  }
  const countClosedPrivileges = new RegExp(
    `SELECT\\s+pg_catalog\\.count\\s*\\(\\s*\\*\\s*\\)\\s+FROM\\s+runtime_roles\\s+CROSS\\s+JOIN\\s+closed_functions\\s+WHERE\\s+pg_catalog\\.has_function_privilege\\s*\\(\\s*runtime_roles\\.role_oid\\s*,\\s*closed_functions\\.function_oid\\s*,\\s*${escapeRegex(
      literalMarker('EXECUTE')
    )}\\s*\\)`,
    'iu'
  )
  if (!countClosedPrivileges.test(structure)) fail(errorMessage)
}

function assertRetirementPg17Acl(statements, definition, pg17Evidence) {
  const grants = matchingAclStatements(statements, definition, 'GRANT')
  if (definition.expectedAcl === 'service_role-execute-only') {
    if (grants.length !== 1 || !/\bTO\s+service_role\s*$/iu.test(grants[0])) {
      fail(`retirement ACL evidence does not retain only service_role: ${definition.name}`)
    }
    assertServiceAclPsqlEvidence(pg17Evidence, definition)
  } else {
    if (grants.length !== 0) {
      fail(`retirement ACL evidence unexpectedly grants non-owner EXECUTE: ${definition.name}`)
    }
    assertOwnerOnlyAclPsqlEvidence(pg17Evidence, definition)
  }
}

function ledgerStatementsSha256(contents) {
  let sql
  try {
    sql = new TextDecoder('utf-8', { fatal: true }).decode(contents)
  } catch {
    fail('defining migration must contain valid UTF-8 SQL')
  }
  return sha256(JSON.stringify({ kind: 'sql-statements', value: [sql] }))
}

function assertInventoryAttestation(inventory) {
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) {
    fail('launch inventory must be an object')
  }
  const { inventorySha256, ...attested } = inventory
  if (typeof inventorySha256 !== 'string' || canonicalJsonSha256(attested) !== inventorySha256) {
    fail('launch inventory attestation is invalid')
  }
}

function validateDefinitions(definitions) {
  if (!Array.isArray(definitions) || definitions.length !== 5) {
    fail('V1 missing RPC crosswalk must contain exactly five definitions')
  }
  const names = new Set()
  const signatures = new Set()
  for (const definition of definitions) {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      fail('V1 missing RPC definition must be an object')
    }
    for (const field of ['name', 'signature', 'definingMigration', 'endState', 'expectedAcl']) {
      if (typeof definition[field] !== 'string' || definition[field].length === 0) {
        fail(`V1 missing RPC definition ${field} is invalid`)
      }
    }
    if (!EXPECTED_ACL_VALUES.has(definition.expectedAcl)) {
      fail('V1 missing RPC definition expectedAcl is unsupported')
    }
    if (
      !definition.aclEvidence ||
      typeof definition.aclEvidence !== 'object' ||
      Array.isArray(definition.aclEvidence) ||
      !ACL_EVIDENCE_KINDS.has(definition.aclEvidence.kind) ||
      typeof definition.aclEvidence.migration !== 'string' ||
      !/^202\d{11}_[a-z0-9][a-z0-9_]*\.sql$/u.test(definition.aclEvidence.migration)
    ) {
      fail('V1 missing RPC definition ACL evidence is invalid')
    }
    if (
      definition.aclEvidence.kind === 'explicit-service-role' &&
      (definition.expectedAcl !== 'service_role-execute-only' ||
        definition.aclEvidence.migration !== definition.definingMigration ||
        definition.aclEvidence.test !== undefined)
    ) {
      fail('explicit ACL evidence must bind its service-only defining migration')
    }
    if (
      definition.aclEvidence.kind === 'retirement-pg17-matrix' &&
      (typeof definition.aclEvidence.test !== 'string' ||
        !definition.tests.includes(definition.aclEvidence.test))
    ) {
      fail('retirement ACL evidence must bind a listed PG17 test')
    }
    for (const field of ['consumers', 'tests']) {
      if (!Array.isArray(definition[field]) || definition[field].length === 0) {
        fail(`V1 missing RPC definition ${field} must be non-empty`)
      }
      const sorted = [...definition[field]].sort()
      if (new Set(sorted).size !== sorted.length) {
        fail(`V1 missing RPC definition ${field} contains duplicates`)
      }
    }
    if (names.has(definition.name) || signatures.has(definition.signature)) {
      fail('V1 missing RPC definition identity is duplicated')
    }
    names.add(definition.name)
    signatures.add(definition.signature)
  }
}

function assertMigrationOrder(predeploy) {
  let previous = -1
  for (const migration of REQUIRED_RANKING_MIGRATION_ORDER) {
    const index = predeploy.migrations.findIndex((candidate) => candidate.file === migration)
    if (index === -1) fail(`required ranking migration is absent from predeploy: ${migration}`)
    if (index <= previous) fail(`required ranking migration is out of order: ${migration}`)
    previous = index
  }
}

export function buildMissingRpcCrosswalk({
  definitions = MISSING_RPC_DEFINITIONS,
  inventory = buildLaunchMigrationInventory(),
  repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
} = {}) {
  validateDefinitions(definitions)
  assertInventoryAttestation(inventory)
  const physicalRepoRoot = realpathSync(repoRoot)
  const predeploy = inventory.phases?.find((phase) => phase.name === 'predeploy')
  if (!predeploy) fail('predeploy launch inventory is missing')
  assertMigrationOrder(predeploy)
  const inventoryByFile = new Map(
    predeploy.migrations.map((migration) => [migration.file, migration])
  )
  const databaseTypes = readTrustedFile(physicalRepoRoot, DATABASE_TYPES_PATH)
  const databaseTypesSource = parseTypeScriptEvidence(databaseTypes, DATABASE_TYPES_PATH)
  const readAttestedMigration = (migrationFile, evidenceLabel) => {
    const migrationInventory = inventoryByFile.get(migrationFile)
    if (!migrationInventory) fail(`${evidenceLabel} is not in predeploy: ${migrationFile}`)
    const migrationPath = `supabase/migrations/${migrationFile}`
    const contents = readTrustedFile(physicalRepoRoot, migrationPath)
    const digest = sha256(contents)
    if (
      migrationInventory.path !== migrationPath ||
      migrationInventory.file !== migrationFile ||
      migrationInventory.version !== migrationFile.slice(0, 14) ||
      migrationInventory.sha256 !== digest ||
      migrationInventory.ledgerStatementsSha256 !== ledgerStatementsSha256(contents)
    ) {
      fail(`${evidenceLabel} inventory changed or is inconsistent`)
    }
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(contents)
    } catch {
      fail(`${evidenceLabel} must contain valid UTF-8 SQL`)
    }
    return { contents, digest, inventory: migrationInventory, path: migrationPath, text }
  }
  const rpcs = definitions.map((definition) => {
    const definingMigration = readAttestedMigration(
      definition.definingMigration,
      `defining migration for ${definition.name}`
    )
    const definingMigrationCode = maskSqlNonCode(
      definingMigration.text,
      `defining migration for ${definition.name}`
    )
    if (!exactCreateHeaderPattern(definition).test(definingMigrationCode)) {
      fail(`defining migration does not contain exact RPC signature: ${definition.name}`)
    }
    const aclMigration = readAttestedMigration(
      definition.aclEvidence.migration,
      `ACL evidence migration for ${definition.name}`
    )
    const aclMigrationCode = maskSqlNonCode(
      aclMigration.text,
      `ACL evidence migration for ${definition.name}`
    )
    if (!exactCreateHeaderPattern(definition).test(aclMigrationCode)) {
      fail(`ACL evidence migration does not define exact RPC signature: ${definition.name}`)
    }
    const aclStatements = normalSqlStatements(
      aclMigration.text,
      `ACL evidence migration for ${definition.name}`
    )
    let aclProofTest
    if (definition.aclEvidence.kind === 'explicit-service-role') {
      assertExplicitServiceRoleAcl(aclStatements, definition)
    } else {
      assertRetirementMigrationAclContract(aclMigration.text)
      const proofTestContents = readTrustedFile(physicalRepoRoot, definition.aclEvidence.test)
      const proofTestText = proofTestContents.toString('utf8')
      assertRetirementPg17Acl(aclStatements, definition, proofTestText)
      aclProofTest = {
        path: definition.aclEvidence.test,
        sha256: sha256(proofTestContents),
      }
    }
    if (!hasGeneratedRpcProperty(databaseTypesSource, definition.name)) {
      fail(`generated database types do not contain RPC: ${definition.name}`)
    }
    const evidenceFiles = [...definition.consumers, ...definition.tests].sort().map((file) => {
      const contents = readTrustedFile(physicalRepoRoot, file)
      const referenced = definition.consumers.includes(file)
        ? /\.tsx?$/u.test(file) &&
          hasRuntimeRpcCall(parseTypeScriptEvidence(contents, file), definition.name)
        : hasTestReference(contents, file, definition.name)
      if (!referenced) {
        fail(`crosswalk evidence file does not reference ${definition.name}: ${file}`)
      }
      return { path: file, sha256: sha256(contents) }
    })
    return {
      aclEvidence: {
        kind: definition.aclEvidence.kind,
        migration: {
          ledgerStatementsSha256: aclMigration.inventory.ledgerStatementsSha256,
          path: aclMigration.path,
          sha256: aclMigration.digest,
          version: aclMigration.inventory.version,
        },
        ...(aclProofTest ? { test: aclProofTest } : {}),
      },
      consumers: [...definition.consumers].sort(),
      definingMigration: {
        ledgerStatementsSha256: definingMigration.inventory.ledgerStatementsSha256,
        path: definingMigration.path,
        sha256: definingMigration.digest,
        version: definingMigration.inventory.version,
      },
      endState: definition.endState,
      expectedAcl: definition.expectedAcl,
      name: definition.name,
      repositoryEvidence: evidenceFiles,
      signature: definition.signature,
      tests: [...definition.tests].sort(),
    }
  })
  rpcs.sort((left, right) => left.name.localeCompare(right.name, 'en'))
  const attested = {
    contract: V1_MISSING_RPC_CROSSWALK_CONTRACT,
    historicalLiveObservation: {
      observedAt: '2026-08-04T19:15:53.362Z',
      state: 'five-rpcs-missing/historical-read-only-snapshot',
    },
    inventorySha256: inventory.inventorySha256,
    requiredMigrationOrder: [...REQUIRED_RANKING_MIGRATION_ORDER],
    rpcs,
    status: V1_MISSING_RPC_CROSSWALK_STATUS,
    warning:
      'Repository definitions and historical absence do not prove current live state or authorize migration execution.',
  }
  return Object.freeze({ ...attested, crosswalkSha256: canonicalJsonSha256(attested) })
}

function runCli(argv = process.argv.slice(2)) {
  if (argv.length !== 0) {
    process.stderr.write('Usage: node scripts/qa/v1-missing-rpc-crosswalk.mjs\n')
    return 2
  }
  try {
    process.stdout.write(`${JSON.stringify(buildMissingRpcCrosswalk(), null, 2)}\n`)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`V1 missing RPC crosswalk refused: ${message}\n`)
    return 1
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) process.exitCode = runCli()
