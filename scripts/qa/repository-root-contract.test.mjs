import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'
import test from 'node:test'
import { TextDecoder } from 'node:util'

const root = resolve(import.meta.dirname, '../..')
const allowlistPath = join(import.meta.dirname, 'repository-root-allowlist.json')
const regularRootModes = new Set(['100644', '100755'])
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

function compareCodeUnits(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function isolatedGitEnvironment(inheritedEnvironment = process.env) {
  const environment = {}
  for (const [key, value] of Object.entries(inheritedEnvironment)) {
    if (!key.startsWith('GIT_') && value !== undefined) environment[key] = value
  }
  return {
    ...environment,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: devNull,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  }
}

function runGit(repositoryRoot, arguments_, options = {}) {
  return execFileSync('git', arguments_, {
    cwd: repositoryRoot,
    encoding: Object.hasOwn(options, 'encoding') ? options.encoding : 'utf8',
    env: isolatedGitEnvironment(options.inheritedEnvironment),
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.stdio,
  })
}

function assertSafeRepositoryPath(repositoryRoot, repositoryPath) {
  assert.ok(repositoryPath.length > 0, 'Git returned an empty repository path')
  assert.equal(repositoryPath.includes('\\'), false, `Git path is not portable: ${repositoryPath}`)
  assert.equal(
    isAbsolute(repositoryPath),
    false,
    `Git returned an absolute path: ${repositoryPath}`
  )
  assert.equal(
    win32.isAbsolute(repositoryPath),
    false,
    `Git returned a Windows absolute path: ${repositoryPath}`
  )
  assert.equal(
    posix.normalize(repositoryPath),
    repositoryPath,
    `Git returned a non-canonical path: ${repositoryPath}`
  )

  const resolvedRoot = resolve(repositoryRoot)
  const resolvedPath = resolve(resolvedRoot, repositoryPath)
  const pathFromRoot = relative(resolvedRoot, resolvedPath)
  assert.ok(
    pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`),
    `Git returned a path outside the repository: ${repositoryPath}`
  )
}

function parseGitStageOutput(repositoryRoot, output) {
  assert.ok(Buffer.isBuffer(output), 'Git index output must remain binary')
  if (output.length === 0) return []
  assert.equal(output.at(-1), 0, 'Git index output must end with a NUL delimiter')

  const records = []
  let offset = 0
  while (offset < output.length) {
    const delimiter = output.indexOf(0, offset)
    assert.notEqual(delimiter, -1, 'Git index output is missing a NUL delimiter')
    if (delimiter === offset) {
      assert.equal(delimiter, output.length - 1, 'Git index output contains an empty record')
      break
    }

    let record
    try {
      record = utf8Decoder.decode(output.subarray(offset, delimiter))
    } catch (error) {
      throw new Error('Git index path metadata is not valid UTF-8', { cause: error })
    }
    const match = /^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])\t([\s\S]+)$/u.exec(record)
    assert.ok(match, `unexpected git ls-files --stage record: ${record}`)
    assertSafeRepositoryPath(repositoryRoot, match[4])
    records.push({
      mode: match[1],
      objectId: match[2],
      path: match[4],
      stage: Number(match[3]),
    })
    offset = delimiter + 1
  }
  return records
}

function gitIndexStageRecords(repositoryRoot, inheritedEnvironment = process.env) {
  const output = runGit(repositoryRoot, ['ls-files', '--cached', '--stage', '-z', '--'], {
    encoding: null,
    inheritedEnvironment,
  })
  return parseGitStageOutput(repositoryRoot, output)
}

function portableKey(value) {
  // JavaScript has no native Unicode case-fold operation. The lower/upper/lower
  // closure is deliberately more conservative than a single lowercase pass:
  // it catches multi-code-point folds (for example sharp S -> "ss") as well as
  // final sigma and long S before comparing paths on case-insensitive filesystems.
  return value.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC')
}

function assertPortableUnique(values, label) {
  const seen = new Map()
  for (const value of values) {
    assert.equal(value.normalize('NFC'), value, `${label} must use NFC: ${value}`)
    const key = portableKey(value)
    const previous = seen.get(key)
    assert.equal(
      previous,
      undefined,
      `${label} collide after NFC/casefold: ${previous} <> ${value}`
    )
    seen.set(key, value)
  }

  for (const [key, value] of seen) {
    let slash = key.indexOf('/')
    while (slash !== -1) {
      const parentKey = key.slice(0, slash)
      const parentValue = seen.get(parentKey)
      assert.equal(
        parentValue,
        undefined,
        `${label} collide as a portable file/directory prefix: ${parentValue} <> ${value}`
      )
      slash = key.indexOf('/', slash + 1)
    }
  }
}

function assertManifestName(name, label) {
  assert.equal(typeof name, 'string', `${label} entries must be strings`)
  assert.ok(name.length > 0, `${label} entries must not be empty`)
  assert.equal(name.includes('/'), false, `${label} entries must be top-level names: ${name}`)
  assert.equal(name.includes('\\'), false, `${label} entries must be portable: ${name}`)
  assert.equal(name.normalize('NFC'), name, `${label} entries must use NFC: ${name}`)
  assert.notEqual(name, '.', `${label} must not contain dot`)
  assert.notEqual(name, '..', `${label} must not contain dot-dot`)
}

function normalizeAllowlist(body, label = 'repository root allowlist') {
  assert.ok(body && typeof body === 'object' && !Array.isArray(body), `${label} must be an object`)
  assert.deepEqual(
    Object.keys(body).sort(compareCodeUnits),
    ['rootFiles', 'topLevelDirectories', 'version'],
    `${label} must contain only version, topLevelDirectories, and rootFiles`
  )
  assert.equal(body.version, 1, `${label} version must be 1`)
  assert.ok(Array.isArray(body.topLevelDirectories), `${label} directories must be an array`)
  assert.ok(Array.isArray(body.rootFiles), `${label} root files must be an array`)

  const topLevelDirectories = [...body.topLevelDirectories]
  const rootFiles = [...body.rootFiles]
  for (const name of topLevelDirectories) assertManifestName(name, `${label} directories`)
  for (const name of rootFiles) assertManifestName(name, `${label} root files`)
  assert.deepEqual(
    topLevelDirectories,
    [...topLevelDirectories].sort(compareCodeUnits),
    `${label} directories must be sorted`
  )
  assert.deepEqual(
    rootFiles,
    [...rootFiles].sort(compareCodeUnits),
    `${label} files must be sorted`
  )
  assertPortableUnique(topLevelDirectories, `${label} directories`)
  assertPortableUnique(rootFiles, `${label} root files`)
  assertPortableUnique(
    [...topLevelDirectories, ...rootFiles],
    `${label} directory and root-file names`
  )
  return { rootFiles, topLevelDirectories }
}

function repositoryRootInventory(repositoryRoot, records) {
  for (const record of records) {
    assert.equal(record.stage, 0, `${record.path} must remain at Git index stage zero`)
  }
  assertPortableUnique(
    records.map(({ path }) => path),
    'tracked repository paths'
  )

  const topLevelDirectories = new Set()
  const rootFiles = new Set()
  for (const record of records) {
    assertSafeRepositoryPath(repositoryRoot, record.path)
    const slash = record.path.indexOf('/')
    if (slash !== -1) {
      topLevelDirectories.add(record.path.slice(0, slash))
      continue
    }
    assert.ok(
      regularRootModes.has(record.mode),
      `${record.path} root entry must be a tracked regular file, not mode ${record.mode}`
    )
    rootFiles.add(record.path)
  }

  const directories = [...topLevelDirectories].sort(compareCodeUnits)
  const files = [...rootFiles].sort(compareCodeUnits)
  assertPortableUnique(directories, 'tracked top-level directories')
  assertPortableUnique(files, 'tracked root files')
  assertPortableUnique([...directories, ...files], 'tracked top-level names')
  return { rootFiles: files, topLevelDirectories: directories }
}

function assertRepositoryRootContract(
  repositoryRoot,
  allowlist,
  inheritedEnvironment = process.env
) {
  const expected = normalizeAllowlist(allowlist)
  const records = gitIndexStageRecords(repositoryRoot, inheritedEnvironment)
  const actual = repositoryRootInventory(repositoryRoot, records)
  assert.deepEqual(
    actual.topLevelDirectories,
    expected.topLevelDirectories,
    'top-level directory drift'
  )
  assert.deepEqual(actual.rootFiles, expected.rootFiles, 'root file drift')
  return actual
}

function fixtureRecord(path, options = {}) {
  return {
    mode: options.mode ?? '100644',
    objectId: options.objectId ?? 'a'.repeat(40),
    path,
    stage: options.stage ?? 0,
  }
}

const fixtureAllowlist = {
  version: 1,
  topLevelDirectories: ['app', 'vendor'],
  rootFiles: ['README.md'],
}
const fixtureRecords = [
  fixtureRecord('README.md'),
  fixtureRecord('app/page.tsx'),
  fixtureRecord('vendor/foundry', { mode: '160000' }),
]

test('tracked repository root exactly matches the canonical allowlist', () => {
  const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'))
  assertRepositoryRootContract(root, allowlist)
  assert.throws(
    () =>
      assertRepositoryRootContract(root, {
        ...allowlist,
        topLevelDirectories: [...allowlist.topLevelDirectories, 'zzz-stale-root'],
      }),
    /top-level directory drift/,
    'stale directory allowlist entries must fail'
  )
  assert.throws(
    () =>
      assertRepositoryRootContract(root, {
        ...allowlist,
        rootFiles: allowlist.rootFiles.filter((path) => path !== 'README.md'),
      }),
    /root file drift/,
    'missing root file allowlist entries must fail'
  )
})

test('root inventory fails closed on structural and portability drift', () => {
  assert.deepEqual(repositoryRootInventory(root, fixtureRecords), {
    rootFiles: ['README.md'],
    topLevelDirectories: ['app', 'vendor'],
  })

  for (const [name, records, pattern] of [
    ['unknown directory', [...fixtureRecords, fixtureRecord('misc/file.txt')], /directory drift/],
    [
      'unknown tools root',
      [...fixtureRecords, fixtureRecord('tools2/task.mjs')],
      /directory drift/,
    ],
    [
      'root symlink',
      fixtureRecords.map((record) =>
        record.path === 'README.md' ? { ...record, mode: '120000' } : record
      ),
      /tracked regular file/,
    ],
    [
      'root gitlink',
      [
        ...fixtureRecords.filter(({ path }) => !path.startsWith('vendor/')),
        fixtureRecord('vendor', { mode: '160000' }),
      ],
      /tracked regular file/,
    ],
    [
      'conflict stage',
      [...fixtureRecords, fixtureRecord('app/conflict.ts', { stage: 2 })],
      /stage zero/,
    ],
    [
      'casefold path collision',
      [...fixtureRecords, fixtureRecord('app/Card.tsx'), fixtureRecord('app/card.tsx')],
      /tracked repository paths collide/,
    ],
    [
      'casefold root collision',
      [...fixtureRecords, fixtureRecord('App/other.tsx')],
      /tracked top-level directories collide/,
    ],
    [
      'casefold file/directory prefix collision',
      [
        ...fixtureRecords,
        fixtureRecord('app/Foo'),
        fixtureRecord('app/foo-bar.ts'),
        fixtureRecord('app/foo/bar.ts'),
      ],
      /portable file\/directory prefix/,
    ],
    [
      'Unicode file/directory prefix collision',
      [...fixtureRecords, fixtureRecord('app/Σ'), fixtureRecord('app/ς/bar.ts')],
      /portable file\/directory prefix/,
    ],
    [
      'Unicode sigma path collision',
      [...fixtureRecords, fixtureRecord('app/Σ.ts'), fixtureRecord('app/ς.ts')],
      /tracked repository paths collide/,
    ],
    [
      'Unicode long-s path collision',
      [...fixtureRecords, fixtureRecord('app/ſ.ts'), fixtureRecord('app/s.ts')],
      /tracked repository paths collide/,
    ],
    [
      'Unicode sharp-s path collision',
      [...fixtureRecords, fixtureRecord('app/STRAẞE.ts'), fixtureRecord('app/strasse.ts')],
      /tracked repository paths collide/,
    ],
    [
      'Unicode sigma root collision',
      [...fixtureRecords, fixtureRecord('Σ/one.ts'), fixtureRecord('ς/two.ts')],
      /tracked top-level directories collide/,
    ],
    [
      'Unicode long-s root collision',
      [...fixtureRecords, fixtureRecord('ſ/one.ts'), fixtureRecord('s/two.ts')],
      /tracked top-level directories collide/,
    ],
    [
      'Unicode sharp-s root collision',
      [...fixtureRecords, fixtureRecord('ẞ/one.ts'), fixtureRecord('ss/two.ts')],
      /tracked top-level directories collide/,
    ],
    [
      'Unicode root collision',
      [...fixtureRecords, fixtureRecord('caf\u00e9/one.ts'), fixtureRecord('cafe\u0301/two.ts')],
      /must use NFC|tracked top-level directories collide/,
    ],
  ]) {
    assert.throws(
      () => {
        const inventory = repositoryRootInventory(root, records)
        assert.deepEqual(
          inventory.topLevelDirectories,
          fixtureAllowlist.topLevelDirectories,
          'top-level directory drift'
        )
        assert.deepEqual(inventory.rootFiles, fixtureAllowlist.rootFiles, 'root file drift')
      },
      pattern,
      name
    )
  }

  assert.throws(
    () => normalizeAllowlist({ ...fixtureAllowlist, topLevelDirectories: ['vendor', 'app'] }),
    /directories must be sorted/
  )
  assert.throws(
    () => normalizeAllowlist({ ...fixtureAllowlist, rootFiles: ['README.md', 'readme.md'] }),
    /root files collide/
  )
  assert.throws(
    () =>
      normalizeAllowlist({
        ...fixtureAllowlist,
        rootFiles: ['README.md', 'app'],
      }),
    /directory and root-file names collide/
  )
})

test('Git inventory ignores untracked files and hostile inherited selectors', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'arena-root-contract-'))
  t.after(() => rmSync(fixture, { force: true, recursive: true }))
  runGit(fixture, ['init', '--quiet'])
  mkdirSync(join(fixture, 'app'), { recursive: true })
  mkdirSync(join(fixture, 'misc'), { recursive: true })
  mkdirSync(join(fixture, 'cache'), { recursive: true })
  writeFileSync(join(fixture, '.gitignore'), 'cache/\n')
  writeFileSync(join(fixture, 'README.md'), 'fixture\n')
  writeFileSync(join(fixture, 'app/page.tsx'), 'export default function Page() { return null }\n')
  writeFileSync(join(fixture, 'misc/untracked.txt'), 'not indexed\n')
  writeFileSync(join(fixture, 'cache/ignored.txt'), 'ignored\n')
  runGit(fixture, ['add', '--', '.gitignore', 'README.md', 'app/page.tsx'])

  const external = mkdtempSync(join(tmpdir(), 'arena-root-contract-external-'))
  t.after(() => rmSync(external, { force: true, recursive: true }))
  runGit(external, ['init', '--quiet'])
  writeFileSync(join(external, 'external.txt'), 'external\n')
  runGit(external, ['add', '--', 'external.txt'])
  const hostileConfig = join(fixture, 'hostile.gitconfig')
  writeFileSync(hostileConfig, `[core]\n\tworktree = ${external}\n`)
  const hostileEnvironment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: hostileConfig,
    GIT_DIR: join(external, '.git'),
    GIT_INDEX_FILE: join(external, '.git', 'index'),
    GIT_WORK_TREE: external,
  }

  assert.deepEqual(
    assertRepositoryRootContract(
      fixture,
      {
        version: 1,
        topLevelDirectories: ['app'],
        rootFiles: ['.gitignore', 'README.md'],
      },
      hostileEnvironment
    ),
    {
      rootFiles: ['.gitignore', 'README.md'],
      topLevelDirectories: ['app'],
    }
  )

  runGit(fixture, ['add', '--', 'misc/untracked.txt'])
  assert.throws(
    () =>
      assertRepositoryRootContract(fixture, {
        version: 1,
        topLevelDirectories: ['app'],
        rootFiles: ['.gitignore', 'README.md'],
      }),
    /top-level directory drift/
  )
})

test('binary Git stage parser rejects malformed, unterminated, and non-UTF-8 records', () => {
  assert.throws(
    () => parseGitStageOutput(root, Buffer.from('100644 bad 0\tREADME.md\0')),
    /unexpected git ls-files/
  )
  assert.throws(
    () => parseGitStageOutput(root, Buffer.from(`100644 ${'a'.repeat(40)} 0\tREADME.md`)),
    /must end with a NUL/
  )
  assert.throws(() => parseGitStageOutput(root, Buffer.from([0xff, 0x00])), /not valid UTF-8/)
})
