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

export const LAUNCH_MIGRATION_INVENTORY_CONTRACT = 'arena.launch-migration-inventory@1'
export const LAUNCH_MIGRATION_INVENTORY_STATUS = 'inventory/read-only-not-live-evidence'

export const LAUNCH_MIGRATION_PHASES = Object.freeze([
  Object.freeze({ name: 'baselineGap', sourceArray: 'BASELINE_GAP_MIGRATIONS' }),
  Object.freeze({ name: 'predeploy', sourceArray: 'PREDEPLOY_MIGRATIONS' }),
  Object.freeze({ name: 'trailingMcp', sourceArray: 'TRAILING_MCP_MIGRATIONS' }),
  Object.freeze({
    name: 'quarantinedPredeploy',
    sourceArray: 'QUARANTINED_PREDEPLOY_MIGRATIONS',
  }),
  Object.freeze({ name: 'postdeploy', sourceArray: 'POSTDEPLOY_MIGRATIONS' }),
  Object.freeze({
    name: 'recoveryPrerequisites',
    sourceArray: 'RECOVERY_PREREQUISITE_MIGRATIONS',
  }),
  Object.freeze({
    name: 'concurrentRecovery',
    sourceArray: 'CONCURRENT_RECOVERY_MIGRATIONS',
  }),
  Object.freeze({ name: 'recovery', sourceArray: 'RECOVERY_MIGRATIONS' }),
  Object.freeze({ name: 'superseded', sourceArray: 'SUPERSEDED_MIGRATIONS' }),
])

export const LAUNCH_RUNNER_READONLY_ARRAYS = Object.freeze([
  ...LAUNCH_MIGRATION_PHASES.map(({ sourceArray }) => sourceArray),
  'TIP_CHECKOUT_CUTOVER_VERSIONS',
  'SUPERSEDING_VERSIONS',
])

const LAUNCH_RUNNER_READONLY_ARRAY_SET = new Set(LAUNCH_RUNNER_READONLY_ARRAYS)

const MIGRATION_FILE_PATTERN = /^(202\d{11})_([a-z0-9][a-z0-9_]*)\.sql$/u

function fail(message) {
  throw new Error(message)
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

function ledgerStatementsSha256(contents) {
  let sql
  try {
    sql = new TextDecoder('utf-8', { fatal: true }).decode(contents)
  } catch {
    fail('migration file must contain valid UTF-8 SQL')
  }
  return sha256(JSON.stringify({ kind: 'sql-statements', value: [sql] }))
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    )
  }
  return value
}

function resolveTrustedDirectory(root, relativePath, label) {
  let current = root
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment)
    let metadata
    try {
      metadata = lstatSync(current)
    } catch {
      fail(`${label} does not exist`)
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      fail(`${label} must not contain symlinked directories`)
    }
  }
  const physicalPath = realpathSync(current)
  const relative = path.relative(root, physicalPath)
  if (relative === '' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`${label} resolves outside repository`)
  }
  return physicalPath
}

function directoryIdentity(directoryPath, label) {
  const metadata = lstatSync(directoryPath, { bigint: true })
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    fail(`${label} changed during inventory`)
  return { dev: metadata.dev, ino: metadata.ino }
}

function assertDirectoryIdentity(directoryPath, expected, label) {
  const actual = directoryIdentity(directoryPath, label)
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    fail(`${label} changed during inventory`)
  }
}

export function canonicalJsonSha256(value) {
  return sha256(JSON.stringify(canonicalize(value)))
}

function stripShellComment(line) {
  let quote = null
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (quote === "'") {
      if (character === "'") quote = null
      continue
    }
    if (quote === '"') {
      if (character === '\\') escaped = true
      else if (character === '"') quote = null
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === '#' && (index === 0 || /[\s;&|()<>]/u.test(line[index - 1]))) {
      return line.slice(0, index)
    }
  }
  return line
}

function heredocDeclarations(line) {
  const declarations = []
  let quote = null
  let escaped = false
  for (let index = 0; index < line.length - 1; index += 1) {
    const character = line[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (quote === "'") {
      if (character === "'") quote = null
      continue
    }
    if (quote === '"') {
      if (character === '\\') escaped = true
      else if (character === '"') quote = null
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (
      character !== '<' ||
      line[index + 1] !== '<' ||
      line[index + 2] === '<' ||
      line[index + 2] === '='
    ) {
      continue
    }

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
      if (end === -1) fail('launch migration source has an invalid heredoc delimiter')
      delimiter = line.slice(cursor, end)
      cursor = end + 1
    } else {
      if (line[cursor] === '\\') cursor += 1
      const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(line.slice(cursor))
      if (!match) fail('launch migration source has an unsupported heredoc delimiter')
      delimiter = match[0]
      cursor += delimiter.length
    }
    if (!delimiter) fail('launch migration source has an empty heredoc delimiter')
    declarations.push(Object.freeze({ delimiter, stripTabs }))
    index = cursor - 1
  }
  return declarations
}

function executableShellSurface(source) {
  const pendingHeredocs = []
  const surface = []
  for (const line of source.split('\n')) {
    if (pendingHeredocs.length > 0) {
      const active = pendingHeredocs[0]
      const candidate = active.stripTabs ? line.replace(/^\t+/u, '') : line
      if (candidate === active.delimiter) pendingHeredocs.shift()
      surface.push('')
      continue
    }
    const withoutComment = stripShellComment(line)
    surface.push(withoutComment)
    pendingHeredocs.push(...heredocDeclarations(withoutComment))
  }
  if (pendingHeredocs.length > 0) fail('launch migration source has an unterminated heredoc')
  return surface.join('\n')
}

function arithmeticExpressions(surface) {
  const expressions = []
  for (let index = 0; index < surface.length - 1; index += 1) {
    const arithmeticExpansion =
      surface[index] === '$' && surface[index + 1] === '(' && surface[index + 2] === '('
    const arithmeticCommand =
      surface[index] === '(' &&
      surface[index + 1] === '(' &&
      (index === 0 || surface[index - 1] !== '$')
    if (!arithmeticExpansion && !arithmeticCommand) continue
    const expressionStart = index + (arithmeticExpansion ? 3 : 2)
    let nestedParentheses = 0
    let cursor = expressionStart
    for (; cursor < surface.length - 1; cursor += 1) {
      if (surface[cursor] === '(') {
        nestedParentheses += 1
        continue
      }
      if (surface[cursor] !== ')') continue
      if (nestedParentheses > 0) {
        nestedParentheses -= 1
        continue
      }
      if (surface[cursor + 1] === ')') break
    }
    if (cursor >= surface.length - 1) {
      fail('launch migration source has an unterminated arithmetic expression')
    }
    expressions.push(surface.slice(expressionStart, cursor))
    index = cursor + 1
  }
  return expressions
}

function commandUsesShortOption(surface, command, option) {
  const commandPattern = new RegExp(`\\b${command}\\b([^\\n;|&]*)`, 'gu')
  for (const match of surface.matchAll(commandPattern)) {
    const tokens = match[1].trim().match(/(?:'[^']*'|"[^"]*"|\\.|[^\s])+/gu) ?? []
    for (const token of tokens) {
      const normalized = token.replace(/['"\\]/gu, '')
      if (!normalized.startsWith('-') || normalized === '--') break
      if (normalized.slice(1).includes(option)) return true
    }
  }
  return false
}

function normalizeShellWordSpellings(surface) {
  let normalized = ''
  let quote = null
  for (let index = 0; index < surface.length; index += 1) {
    const character = surface[index]
    if (quote === "'") {
      if (character === "'") quote = null
      else normalized += character
      continue
    }
    if (quote === '"') {
      if (character === '"') {
        quote = null
        continue
      }
      if (character === '\\') {
        const next = surface[index + 1]
        if (next === '$' || next === '`' || next === '"' || next === '\\' || next === '\n') {
          if (next !== '\n') normalized += next
          index += 1
          continue
        }
      }
      normalized += character
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === '\\') {
      if (index + 1 >= surface.length) fail('launch migration source has a dangling escape')
      const next = surface[index + 1]
      if (next !== '\n') normalized += next
      index += 1
      continue
    }
    normalized += character
  }
  if (quote !== null) fail('launch migration source has an unterminated shell quote')
  return normalized
}

const APPROVED_TRAP_COMMANDS = new Set([
  'trap - EXIT INT TERM',
  'trap cleanup_ordered_predeploy_snapshot EXIT',
  'trap exit 130 INT',
  'trap exit 143 TERM',
])

function assertOnlyApprovedTrapCommands(surface, arrayName) {
  for (const line of surface.split('\n')) {
    if (!/\btrap\b/u.test(line)) continue
    const normalizedLine = line.trim().replace(/\s+/gu, ' ')
    if (!APPROVED_TRAP_COMMANDS.has(normalizedLine)) {
      fail(`${arrayName} must not be mutated indirectly after declaration`)
    }
  }
}

function removeOtherExactReadonlyDeclarations(surface, arrayName) {
  return surface
    .split('\n')
    .map((line) => {
      const match = /^\s*readonly\s+-a\s+([A-Z][A-Z0-9_]*)\s*$/u.exec(line)
      if (!match) return line
      if (match[1] === arrayName) {
        fail(`${arrayName} must have one exact readonly declaration immediately after its array`)
      }
      return LAUNCH_RUNNER_READONLY_ARRAY_SET.has(match[1]) ? '' : line
    })
    .join('\n')
}

function assertNoIndirectArrayMutation(source, arrayName) {
  const surface = removeOtherExactReadonlyDeclarations(
    normalizeShellWordSpellings(executableShellSurface(source)),
    arrayName
  )
  assertOnlyApprovedTrapCommands(surface, arrayName)
  const forbiddenBuiltin =
    /\b(?:alias|coproc|declare|enable|eval|export|getopts|let|mapfile|read|readarray|readonly|source|typeset|unset)\b/u
  const printfVariableAssignment = commandUsesShortOption(surface, 'printf', 'v')
  const localNameref = commandUsesShortOption(surface, 'local', 'n')
  const waitVariableAssignment = commandUsesShortOption(surface, 'wait', 'p')
  const dotSourceCommand =
    /(?:^|[\n;|&({]|\b(?:builtin|command|do|elif|else|if|then|time|until|while)\b)\s*\.\s+/u
  const loopTarget = new RegExp(`\\b(?:for|select)\\s+${arrayName}\\b`, 'u')
  const directAssignment = new RegExp(
    `\\b${arrayName}(?:\\[[^\\]\\n]+\\])?\\s*(?:\\+=|=(?!=))`,
    'u'
  )
  const parameterDefaultAssignment = new RegExp(`\\$\\{${arrayName}(?:\\[[^\\]\\n]+\\])?:?=`, 'u')
  if (
    forbiddenBuiltin.test(surface) ||
    printfVariableAssignment ||
    localNameref ||
    waitVariableAssignment ||
    dotSourceCommand.test(surface) ||
    loopTarget.test(surface) ||
    directAssignment.test(surface) ||
    parameterDefaultAssignment.test(surface)
  ) {
    fail(`${arrayName} must not be mutated indirectly after declaration`)
  }

  const directArithmeticMutation = new RegExp(
    `(?:\\b${arrayName}\\s*\\[[^\\]\\n]+\\]\\s*(?:\\+\\+|--|\\*\\*=|<<=|>>=|[+*/%&|^?-]?=)|(?:\\+\\+|--)\\s*${arrayName}\\s*\\[)`,
    'u'
  )
  for (const expression of arithmeticExpressions(surface)) {
    const hasMutation = /(?:\+\+|--|\*\*=|<<=|>>=|(?<![=!<>])[+*/%&|^?-]?=(?!=))/u.test(expression)
    if (
      directArithmeticMutation.test(expression) ||
      (hasMutation && /\$(?:\{|[A-Za-z_])/u.test(expression))
    ) {
      fail(`${arrayName} must not be mutated indirectly after declaration`)
    }
  }
}

function readonlyArrayDeclaration(source, arrayName, requireReadonly) {
  const marker = new RegExp(`^${arrayName}=\\(\\n`, 'mu')
  const match = marker.exec(source)
  if (!match) fail(`${arrayName} is missing`)
  const bodyStart = match.index + match[0].length
  const end = source.indexOf('\n)', bodyStart)
  if (end === -1) fail(`${arrayName} is not terminated`)
  const readonlyDeclaration = `\nreadonly -a ${arrayName}\n`
  const readonlyStart = end + 2
  const hasExactReadonly = source.startsWith(readonlyDeclaration, readonlyStart)
  if (requireReadonly && !hasExactReadonly) {
    fail(`${arrayName} must have one exact readonly declaration immediately after its array`)
  }
  const readonlyEnd = hasExactReadonly ? readonlyStart + readonlyDeclaration.length : readonlyStart
  const assignmentPattern = new RegExp(
    `^[ \\t]*(?:(?:declare|typeset|local|readonly)(?:[ \\t]+-[A-Za-z]+)*[ \\t]+)?${arrayName}(?:\\[[^\\]\\n]+\\])?[ \\t]*\\+?=`,
    'gmu'
  )
  const assignments = [...source.matchAll(assignmentPattern)]
  if (
    assignments.length !== 1 ||
    assignments[0].index !== match.index ||
    assignments[0][0] !== `${arrayName}=`
  ) {
    fail(`${arrayName} must have one direct immutable declaration`)
  }
  const outsideDeclaration = `${source.slice(0, match.index)}${source.slice(readonlyEnd)}`
  assertNoIndirectArrayMutation(outsideDeclaration, arrayName)
  return { bodyStart, end }
}

function parseMigrationArraySource(source, arrayName, requireReadonly) {
  if (typeof source !== 'string') fail('launch migration source must be text')
  if (!/^[A-Z][A-Z0-9_]*$/u.test(arrayName)) fail('launch migration array name is invalid')
  const { bodyStart, end } = readonlyArrayDeclaration(source, arrayName, requireReadonly)
  const body = source.slice(bodyStart, end)
  const migrations = []
  const residual = body.replace(/^\s+(202\d{11}_[a-z0-9][a-z0-9_]*\.sql)\s*$/gmu, (_, file) => {
    migrations.push(file)
    return ''
  })
  if (residual.trim() !== '') fail(`${arrayName} contains an unsupported entry`)
  const seen = new Set()
  for (const migration of migrations) {
    if (!MIGRATION_FILE_PATTERN.test(migration)) fail(`${arrayName} contains an invalid migration`)
    if (seen.has(migration)) fail(`${arrayName} contains duplicate migration ${migration}`)
    seen.add(migration)
  }
  return migrations
}

export function parseMigrationArray(source, arrayName) {
  return parseMigrationArraySource(source, arrayName, true)
}

function readPinnedRegularFile(filePath, expectedParent, label) {
  let descriptor
  try {
    if (typeof fsConstants.O_NOFOLLOW !== 'number') {
      fail(`${label} cannot be read safely without O_NOFOLLOW`)
    }
    const pathMetadata = lstatSync(filePath, { bigint: true })
    if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) {
      fail(`${label} must be a regular file`)
    }
    const physicalPath = realpathSync(filePath)
    if (path.dirname(physicalPath) !== expectedParent) {
      fail(`${label} resolves outside its trusted parent`)
    }
    descriptor = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const before = fstatSync(descriptor, { bigint: true })
    if (!before.isFile() || before.dev !== pathMetadata.dev || before.ino !== pathMetadata.ino) {
      fail(`${label} changed while opening`)
    }
    const contents = readFileSync(descriptor)
    const after = fstatSync(descriptor, { bigint: true })
    const finalPathMetadata = lstatSync(filePath, { bigint: true })
    for (const field of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
      if (before[field] !== after[field] || after[field] !== finalPathMetadata[field]) {
        fail(`${label} changed while reading`)
      }
    }
    if (
      finalPathMetadata.isSymbolicLink() ||
      !finalPathMetadata.isFile() ||
      realpathSync(filePath) !== physicalPath
    ) {
      fail(`${label} changed while reading`)
    }
    return Object.freeze({
      contents,
      digest: sha256(contents),
      identity: Object.freeze(
        Object.fromEntries(
          ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map((field) => [field, after[field]])
        )
      ),
      label,
      path: filePath,
      physicalPath,
      trustedParent: expectedParent,
    })
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`${label} does not exist`)
    if (error instanceof Error && error.message.startsWith(label)) throw error
    fail(`${label} cannot be read safely`)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function assertPinnedRegularFile(attestation) {
  const observed = readPinnedRegularFile(
    attestation.path,
    attestation.trustedParent,
    attestation.label
  )
  if (
    observed.physicalPath !== attestation.physicalPath ||
    observed.digest !== attestation.digest ||
    Object.keys(attestation.identity).some(
      (field) => observed.identity[field] !== attestation.identity[field]
    )
  ) {
    fail(`${attestation.label} changed after it was inventoried`)
  }
}

export function buildLaunchMigrationInventory({
  beforeFinalAttestation,
  phaseDefinitions = LAUNCH_MIGRATION_PHASES,
  repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
} = {}) {
  if (beforeFinalAttestation !== undefined && typeof beforeFinalAttestation !== 'function') {
    fail('beforeFinalAttestation must be a function when provided')
  }
  const physicalRepoRoot = realpathSync(repoRoot)
  const repoRootIdentity = directoryIdentity(physicalRepoRoot, 'repository root')
  const sourceRelativePath = 'scripts/maintenance/apply-launch-migrations.sh'
  const sourceRoot = resolveTrustedDirectory(
    physicalRepoRoot,
    'scripts/maintenance',
    'launch migration runner parent'
  )
  const sourceRootIdentity = directoryIdentity(sourceRoot, 'launch migration runner parent')
  const sourceAttestation = readPinnedRegularFile(
    path.join(sourceRoot, 'apply-launch-migrations.sh'),
    sourceRoot,
    'launch migration runner'
  )
  const sourceBytes = sourceAttestation.contents
  const source = sourceBytes.toString('utf8')
  const migrationsRoot = resolveTrustedDirectory(
    physicalRepoRoot,
    'supabase/migrations',
    'migrations root'
  )
  const migrationsRootIdentity = directoryIdentity(migrationsRoot, 'migrations root')
  const migrationAttestations = []
  if (!Array.isArray(phaseDefinitions)) fail('launch migration phases must be an array')
  const usesCanonicalRunnerContract =
    phaseDefinitions.length === LAUNCH_MIGRATION_PHASES.length &&
    phaseDefinitions.every(
      (phase, index) =>
        phase?.name === LAUNCH_MIGRATION_PHASES[index].name &&
        phase?.sourceArray === LAUNCH_MIGRATION_PHASES[index].sourceArray
    )
  if (usesCanonicalRunnerContract) {
    readonlyArrayDeclaration(source, 'TIP_CHECKOUT_CUTOVER_VERSIONS', true)
    readonlyArrayDeclaration(source, 'SUPERSEDING_VERSIONS', true)
  }
  const phaseNames = new Set()
  const sourceArrays = new Set()
  const phases = phaseDefinitions.map(({ name, sourceArray }) => {
    if (!/^[a-z][A-Za-z0-9]*$/u.test(name)) fail('launch migration phase name is invalid')
    if (!/^[A-Z][A-Z0-9_]*$/u.test(sourceArray)) {
      fail('launch migration source array name is invalid')
    }
    if (phaseNames.has(name)) fail(`launch migration phase name is duplicated: ${name}`)
    if (sourceArrays.has(sourceArray)) {
      fail(`launch migration source array is duplicated: ${sourceArray}`)
    }
    phaseNames.add(name)
    sourceArrays.add(sourceArray)
    const files = parseMigrationArraySource(source, sourceArray, usesCanonicalRunnerContract)
    const migrationVersions = new Set()
    const migrations = files.map((file) => {
      const match = MIGRATION_FILE_PATTERN.exec(file)
      if (!match) fail(`${sourceArray} contains an invalid migration ${file}`)
      if (migrationVersions.has(match[1])) {
        fail(`${sourceArray} contains duplicate migration version ${match[1]}`)
      }
      migrationVersions.add(match[1])
      const relativePath = `supabase/migrations/${file}`
      const migrationAttestation = readPinnedRegularFile(
        path.join(migrationsRoot, file),
        migrationsRoot,
        relativePath
      )
      migrationAttestations.push(migrationAttestation)
      const contents = migrationAttestation.contents
      return Object.freeze({
        file,
        ledgerStatementsSha256: ledgerStatementsSha256(contents),
        name: match[2],
        path: relativePath,
        sha256: sha256(contents),
        version: match[1],
      })
    })
    return Object.freeze({
      count: migrations.length,
      migrationSetSha256: canonicalJsonSha256(migrations),
      migrations: Object.freeze(migrations),
      name,
      sourceArray,
    })
  })
  const attested = {
    contract: LAUNCH_MIGRATION_INVENTORY_CONTRACT,
    phases,
    source: {
      path: sourceRelativePath,
      sha256: sourceAttestation.digest,
    },
    status: LAUNCH_MIGRATION_INVENTORY_STATUS,
  }
  const hookResult = beforeFinalAttestation?.()
  if (hookResult !== undefined) {
    fail('beforeFinalAttestation must complete synchronously without returning a value')
  }
  assertDirectoryIdentity(physicalRepoRoot, repoRootIdentity, 'repository root')
  assertDirectoryIdentity(sourceRoot, sourceRootIdentity, 'launch migration runner parent')
  assertDirectoryIdentity(migrationsRoot, migrationsRootIdentity, 'migrations root')
  assertPinnedRegularFile(sourceAttestation)
  for (const migrationAttestation of migrationAttestations) {
    assertPinnedRegularFile(migrationAttestation)
  }
  assertDirectoryIdentity(physicalRepoRoot, repoRootIdentity, 'repository root')
  assertDirectoryIdentity(sourceRoot, sourceRootIdentity, 'launch migration runner parent')
  assertDirectoryIdentity(migrationsRoot, migrationsRootIdentity, 'migrations root')
  return Object.freeze({
    ...attested,
    inventorySha256: canonicalJsonSha256(attested),
  })
}

function runCli(argv = process.argv.slice(2)) {
  if (argv.length !== 0) {
    process.stderr.write('Usage: node scripts/qa/launch-migration-inventory.mjs\n')
    return 2
  }
  try {
    process.stdout.write(`${JSON.stringify(buildLaunchMigrationInventory(), null, 2)}\n`)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Launch migration inventory failed: ${message}\n`)
    return 1
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) process.exitCode = runCli()
