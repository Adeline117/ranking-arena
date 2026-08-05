import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { join, posix, relative, resolve } from 'node:path'
import test from 'node:test'
import { parseDocument } from 'yaml'

const root = resolve(import.meta.dirname, '../..')
const dockerfilePath = resolve(root, 'worker/Dockerfile.ingest')
const dockerignorePath = resolve(root, '.dockerignore')
const imageWorkflowPath = resolve(root, '.github/workflows/build-ingest-image.yml')
const dockerfileSpecificIgnorePath = resolve(root, 'worker/Dockerfile.ingest.dockerignore')

const EXPECTED_CONTEXT_SOURCES = [
  'worker/package.json',
  'worker/package-lock.json',
  'worker/.npmrc',
  'lib',
  'worker',
]

const EXCLUDED_REPOSITORY_ROOTS = [
  '.claude',
  '.cursor',
  '.githooks',
  '.github',
  'android',
  'app',
  'appstore',
  'cloudflare-worker',
  'infra',
  'ios',
  'k6',
  'public',
  'scripts',
  'specs',
  'supabase',
  'vendor',
]

const gitEnvironment = Object.freeze({
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
})

function readGit(args) {
  return execFileSync('/usr/bin/git', args, {
    cwd: root,
    encoding: 'utf8',
    env: gitEnvironment,
  })
}

function snapshotTree(directory) {
  const snapshot = []

  function visit(absolute, path) {
    const stat = lstatSync(absolute)
    const common = {
      mode: stat.mode & 0o7777,
      path,
    }
    if (stat.isDirectory()) {
      snapshot.push({ ...common, type: 'directory' })
      for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name, 'en')
      )) {
        visit(join(absolute, entry.name), path.length === 0 ? entry.name : `${path}/${entry.name}`)
      }
    } else if (stat.isFile()) {
      snapshot.push({
        ...common,
        digest: createHash('sha256').update(readFileSync(absolute)).digest('hex'),
        type: 'file',
      })
    } else {
      assert.fail(`unsupported fixture entry: ${path}`)
    }
  }

  visit(directory, '')
  return snapshot
}

function trackedEntries(paths) {
  const output = readGit(['ls-files', '--stage', '-z', '--', ...paths])
  assert.ok(output.length === 0 || output.endsWith('\0'), 'Git index output is not NUL-terminated')

  const entries = output
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const match =
        /^(?<mode>\d{6}) (?<objectId>[0-9a-f]{40}|[0-9a-f]{64}) (?<stage>[0-3])\t(?<path>.+)$/u.exec(
          record
        )
      assert.ok(match, 'Git index output is malformed')
      assert.equal(match.groups.stage, '0', `${match.groups.path} has an unresolved index stage`)
      assertCanonicalRepositoryPath(match.groups.path)
      return {
        mode: match.groups.mode,
        objectId: match.groups.objectId,
        path: match.groups.path,
      }
    })

  assert.equal(new Set(entries.map((entry) => entry.path)).size, entries.length)
  return entries
}

function trackedPaths(path) {
  return trackedEntries([path]).map((entry) => entry.path)
}

function assertCanonicalRepositoryPath(path) {
  assert.equal(path.startsWith('/'), false, `${path} must be repository-relative`)
  assert.equal(posix.normalize(path), path, `${path} is not a canonical repository path`)
  assert.doesNotMatch(path, /[\\\u0000-\u001f\u007f]/u, `${path} contains unsafe characters`)
  assert.equal(
    path.split('/').some((segment) => segment.length === 0 || segment === '.' || segment === '..'),
    false,
    `${path} contains an unsafe path segment`
  )
}

const physicalStats = new Map()

function physicalStat(path) {
  if (!physicalStats.has(path)) physicalStats.set(path, lstatSync(path))
  return physicalStats.get(path)
}

function assertPhysicalPath(path, leafKind) {
  assertCanonicalRepositoryPath(path)
  const rootStat = physicalStat(root)
  assert.equal(rootStat.isSymbolicLink(), false, 'repository root must not be a symlink')
  assert.equal(rootStat.isDirectory(), true, 'repository root must be a directory')

  const segments = path.split('/')
  let current = root
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment)
    const stat = physicalStat(current)
    assert.equal(
      stat.isSymbolicLink(),
      false,
      `${path} traverses symlink ${relative(root, current)}`
    )
    if (index < segments.length - 1 || leafKind === 'directory') {
      assert.equal(stat.isDirectory(), true, `${relative(root, current)} must be a directory`)
    } else {
      assert.equal(stat.isFile(), true, `${path} must be a regular file`)
    }
  }
}

function assertRegularTrackedFile(path) {
  assertPhysicalPath(path, 'file')
  const entries = trackedEntries([path]).filter((entry) => entry.path === path)
  assert.equal(entries.length, 1, `${path} must be tracked exactly once`)
  assert.match(entries[0].mode, /^100(?:644|755)$/u, `${path} has an unsafe Git mode`)
}

function dockerInstructions(source) {
  const instructions = []
  let logical = ''
  let startLine = 0

  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const lineNumber = index + 1
    const trimmed = rawLine.trim()
    if (logical.length === 0 && (trimmed.length === 0 || trimmed.startsWith('#'))) {
      assert.doesNotMatch(
        trimmed,
        /^#\s*(?:escape|syntax)\s*=/iu,
        'Dockerfile parser directives require explicit contract review'
      )
      continue
    }

    if (logical.length === 0) startLine = lineNumber
    const continued = /\\\s*$/u.test(rawLine)
    const fragment = continued ? rawLine.replace(/\\\s*$/u, '') : rawLine
    logical += `${logical.length === 0 ? '' : ' '}${fragment.trim()}`
    if (continued) continue

    const match = /^(?<instruction>[A-Za-z]+)\s+(?<body>.+)$/u.exec(logical)
    assert.ok(match, `malformed Dockerfile instruction at line ${startLine}`)
    instructions.push({
      body: match.groups.body,
      instruction: match.groups.instruction.toUpperCase(),
      line: startLine,
    })
    logical = ''
  }

  assert.equal(logical, '', 'Dockerfile ends with an unfinished continuation')
  return instructions
}

function contextCopySources(source) {
  const sources = []
  const stages = new Set()

  for (const instruction of dockerInstructions(source)) {
    if (instruction.instruction === 'FROM') {
      const alias = /\s+AS\s+([A-Za-z0-9_.-]+)\s*$/iu.exec(instruction.body)?.[1]
      if (alias) stages.add(alias)
      continue
    }
    assert.notEqual(
      instruction.instruction,
      'ONBUILD',
      `ONBUILD at line ${instruction.line} can bypass the reviewed context closure`
    )
    assert.notEqual(
      instruction.instruction,
      'ADD',
      `ADD at line ${instruction.line} bypasses the reviewed COPY closure`
    )
    if (instruction.instruction === 'RUN') {
      const tokens = instruction.body.trim().split(/\s+/u)
      const flags = []
      while (tokens[0]?.startsWith('--')) flags.push(tokens.shift())
      assert.equal(
        flags.some((flag) => flag === '--mount' || flag.startsWith('--mount=')),
        false,
        `RUN --mount at line ${instruction.line} can read the default build context`
      )
      continue
    }
    if (instruction.instruction !== 'COPY') continue

    assert.doesNotMatch(
      instruction.body,
      /^\s*\[/u,
      `JSON-form COPY at line ${instruction.line} requires an explicit contract update`
    )
    const tokens = instruction.body.trim().split(/\s+/u)
    const flags = []
    while (tokens[0]?.startsWith('--')) flags.push(tokens.shift())
    const from = flags.find((flag) => flag.startsWith('--from='))?.slice('--from='.length)

    if (from !== undefined) {
      assert.deepEqual(
        flags,
        [`--from=${from}`],
        `unsupported stage COPY flags at line ${instruction.line}`
      )
      assert.ok(stages.has(from), `COPY at line ${instruction.line} uses an unknown build stage`)
      continue
    }

    assert.deepEqual(flags, [], `context COPY flags at line ${instruction.line} require review`)
    assert.ok(tokens.length >= 2, `COPY at line ${instruction.line} has no destination`)
    for (const path of tokens.slice(0, -1)) {
      assert.match(path, /^[A-Za-z0-9._/-]+$/u, `dynamic COPY source at line ${instruction.line}`)
      assert.equal(path.startsWith('/'), false, `absolute COPY source at line ${instruction.line}`)
      assert.equal(
        path.split('/').some((segment) => segment === '..' || segment === ''),
        false,
        `non-canonical COPY source at line ${instruction.line}`
      )
      sources.push(path)
    }
  }

  return sources
}

function dockerignoreRules(source) {
  return source.split(/\r?\n/u).flatMap((raw, index) => {
    if (raw.length === 0 || raw.startsWith('#')) return []
    assert.equal(
      raw.trimStart().startsWith('#'),
      false,
      `.dockerignore line ${index + 1} comments must start in column 1`
    )
    assert.equal(raw, raw.trim(), `.dockerignore line ${index + 1} has ambiguous whitespace`)
    const negated = raw.startsWith('!')
    const pattern = negated ? raw.slice(1) : raw
    assert.ok(pattern.length > 0, `.dockerignore line ${index + 1} is empty`)
    assert.equal(
      pattern,
      pattern.trim(),
      `.dockerignore line ${index + 1} has whitespace after negation`
    )
    assert.equal(
      pattern.startsWith('!'),
      false,
      `.dockerignore line ${index + 1} has nested negation`
    )
    normalizedDockerPattern(pattern, `.dockerignore line ${index + 1}`)
    return [{ line: index + 1, negated, pattern }]
  })
}

function normalizedDockerPattern(pattern, label = '.dockerignore pattern') {
  assert.doesNotMatch(pattern, /[\\[\]\u0000-\u001f\u007f]/u, `${label} needs parser review`)
  const posixNormalized = posix.normalize(pattern)
  const filepathClean =
    posixNormalized.length > 1 ? posixNormalized.replace(/\/+$/u, '') : posixNormalized
  assert.equal(filepathClean, pattern, `${label} is changed by filepath.Clean`)

  const normalized = pattern.startsWith('/') ? pattern.slice(1) : pattern
  assert.ok(normalized.length > 0, `${label} cannot exclude the entire context`)
  assert.equal(normalized.startsWith('/'), false, `${label} has duplicate leading slash`)
  assert.equal(
    normalized
      .split('/')
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..'),
    false,
    `${label} contains a non-canonical path segment`
  )
  return normalized
}

// The supported subset follows Docker's root-relative filepath.Match model. Every
// rule is matched against the path and its parent paths so excluding a directory
// excludes descendants. Unsupported syntax fails during parsing instead of being
// approximated, and rule order preserves Docker's last-match negation behavior.
function patternExpression(pattern) {
  const normalized = normalizedDockerPattern(pattern)

  let expression = ''
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]
    if (character === '*' && normalized[index + 1] === '*') {
      index += 1
      if (normalized[index + 1] === '/') {
        index += 1
        expression += '(?:.*/)?'
      } else {
        expression += '.*'
      }
    } else if (character === '*') {
      expression += '[^/]*'
    } else if (character === '?') {
      expression += '[^/]'
    } else {
      expression += character.replace(/[.$^+(){}|]/gu, '\\$&')
    }
  }

  return new RegExp(`^${expression}$`, 'u')
}

function pathAndParents(path) {
  assertCanonicalRepositoryPath(path)
  const segments = path.split('/')
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'))
}

function ignored(path, rules) {
  let result = false
  const candidates = pathAndParents(path)
  for (const rule of rules) {
    const expression = patternExpression(rule.pattern)
    if (candidates.some((candidate) => expression.test(candidate))) result = !rule.negated
  }
  return result
}

function parseStrictYaml(source) {
  const document = parseDocument(source, {
    prettyErrors: false,
    uniqueKeys: true,
  })
  assert.deepEqual(
    document.errors.map((error) => error.message),
    [],
    'image workflow must be valid YAML with unique mapping keys'
  )
  assert.deepEqual(
    document.warnings.map((warning) => warning.message),
    [],
    'image workflow YAML warnings require review'
  )
  return document.toJS({ maxAliasCount: 0 })
}

function parseImageWorkflow() {
  return parseStrictYaml(readFileSync(imageWorkflowPath, 'utf8'))
}

function assertRecord(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be a map`)
}

function ignoredInputCategory(entry) {
  if (entry.path === 'lib/forge-std') return 'foundry-gitlink'
  if (entry.path === 'worker/.env.example') return 'worker-environment-template'
  if (entry.path.split('/').includes('__tests__')) return 'test-directory'
  if (/\.(?:test\.ts|test\.tsx|spec\.ts)$/u.test(entry.path)) return 'test-file'
  return undefined
}

function assertRegularIndexEntry(entry) {
  assert.match(entry.mode, /^100(?:644|755)$/u, `${entry.path} must have a regular Git mode`)
  assertPhysicalPath(entry.path, 'file')
}

test('Worker Dockerfile has an explicit, tracked root-context COPY closure', () => {
  assertRegularTrackedFile('.dockerignore')
  assertRegularTrackedFile('worker/Dockerfile.ingest')

  const sources = contextCopySources(readFileSync(dockerfilePath, 'utf8'))
  assert.deepEqual(sources, EXPECTED_CONTEXT_SOURCES)

  for (const path of sources) {
    const stat = physicalStat(resolve(root, path))
    if (stat.isDirectory()) {
      assertPhysicalPath(path, 'directory')
      assert.notEqual(trackedEntries([path]).length, 0, `${path} must contain tracked inputs`)
    } else {
      assertRegularTrackedFile(path)
    }
  }
})

test('image workflow uniquely binds the root context and root ignore policy', () => {
  assertRegularTrackedFile('.github/workflows/build-ingest-image.yml')
  const workflow = parseImageWorkflow()
  assertRecord(workflow, 'image workflow')
  assertRecord(workflow.jobs, 'image workflow jobs')

  const steps = []
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    assertRecord(job, `image workflow job ${jobName}`)
    assert.ok(Array.isArray(job.steps), `image workflow job ${jobName} must have steps`)
    for (const step of job.steps) {
      assertRecord(step, `image workflow job ${jobName} step`)
      steps.push({ jobName, step })
    }
  }

  const actionSteps = steps.filter(({ step }) => step.uses?.startsWith('docker/build-push-action@'))
  const quarantineSteps = steps.filter(({ step }) => step.id === 'build_quarantine')
  assert.equal(actionSteps.length, 1, 'image workflow must use build-push-action exactly once')
  assert.equal(quarantineSteps.length, 1, 'build_quarantine step ID must be unique')
  assert.equal(actionSteps[0].step, quarantineSteps[0].step)
  assert.equal(actionSteps[0].jobName, 'build-push')
  assert.match(
    actionSteps[0].step.uses,
    /^docker\/build-push-action@[0-9a-f]{40}$/u,
    'image build action must remain immutable'
  )
  assertRecord(actionSteps[0].step.with, 'build_quarantine inputs')
  assert.equal(actionSteps[0].step.with.context, '.')
  assert.equal(actionSteps[0].step.with.file, 'worker/Dockerfile.ingest')

  assert.equal(
    lstatSync(dockerfileSpecificIgnorePath, { throwIfNoEntry: false }),
    undefined,
    'Dockerfile-specific ignore would override the reviewed root .dockerignore'
  )
  assert.deepEqual(trackedEntries(['worker/Dockerfile.ingest.dockerignore']), [])
  assert.throws(
    () => parseStrictYaml('jobs:\n  build: {}\n  build: {}\n'),
    /valid YAML with unique mapping keys/u
  )
})

test('Git index reads cannot be redirected by caller repository or sparse-config state', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'arena-worker-context-git-canary-'))
  t.after(() => {
    rmSync(fixture, { force: true, recursive: true })
    assert.equal(lstatSync(fixture, { throwIfNoEntry: false }), undefined)
  })

  const externalGitDir = join(fixture, 'redirect.git')
  const externalWorkTree = join(fixture, 'redirect-worktree')
  const externalCommonDir = join(fixture, 'redirect-common')
  const externalObjects = join(fixture, 'redirect-objects')
  const alternateObjects = join(fixture, 'alternate-objects')
  const externalIndex = join(fixture, 'redirect.index')
  const globalConfig = join(fixture, 'global.gitconfig')
  const systemConfig = join(fixture, 'system.gitconfig')
  for (const directory of [
    externalGitDir,
    externalWorkTree,
    externalCommonDir,
    externalObjects,
    alternateObjects,
  ]) {
    mkdirSync(directory, { recursive: true })
  }
  writeFileSync(join(externalGitDir, 'HEAD'), 'ref: refs/heads/redirected\n')
  writeFileSync(join(externalObjects, 'sentinel'), 'external object directory\n')
  writeFileSync(join(alternateObjects, 'sentinel'), 'alternate object directory\n')
  writeFileSync(externalIndex, 'external index sentinel\n')
  const sparseConfig = [
    '[core]',
    '  sparseCheckout = true',
    `  worktree = ${externalWorkTree}`,
    '[index]',
    '  sparse = true',
    '',
  ].join('\n')
  writeFileSync(globalConfig, sparseConfig)
  writeFileSync(systemConfig, sparseConfig)

  const expectedTopLevel = readGit(['rev-parse', '--show-toplevel']).trim()
  const expectedHead = readGit(['rev-parse', '--verify', 'HEAD^{commit}']).trim()
  const expectedIndexPath = readGit(['rev-parse', '--git-path', 'index']).trim()
  const expectedEntries = trackedEntries(['.dockerignore', 'worker/Dockerfile.ingest'])
  const expectedConfig = readGit(['config', '--list', '--show-origin'])
  assert.equal(resolve(expectedTopLevel), root)
  assert.equal(readGit(['config', '--global', '--list']), '')

  const poisoned = {
    GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjects,
    GIT_COMMON_DIR: externalCommonDir,
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_KEY_0: 'core.sparseCheckout',
    GIT_CONFIG_KEY_1: 'index.sparse',
    GIT_CONFIG_KEY_2: 'core.worktree',
    GIT_CONFIG_PARAMETERS: "'core.sparseCheckout=true' 'index.sparse=true'",
    GIT_CONFIG_SYSTEM: systemConfig,
    GIT_CONFIG_VALUE_0: 'true',
    GIT_CONFIG_VALUE_1: 'true',
    GIT_CONFIG_VALUE_2: externalWorkTree,
    GIT_DIR: externalGitDir,
    GIT_INDEX_FILE: externalIndex,
    GIT_OBJECT_DIRECTORY: externalObjects,
    GIT_WORK_TREE: externalWorkTree,
  }
  const previous = new Map()
  const before = snapshotTree(fixture)

  try {
    for (const [name, value] of Object.entries(poisoned)) {
      previous.set(name, process.env[name])
      process.env[name] = value
    }

    assert.deepEqual(gitEnvironment, {
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
    })
    for (const name of Object.keys(poisoned)) {
      if (name !== 'GIT_CONFIG_GLOBAL') assert.equal(Object.hasOwn(gitEnvironment, name), false)
    }
    assert.equal(resolve(readGit(['rev-parse', '--show-toplevel']).trim()), root)
    assert.equal(readGit(['rev-parse', '--verify', 'HEAD^{commit}']).trim(), expectedHead)
    assert.equal(readGit(['rev-parse', '--git-path', 'index']).trim(), expectedIndexPath)
    assert.deepEqual(trackedEntries(['.dockerignore', 'worker/Dockerfile.ingest']), expectedEntries)
    assert.equal(readGit(['config', '--list', '--show-origin']), expectedConfig)
    assert.equal(readGit(['config', '--global', '--list']), '')
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }

  assert.deepEqual(snapshotTree(fixture), before, 'Git reads modified the external canary fixture')
})

test('context parser fails closed on unreviewed Docker input features', () => {
  assert.deepEqual(
    contextCopySources(
      [
        'FROM scratch AS deps',
        'FROM scratch AS runtime',
        'COPY --from=deps /app/node_modules ./node_modules',
        "RUN printf '%s' --mount=literal",
        'COPY lib ./lib',
      ].join('\n')
    ),
    ['lib']
  )

  for (const [source, expected] of [
    ['FROM scratch\nADD lib ./lib', /ADD.+bypasses/u],
    ['FROM scratch\nCOPY ["lib", "./lib"]', /JSON-form COPY/u],
    ['FROM scratch\nCOPY --chown=1000 lib ./lib', /context COPY flags/u],
    ['FROM scratch\nCOPY --from=external /lib ./lib', /unknown build stage/u],
    ['FROM scratch\nCOPY ../lib ./lib', /non-canonical COPY source/u],
    [
      'FROM scratch\nRUN --mount=type=bind,source=.,target=/source true',
      /RUN --mount.+default build context/u,
    ],
    [
      'FROM scratch\nRUN --network=none --mount=type=cache,target=/cache true',
      /RUN --mount.+default build context/u,
    ],
    ['FROM scratch\nONBUILD COPY lib ./lib', /ONBUILD.+context closure/u],
    [
      'FROM scratch\nONBUILD RUN --mount=type=bind,source=.,target=/source true',
      /ONBUILD.+context closure/u,
    ],
    ['# escape=`\nFROM scratch', /parser directives require explicit contract review/u],
    [
      '# syntax=docker/dockerfile:1\nFROM scratch',
      /parser directives require explicit contract review/u,
    ],
  ]) {
    assert.throws(() => contextCopySources(source), expected)
  }
})

test('dockerignore parser enforces canonical root matching and ordered negation', () => {
  const rootOnly = dockerignoreRules('node_modules\n*.md')
  assert.equal(ignored('node_modules/package.json', rootOnly), true)
  assert.equal(ignored('worker/node_modules/package.json', rootOnly), false)
  assert.equal(ignored('README.md', rootOnly), true)
  assert.equal(ignored('worker/README.md', rootOnly), false)
  assert.equal(ignored('worker/src/ingest-worker.ts', dockerignoreRules('worker')), true)

  assert.equal(
    ignored('scripts/README.md', dockerignoreRules('/scripts\n!scripts/README.md')),
    false
  )
  assert.equal(
    ignored('scripts/README.md', dockerignoreRules('!scripts/README.md\n/scripts')),
    true
  )
  assert.deepEqual(dockerignoreRules('# comment in column one\n'), [])

  for (const [source, expected] of [
    [' # indented comment', /comments must start in column 1/u],
    ['/scripts\n! scripts', /whitespace after negation/u],
    ['/scripts\n!\tscripts', /whitespace after negation/u],
    ['/scripts\n!scripts\t', /ambiguous whitespace/u],
    ['lib/../worker', /changed by filepath\.Clean/u],
    ['lib//worker', /changed by filepath\.Clean/u],
    ['./worker', /changed by filepath\.Clean/u],
    ['worker/', /changed by filepath\.Clean/u],
    ['.', /non-canonical path segment/u],
    ['lib/[ab]', /needs parser review/u],
  ]) {
    assert.throws(() => dockerignoreRules(source), expected)
  }
})

test('repository-only roots are excluded exactly without hiding Worker inputs', () => {
  const rules = dockerignoreRules(readFileSync(dockerignorePath, 'utf8'))

  for (const rootName of EXCLUDED_REPOSITORY_ROOTS) {
    const exact = rules.filter(
      (rule) => !rule.negated && normalizedDockerPattern(rule.pattern) === rootName
    )
    assert.equal(exact.length, 1, `${rootName} must have one exact root exclusion`)
    assert.equal(exact[0].pattern, `/${rootName}`, `${rootName} must use canonical root notation`)
    assert.equal(
      lstatSync(resolve(root, rootName)).isDirectory(),
      true,
      `${rootName} is not a directory`
    )
    const excludedPaths = trackedPaths(rootName)
    assert.notEqual(excludedPaths.length, 0, `${rootName} has no tracked inputs`)
    for (const path of excludedPaths) {
      assert.equal(ignored(path, rules), true, `${path} leaks into the Docker context`)
    }
    assert.equal(ignored(`${rootName}/context-probe`, rules), true, `${rootName} is not excluded`)
  }

  for (const ownerRoot of ['lib', 'worker']) {
    assert.equal(ignored(`${ownerRoot}/context-probe`, rules), false, `${ownerRoot}/ is excluded`)
  }
})

test('every tracked copied-tree input has an explicit ignore and Git-mode decision', () => {
  const rules = dockerignoreRules(readFileSync(dockerignorePath, 'utf8'))
  const treeSources = contextCopySources(readFileSync(dockerfilePath, 'utf8')).filter((path) =>
    ['lib', 'worker'].includes(path)
  )
  assert.deepEqual(treeSources, ['lib', 'worker'])

  const entries = trackedEntries(treeSources)
  assert.notEqual(entries.length, 0, 'copied trees must contain tracked inputs')
  const categoryCounts = new Map()
  let runtimeInputs = 0

  for (const entry of entries) {
    const category = ignoredInputCategory(entry)
    if (category !== undefined) {
      assert.equal(ignored(entry.path, rules), true, `${entry.path} must remain explicitly ignored`)
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1)
      if (category === 'foundry-gitlink') {
        assert.equal(entry.path, 'lib/forge-std')
        assert.equal(entry.mode, '160000', 'Foundry is an ignored gitlink, not a regular file')
      } else {
        assertRegularIndexEntry(entry)
      }
      continue
    }

    assert.equal(ignored(entry.path, rules), false, `${entry.path} is unexpectedly ignored`)
    assertRegularIndexEntry(entry)
    runtimeInputs += 1
  }

  assert.ok(runtimeInputs > 0, 'copied trees contain no runtime inputs')
  assert.deepEqual([...categoryCounts.keys()].sort(), [
    'foundry-gitlink',
    'test-directory',
    'test-file',
    'worker-environment-template',
  ])
  for (const count of categoryCounts.values()) {
    assert.ok(count > 0, 'every ignored-input category needs concrete tracked evidence')
  }
})
