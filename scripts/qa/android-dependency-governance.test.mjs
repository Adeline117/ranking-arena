import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { isAlias, isScalar, parseDocument, visit } from 'yaml'

const root = fileURLToPath(new URL('../..', import.meta.url))
const dependabotPath = join(root, '.github/dependabot.yml')
const packageManifestPath = join(root, 'package.json')

const inheritedGitEnvironmentKeys = [
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'ComSpec',
  'PATHEXT',
]

const forcedGitEnvironment = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: devNull,
  GIT_TERMINAL_PROMPT: '0',
}

const versionUpdateScopeNotice = `  # Version updates only. GitHub documents build.gradle and Gradle Wrapper
  # inputs as supported, but the applied variables.gradle file is outside its
  # documented dependency-file patterns and remains manually reviewed.
  # SemVer-major upgrades are an intentional human-reviewed migration boundary.
  # Gradle security coverage requires separately proven dependency submission;
  # this entry does not claim or configure that coverage.`

const expectedGradlePolicy = {
  'package-ecosystem': 'gradle',
  directory: '/android',
  schedule: {
    interval: 'weekly',
    day: 'monday',
  },
  'open-pull-requests-limit': 10,
  'commit-message': {
    prefix: 'deps',
  },
  labels: ['dependencies'],
  ignore: [
    {
      'dependency-name': '*',
      'update-types': ['version-update:semver-major'],
    },
  ],
}

const androidProjectReviewClosure = new Map([
  ['android/settings.gradle', '100644'],
  ['android/capacitor.settings.gradle', '100644'],
  ['android/build.gradle', '100644'],
  ['android/variables.gradle', '100644'],
  ['android/gradle.properties', '100644'],
  ['android/gradlew', '100755'],
  ['android/gradlew.bat', '100644'],
  ['android/gradle/wrapper/gradle-wrapper.jar', '100644'],
  ['android/gradle/wrapper/gradle-wrapper.properties', '100644'],
  ['android/app/build.gradle', '100644'],
  ['android/app/capacitor.build.gradle', '100644'],
  ['android/app/proguard-rules.pro', '100644'],
])

const canonicalGradleListItem = `  - package-ecosystem: gradle
    directory: /android
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 10
    commit-message:
      prefix: deps
    labels:
      - dependencies
    ignore:
      - dependency-name: '*'
        update-types:
          - version-update:semver-major
`

const canonicalGradleFixture = `version: 2
updates:
${canonicalGradleListItem}`

function isolatedGitEnvironment(sourceEnvironment = process.env) {
  const environment = {}
  for (const key of inheritedGitEnvironmentKeys) {
    if (sourceEnvironment[key] !== undefined) environment[key] = sourceEnvironment[key]
  }
  return { ...environment, ...forcedGitEnvironment }
}

function runGit(repositoryRoot, arguments_) {
  return execFileSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: isolatedGitEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function assertCanonicalYamlAst(document, label) {
  assert.equal(
    document.directives?.yaml?.version,
    '1.2',
    `${label} must use the canonical YAML 1.2 directive semantics`
  )
  assert.deepEqual(
    Object.entries(document.directives?.tags ?? {}),
    [['!!', 'tag:yaml.org,2002:']],
    `${label} must not declare custom tag directives`
  )

  visit(document, {
    Pair(_key, pair) {
      const keyValue = pair.key?.value
      const isMergeKey =
        keyValue === '<<' || (typeof keyValue === 'symbol' && keyValue.description === '<<')
      assert.equal(isMergeKey, false, `${label} must not contain YAML merge keys`)
      assert.ok(isScalar(pair.key), `${label} mapping keys must be scalar`)
      assert.equal(typeof keyValue, 'string', `${label} mapping keys must be strings`)
    },
    Node(_key, node) {
      assert.equal(isAlias(node), false, `${label} must not contain YAML aliases`)
      assert.equal(node.anchor, undefined, `${label} must not contain YAML anchors`)
      assert.equal(node.tag, undefined, `${label} must not contain explicit or custom YAML tags`)

      if (!isScalar(node)) return
      if (typeof node.value === 'number') {
        assert.ok(Number.isSafeInteger(node.value), `${label} numbers must be safe integers`)
        assert.equal(node.format, undefined, `${label} numbers must use canonical decimal form`)
        assert.equal(
          node.source,
          String(node.value),
          `${label} numbers must not use loose or ambiguous notation`
        )
      }
      if (typeof node.value === 'boolean') {
        assert.equal(
          node.source,
          String(node.value),
          `${label} booleans must use canonical lowercase notation`
        )
      }
    },
  })
}

function parseDependabot(source, label) {
  const document = parseDocument(source, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
    version: '1.2',
  })
  const diagnostics = [...document.errors, ...document.warnings]
  assert.equal(
    diagnostics.length,
    0,
    `${label} must be strict warning-free YAML:\n${diagnostics.map(String).join('\n')}`
  )
  assertCanonicalYamlAst(document, label)

  try {
    return document.toJS({ maxAliasCount: 0 })
  } catch (error) {
    assert.fail(`${label} could not be safely decoded: ${String(error)}`)
  }
}

function assertUniqueUpdateIdentities(updates, label) {
  assert.ok(Array.isArray(updates), `${label}.updates must be an array`)
  const identities = new Set()

  for (const [index, update] of updates.entries()) {
    assert.ok(
      update && typeof update === 'object' && !Array.isArray(update),
      `${label}.updates[${index}] must be a mapping`
    )
    const ecosystem = update['package-ecosystem']
    const directory = update.directory
    assert.equal(
      typeof ecosystem,
      'string',
      `${label}.updates[${index}].package-ecosystem must be a string`
    )
    assert.equal(
      typeof directory,
      'string',
      `${label}.updates[${index}].directory must be a string`
    )

    const identity = JSON.stringify([ecosystem, directory])
    assert.ok(
      !identities.has(identity),
      `${label} contains duplicate ${ecosystem} governance for ${directory}`
    )
    identities.add(identity)
  }
}

function validateDependabot(source, label) {
  const config = parseDependabot(source, label)
  assert.equal(config?.version, 2, `${label} must use Dependabot schema version 2`)
  assertUniqueUpdateIdentities(config.updates, label)

  const gradlePolicies = config.updates.filter((update) => update['package-ecosystem'] === 'gradle')
  assert.equal(
    gradlePolicies.length,
    1,
    `${label} must define exactly one Gradle version-update policy`
  )
  assert.deepEqual(
    gradlePolicies[0],
    expectedGradlePolicy,
    `${label} Gradle version-update policy drifted from the governed Android boundary`
  )
}

function assertQaScriptContract(manifest, label) {
  assert.ok(
    manifest && typeof manifest === 'object' && !Array.isArray(manifest),
    `${label} must be a JSON object`
  )
  assert.ok(
    manifest.scripts && typeof manifest.scripts === 'object' && !Array.isArray(manifest.scripts),
    `${label}.scripts must be a JSON object`
  )
  assert.equal(
    manifest.scripts['qa:android-dependencies'],
    'node --test scripts/qa/android-dependency-governance.test.mjs',
    `${label} must retain the exact Android dependency QA entrypoint`
  )
  assert.equal(
    manifest.scripts['qa:sweep-unit'],
    'node --test scripts/qa/*.test.mjs',
    `${label} must retain the sweep glob that discovers the Android dependency contract`
  )
}

function mutateOnce(source, expected, replacement) {
  const offset = source.indexOf(expected)
  assert.notEqual(offset, -1, `fixture mutation source is missing ${JSON.stringify(expected)}`)
  assert.equal(
    source.indexOf(expected, offset + expected.length),
    -1,
    `fixture mutation source repeats ${JSON.stringify(expected)}`
  )
  return `${source.slice(0, offset)}${replacement}${source.slice(offset + expected.length)}`
}

function assertSafeRepositoryPath(repositoryRoot, repositoryPath) {
  assert.equal(typeof repositoryPath, 'string')
  assert.ok(repositoryPath.length > 0, 'repository path must not be empty')
  assert.equal(repositoryPath.includes('\\'), false, `${repositoryPath} must use POSIX separators`)
  assert.equal(
    repositoryPath.startsWith('/'),
    false,
    `${repositoryPath} must be repository-relative`
  )
  assert.ok(
    repositoryPath.split('/').every((segment) => segment && segment !== '.' && segment !== '..'),
    `${repositoryPath} must be a normalized repository path`
  )

  const absolutePath = resolve(repositoryRoot, repositoryPath)
  const pathFromRoot = relative(repositoryRoot, absolutePath)
  assert.ok(
    pathFromRoot.length > 0 && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`),
    `${repositoryPath} must resolve inside the repository`
  )
  return absolutePath
}

function assertTrackedRegularFile(repositoryRoot, repositoryPath, expectedMode) {
  const absolutePath = assertSafeRepositoryPath(repositoryRoot, repositoryPath)
  const segments = repositoryPath.split('/')
  let currentPath = repositoryRoot

  for (const segment of segments.slice(0, -1)) {
    currentPath = join(currentPath, segment)
    const stat = lstatSync(currentPath)
    assert.equal(stat.isSymbolicLink(), false, `${repositoryPath} has a symlink ancestor`)
    assert.ok(stat.isDirectory(), `${repositoryPath} has a non-directory ancestor`)
  }

  const stat = lstatSync(absolutePath)
  assert.equal(stat.isSymbolicLink(), false, `${repositoryPath} must not be a symlink`)
  assert.ok(stat.isFile(), `${repositoryPath} must be a regular file`)
  assert.ok(stat.size > 0, `${repositoryPath} must not be empty`)

  const indexOutput = runGit(repositoryRoot, [
    'ls-files',
    '--stage',
    '--error-unmatch',
    '--',
    repositoryPath,
  ]).trimEnd()
  const indexLines = indexOutput.split('\n')
  assert.equal(indexLines.length, 1, `${repositoryPath} must have exactly one index entry`)
  const match = indexLines[0].match(/^(100644|100755) [0-9a-f]{40,64} 0\t(.+)$/)
  assert.ok(match, `${repositoryPath} must be a stage-zero tracked regular file`)
  assert.equal(match[1], expectedMode, `${repositoryPath} has an unexpected executable mode`)
  assert.equal(match[2], repositoryPath, `${repositoryPath} index path drifted`)
}

function quoteShellWord(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

function quoteGitConfigValue(value) {
  assert.equal(value.includes('\n'), false, 'Git config fixture values must be one line')
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function overrideProcessEnvironment(overrides) {
  const previousValues = new Map()
  for (const [key, value] of Object.entries(overrides)) {
    previousValues.set(key, process.env[key])
    process.env[key] = value
  }
  return () => {
    for (const [key, value] of previousValues) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('Android Gradle version-update policy is unique, exact, and scope-honest', () => {
  assertTrackedRegularFile(root, '.github/dependabot.yml', '100644')
  assertTrackedRegularFile(root, 'package.json', '100644')
  const source = readFileSync(dependabotPath, 'utf8')
  assert.ok(
    source.includes(versionUpdateScopeNotice),
    'Gradle policy must retain its version/security/manual-file coverage limits'
  )
  validateDependabot(source, 'Dependabot')

  const manifest = JSON.parse(readFileSync(packageManifestPath, 'utf8'))
  assertQaScriptContract(manifest, 'package.json')
  assert.throws(
    () =>
      assertQaScriptContract(
        {
          ...manifest,
          scripts: {
            ...manifest.scripts,
            'qa:android-dependencies': 'node scripts/qa/android-dependency-governance.test.mjs',
          },
        },
        'script-drift fixture'
      ),
    /exact Android dependency QA entrypoint/
  )
})

test('full YAML mutations fail closed without loose scalar or composition semantics', () => {
  assert.doesNotThrow(() => validateDependabot(canonicalGradleFixture, 'canonical fixture'))

  const anchorFixture = mutateOnce(
    canonicalGradleFixture,
    '  - package-ecosystem: gradle',
    '  - &android-policy\n    package-ecosystem: gradle'
  )
  const aliasFixture = mutateOnce(anchorFixture, 'updates:\n', 'updates:\n  - *android-policy\n')
  const mergeFixture = mutateOnce(
    canonicalGradleFixture,
    '  - package-ecosystem: gradle',
    '  - <<: {}\n    package-ecosystem: gradle'
  )
  const yaml11MergeFixture = `%YAML 1.1
---
${anchorFixture.replace('updates:\n', 'updates:\n  - <<: *android-policy\n')}`
  const customTagFixture = mutateOnce(
    canonicalGradleFixture,
    'package-ecosystem: gradle',
    'package-ecosystem: !reviewed gradle'
  )
  const explicitTagFixture = mutateOnce(
    canonicalGradleFixture,
    'package-ecosystem: gradle',
    'package-ecosystem: !!str gradle'
  )
  const customDirectiveFixture = `%TAG !arena! tag:arena.example,2026:
---
${mutateOnce(
  canonicalGradleFixture,
  'package-ecosystem: gradle',
  'package-ecosystem: !arena!ecosystem gradle'
)}`
  const duplicateKeyFixture = mutateOnce(
    canonicalGradleFixture,
    '    directory: /android\n',
    '    directory: /android\n    directory: /android\n'
  )
  const duplicateIdentityFixture = `${canonicalGradleFixture}${canonicalGradleListItem}`
  const looseBooleanFixture = mutateOnce(
    canonicalGradleFixture,
    '      day: monday',
    '      day: true'
  )
  const looseNumberFixture = mutateOnce(
    canonicalGradleFixture,
    '      prefix: deps',
    '      prefix: 123'
  )
  const ambiguousNumberFixture = mutateOnce(
    canonicalGradleFixture,
    '    open-pull-requests-limit: 10',
    '    open-pull-requests-limit: 1e1'
  )
  const securityGroupFixture = `${canonicalGradleFixture}    groups:
      security-updates:
        applies-to: security-updates
        patterns: ['*']
`

  for (const [label, source, message] of [
    ['anchor fixture', anchorFixture, /YAML anchors/],
    ['alias fixture', aliasFixture, /YAML aliases/],
    ['merge fixture', mergeFixture, /YAML merge keys/],
    ['YAML 1.1 merge fixture', yaml11MergeFixture, /YAML 1.2 directive semantics/],
    ['custom tag fixture', customTagFixture, /warning-free YAML/],
    ['explicit tag fixture', explicitTagFixture, /explicit or custom YAML tags/],
    ['custom directive fixture', customDirectiveFixture, /warning-free YAML/],
    ['duplicate key fixture', duplicateKeyFixture, /warning-free YAML/],
    ['duplicate identity fixture', duplicateIdentityFixture, /duplicate gradle governance/],
    ['loose boolean fixture', looseBooleanFixture, /version-update policy drifted/],
    ['loose number fixture', looseNumberFixture, /version-update policy drifted/],
    ['ambiguous number fixture', ambiguousNumberFixture, /canonical decimal form/],
    ['security group fixture', securityGroupFixture, /version-update policy drifted/],
  ]) {
    assert.throws(() => validateDependabot(source, label), message)
  }
})

test('checked-in Android Gradle project review closure is tracked and regular', () => {
  for (const [repositoryPath, expectedMode] of androidProjectReviewClosure) {
    assertTrackedRegularFile(root, repositoryPath, expectedMode)
  }
})

test('Git-backed closure checks isolate caller state and clean every canary', (context) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'arena-android-deps-fixture-'))
  const externalRoot = mkdtempSync(join(tmpdir(), 'arena-android-deps-external-'))
  let restoreEnvironment = () => {}
  context.after(() => {
    restoreEnvironment()
    rmSync(fixtureRoot, { recursive: true, force: true })
    rmSync(externalRoot, { recursive: true, force: true })
  })

  const outsideRepository = join(externalRoot, 'outside-repository')
  const outsideAndroid = join(outsideRepository, 'android')
  mkdirSync(outsideAndroid, { recursive: true })
  runGit(outsideRepository, ['init', '--quiet'])
  const outsideBuildFile = join(outsideAndroid, 'build.gradle')
  writeFileSync(outsideBuildFile, '// initially staged outside file\n')
  runGit(outsideRepository, ['add', '--', 'android/build.gradle'])
  const outsideIndexPath = join(outsideRepository, '.git/index')
  const outsideIndexBefore = readFileSync(outsideIndexPath)
  writeFileSync(outsideBuildFile, '// changed but intentionally unstaged outside file\n')
  const outsideBuildBefore = readFileSync(outsideBuildFile)

  const canaryPath = join(externalRoot, 'outside-canary.txt')
  const canaryBefore = 'outside state must remain untouched\n'
  writeFileSync(canaryPath, canaryBefore)
  const filterProgram = join(externalRoot, 'malicious-clean-filter.mjs')
  writeFileSync(
    filterProgram,
    `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(
      canaryPath
    )}, 'filter executed\\n')\nprocess.stdin.pipe(process.stdout)\n`
  )
  const filterCommand = `${quoteShellWord(process.execPath)} ${quoteShellWord(filterProgram)}`
  const attributesPath = join(externalRoot, 'malicious.attributes')
  writeFileSync(attributesPath, '*.gradle filter=outside-canary\n')

  const externalHome = join(externalRoot, 'home')
  const xdgConfig = join(externalRoot, 'xdg')
  mkdirSync(join(xdgConfig, 'git'), { recursive: true })
  mkdirSync(externalHome)
  const maliciousGlobalConfig = `[core]
  attributesFile = ${quoteGitConfigValue(attributesPath)}
[filter "outside-canary"]
  clean = ${quoteGitConfigValue(filterCommand)}
  required = true
`
  const globalConfigPath = join(externalHome, '.gitconfig')
  writeFileSync(globalConfigPath, maliciousGlobalConfig)
  writeFileSync(join(xdgConfig, 'git/config'), maliciousGlobalConfig)
  assert.equal(
    runGit(externalRoot, [
      'config',
      '--file',
      globalConfigPath,
      '--get',
      'core.attributesFile',
    ]).trim(),
    attributesPath
  )
  assert.equal(
    runGit(externalRoot, [
      'config',
      '--file',
      globalConfigPath,
      '--get',
      'filter.outside-canary.clean',
    ]).trim(),
    filterCommand
  )
  assert.equal(
    runGit(externalRoot, [
      'config',
      '--file',
      globalConfigPath,
      '--get',
      'filter.outside-canary.required',
    ]).trim(),
    'true'
  )

  restoreEnvironment = overrideProcessEnvironment({
    HOME: externalHome,
    XDG_CONFIG_HOME: xdgConfig,
    GIT_CONFIG_GLOBAL: globalConfigPath,
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'core.attributesFile',
    GIT_CONFIG_VALUE_0: attributesPath,
    GIT_CONFIG_KEY_1: 'filter.outside-canary.clean',
    GIT_CONFIG_VALUE_1: filterCommand,
    GIT_CONFIG_KEY_2: 'filter.outside-canary.required',
    GIT_CONFIG_VALUE_2: 'true',
    GIT_CONFIG_KEY_7: 'core.hooksPath',
    GIT_CONFIG_VALUE_11: join(externalRoot, 'outside-hooks'),
    GIT_DIR: join(outsideRepository, '.git'),
    GIT_COMMON_DIR: join(outsideRepository, '.git'),
    GIT_WORK_TREE: outsideRepository,
    GIT_INDEX_FILE: outsideIndexPath,
    GIT_OBJECT_DIRECTORY: join(outsideRepository, '.git/objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(externalRoot, 'alternate-objects'),
  })

  const childEnvironment = isolatedGitEnvironment()
  assert.deepEqual(
    Object.keys(childEnvironment)
      .filter((key) => key.startsWith('GIT_'))
      .sort(),
    Object.keys(forcedGitEnvironment).sort()
  )
  const permittedEnvironmentKeys = new Set([
    ...inheritedGitEnvironmentKeys,
    ...Object.keys(forcedGitEnvironment),
  ])
  assert.ok(
    Object.keys(childEnvironment).every((key) => permittedEnvironmentKeys.has(key)),
    'Git subprocesses must inherit only the explicit PATH, temp, and platform allowlist'
  )
  assert.equal(childEnvironment.HOME, undefined)
  assert.equal(childEnvironment.XDG_CONFIG_HOME, undefined)

  assertTrackedRegularFile(root, '.github/dependabot.yml', '100644')
  runGit(fixtureRoot, ['init', '--quiet'])
  assert.ok(lstatSync(join(fixtureRoot, '.git')).isDirectory())

  const gradleDirectory = join(fixtureRoot, 'android')
  mkdirSync(gradleDirectory)
  const buildFile = join(gradleDirectory, 'build.gradle')
  writeFileSync(buildFile, '// isolated fixture\n')
  assert.throws(
    () => assertTrackedRegularFile(fixtureRoot, 'android/build.gradle', '100644'),
    /Command failed/
  )
  runGit(fixtureRoot, ['add', '--', 'android/build.gradle'])
  assert.doesNotThrow(() => assertTrackedRegularFile(fixtureRoot, 'android/build.gradle', '100644'))

  symlinkSync(externalRoot, join(fixtureRoot, 'linked-android'))
  assert.throws(
    () => assertTrackedRegularFile(fixtureRoot, 'linked-android/outside-canary.txt', '100644'),
    /symlink ancestor/
  )

  assert.equal(readFileSync(canaryPath, 'utf8'), canaryBefore)
  assert.deepEqual(readFileSync(outsideIndexPath), outsideIndexBefore)
  assert.deepEqual(readFileSync(outsideBuildFile), outsideBuildBefore)
  assert.equal(existsSync(join(fixtureRoot, '.git/index')), true)

  process.env.GIT_CONFIG_COUNT = '12'
  assert.equal(
    runGit(fixtureRoot, ['ls-files', '--error-unmatch', '--', 'android/build.gradle']).trim(),
    'android/build.gradle'
  )
  assert.equal(readFileSync(canaryPath, 'utf8'), canaryBefore)
  assert.deepEqual(readFileSync(outsideIndexPath), outsideIndexBefore)
})
