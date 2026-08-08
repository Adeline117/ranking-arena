import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import test from 'node:test'
import { TextDecoder } from 'node:util'

const root = resolve(import.meta.dirname, '../..')
const attributeNames = [
  'binary',
  'text',
  'eol',
  'diff',
  'merge',
  'filter',
  'working-tree-encoding',
  'ident',
]
const expectedAttributeDirectives = [
  '* text=auto eol=lf',
  '*.bat text eol=crlf',
  '*.cmd text eol=crlf',
  '*.ico binary',
  '*.jar binary',
  '*.jpeg binary',
  '*.jpg binary',
  '*.png binary',
  '*.webp binary',
]
const binaryExtensions = new Set(['.ico', '.jar', '.jpeg', '.jpg', '.png', '.webp'])
const regularModes = new Set(['100644', '100755'])
const allowedGitlinks = new Set(['lib/forge-std'])
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

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
    GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  }
}

function runGit(repositoryRoot, arguments_, options = {}) {
  return execFileSync('git', ['-c', `core.attributesFile=${devNull}`, ...arguments_], {
    cwd: repositoryRoot,
    encoding: Object.hasOwn(options, 'encoding') ? options.encoding : 'utf8',
    env: isolatedGitEnvironment(options.inheritedEnvironment),
    input: options.input,
    maxBuffer: 128 * 1024 * 1024,
    stdio: options.stdio,
  })
}

function decodeUtf8(value, label) {
  try {
    return utf8Decoder.decode(value)
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error })
  }
}

function parseIndexRecords(output) {
  assert.ok(Buffer.isBuffer(output), 'Git index output must remain binary')
  if (output.length === 0) return []
  assert.equal(output.at(-1), 0, 'Git index output must end with NUL')

  const records = []
  for (const rawRecord of output.subarray(0, -1).toString('binary').split('\0')) {
    const record = Buffer.from(rawRecord, 'binary')
    const tab = record.indexOf(9)
    assert.notEqual(tab, -1, 'Git index record must contain a tab separator')
    const metadata = record.subarray(0, tab).toString('ascii')
    const match = /^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])$/u.exec(metadata)
    assert.ok(match, `unexpected Git index metadata: ${metadata}`)
    assert.equal(match[3], '0', 'Git attributes require a conflict-free index')
    records.push({
      mode: match[1],
      objectId: match[2],
      path: decodeUtf8(record.subarray(tab + 1), 'Git index path'),
    })
  }
  return records
}

function indexRecords(repositoryRoot) {
  return parseIndexRecords(
    runGit(repositoryRoot, ['ls-files', '--cached', '--stage', '-z', '--'], {
      encoding: null,
    })
  )
}

function activePolicyLines(contents) {
  return contents.split('\n').filter((line) => line.length > 0 && !line.startsWith('#'))
}

function stagedText(repositoryRoot, path) {
  return runGit(repositoryRoot, ['show', `:${path}`])
}

function assertNoLocalAttributeOverride(repositoryRoot) {
  const rawPath = runGit(repositoryRoot, ['rev-parse', '--git-path', 'info/attributes']).trim()
  const infoAttributesPath = resolve(repositoryRoot, rawPath)
  if (!existsSync(infoAttributesPath)) return
  assert.deepEqual(
    activePolicyLines(readFileSync(infoAttributesPath, 'utf8')),
    [],
    `${infoAttributesPath} must not override the committed attribute policy`
  )
}

function governedBlobRecords(repositoryRoot, expectedGitlinks = allowedGitlinks) {
  assertNoLocalAttributeOverride(repositoryRoot)
  const records = indexRecords(repositoryRoot)
  const attributeFiles = records
    .map(({ path }) => path)
    .filter((path) => {
      const portablePath = path.toLowerCase()
      return portablePath === '.gitattributes' || portablePath.endsWith('/.gitattributes')
    })
    .sort()
  assert.deepEqual(
    attributeFiles,
    ['.gitattributes'],
    'only the canonical root .gitattributes file may be tracked'
  )
  assert.deepEqual(
    activePolicyLines(stagedText(repositoryRoot, '.gitattributes')),
    expectedAttributeDirectives,
    'staged .gitattributes directives must match the reviewed policy'
  )

  const blobs = []
  const gitlinks = []
  for (const record of records) {
    if (regularModes.has(record.mode)) {
      blobs.push(record)
      continue
    }
    if (record.mode === '160000') {
      gitlinks.push(record.path)
      continue
    }
    assert.fail(`unsupported Git index mode ${record.mode}: ${record.path}`)
  }
  assert.deepEqual(
    gitlinks.sort(),
    [...expectedGitlinks].sort(),
    'tracked gitlinks must match the explicit allowlist'
  )
  return blobs
}

function assertEditorConfigBody(contents) {
  const lines = contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith(';'))
  const sections = []
  const assignments = []
  let section = null

  for (const [index, line] of lines.entries()) {
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line
      sections.push({ index, section })
      continue
    }
    const match = /^([^=]+?)\s*=\s*(.*?)$/u.exec(line)
    assert.ok(match, `invalid .editorconfig directive: ${line}`)
    assignments.push({
      key: match[1].trim().toLowerCase(),
      section,
      value: match[2].trim().toLowerCase(),
    })
  }

  const generalSections = sections.filter(({ section }) => section === '[*]')
  const windowsSections = sections.filter(({ section }) => section === '[*.{bat,cmd}]')
  assert.equal(generalSections.length, 1, '.editorconfig must contain exactly one [*] section')
  assert.equal(
    windowsSections.length,
    1,
    '.editorconfig must contain exactly one [*.{bat,cmd}] section'
  )
  assert.ok(
    generalSections[0].index < windowsSections[0].index,
    'the Windows EOL override must follow the general policy'
  )
  assert.deepEqual(
    assignments.filter(({ key }) => key === 'root'),
    [{ key: 'root', section: null, value: 'true' }],
    '.editorconfig must declare one root policy'
  )
  assert.deepEqual(
    assignments.filter(({ key }) => key === 'charset'),
    [{ key: 'charset', section: '[*]', value: 'utf-8' }],
    '.editorconfig must declare one UTF-8 policy'
  )
  assert.deepEqual(
    assignments.filter(({ key }) => key === 'end_of_line'),
    [
      { key: 'end_of_line', section: '[*]', value: 'lf' },
      { key: 'end_of_line', section: '[*.{bat,cmd}]', value: 'crlf' },
    ],
    '.editorconfig EOL assignments must match the Git checkout policy exactly'
  )
}

function assertEditorConfigPolicy(repositoryRoot) {
  assertEditorConfigBody(stagedText(repositoryRoot, '.editorconfig'))
}

function indexedBlobMap(repositoryRoot, objectIds) {
  const uniqueObjectIds = [...new Set(objectIds)]
  if (uniqueObjectIds.length === 0) return new Map()
  const output = runGit(repositoryRoot, ['cat-file', '--batch'], {
    encoding: null,
    input: `${uniqueObjectIds.join('\n')}\n`,
  })
  assert.ok(Buffer.isBuffer(output), 'Git blob output must remain binary')

  const blobs = new Map()
  let offset = 0
  for (const expectedObjectId of uniqueObjectIds) {
    const newline = output.indexOf(10, offset)
    assert.notEqual(newline, -1, `Git blob header missing for ${expectedObjectId}`)
    const header = output.subarray(offset, newline).toString('ascii')
    const match = /^([0-9a-f]{40,64}) blob ([0-9]+)$/u.exec(header)
    assert.ok(match, `unexpected Git blob header: ${header}`)
    assert.equal(match[1], expectedObjectId, 'Git blob response order drifted')
    const size = Number(match[2])
    assert.ok(Number.isSafeInteger(size), `invalid Git blob size: ${match[2]}`)
    const start = newline + 1
    const end = start + size
    assert.ok(end < output.length, `Git blob body is truncated: ${expectedObjectId}`)
    assert.equal(output[end], 10, `Git blob body delimiter missing: ${expectedObjectId}`)
    blobs.set(expectedObjectId, output.subarray(start, end))
    offset = end + 1
  }
  assert.equal(offset, output.length, 'Git blob output contains trailing data')
  return blobs
}

function attributesForPaths(repositoryRoot, paths) {
  if (paths.length === 0) return new Map()
  const output = runGit(
    repositoryRoot,
    ['check-attr', '--cached', '-z', '--stdin', ...attributeNames],
    {
      encoding: null,
      input: Buffer.from(`${paths.join('\0')}\0`),
    }
  )
  assert.ok(Buffer.isBuffer(output), 'Git attribute output must remain binary')
  assert.equal(output.at(-1), 0, 'Git attribute output must end with NUL')
  const fields = output.subarray(0, -1).toString('utf8').split('\0')
  assert.equal(fields.length % 3, 0, 'Git attribute output must use path/name/value triples')

  const results = new Map(paths.map((path) => [path, {}]))
  for (let index = 0; index < fields.length; index += 3) {
    const [path, name, value] = fields.slice(index, index + 3)
    assert.ok(results.has(path), `Git returned an unexpected attribute path: ${path}`)
    assert.ok(attributeNames.includes(name), `Git returned an unexpected attribute: ${name}`)
    results.get(path)[name] = value
  }
  for (const [path, attributes] of results) {
    assert.deepEqual(
      Object.keys(attributes).sort(),
      [...attributeNames].sort(),
      `Git did not resolve every attribute for ${path}`
    )
  }
  return results
}

function isUtf8Text(contents) {
  if (contents.includes(0)) return false
  try {
    utf8Decoder.decode(contents)
    return true
  } catch {
    return false
  }
}

function assertIndexText(contents, path) {
  assert.equal(
    contents.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
    false,
    `${path} must not use a UTF-8 BOM`
  )
  assert.equal(contents.includes(13), false, `${path} must store LF, not CR, in the Git index`)
}

test('tracked Git blobs match the canonical text and binary attribute policy', () => {
  const records = governedBlobRecords(root)
  assertEditorConfigPolicy(root)
  const blobs = indexedBlobMap(
    root,
    records.map(({ objectId }) => objectId)
  )
  const attributes = attributesForPaths(
    root,
    records.map(({ path }) => path)
  )
  let binaryCount = 0
  let textCount = 0

  for (const record of records) {
    const contents = blobs.get(record.objectId)
    assert.ok(contents, `Git index blob is unavailable: ${record.path}`)
    const extension = extname(record.path).toLowerCase()
    const pathAttributes = attributes.get(record.path)
    assert.equal(pathAttributes.filter, 'unspecified', `${record.path} must not use a filter`)
    assert.equal(
      pathAttributes['working-tree-encoding'],
      'unspecified',
      `${record.path} must not change working-tree encoding`
    )
    assert.equal(pathAttributes.ident, 'unspecified', `${record.path} must not expand identifiers`)

    if (isUtf8Text(contents)) {
      textCount += 1
      assertIndexText(contents, record.path)
      assert.equal(
        binaryExtensions.has(extension),
        false,
        `${record.path} uses a binary extension but contains text`
      )
      assert.equal(pathAttributes.binary, 'unspecified', `${record.path} must not be binary`)
      assert.equal(pathAttributes.diff, 'unspecified', `${record.path} must use normal text diff`)
      assert.equal(pathAttributes.merge, 'unspecified', `${record.path} must use normal text merge`)
      assert.equal(
        pathAttributes.text,
        extension === '.bat' || extension === '.cmd' ? 'set' : 'auto',
        `${record.path} has an unexpected text attribute`
      )
      assert.equal(
        pathAttributes.eol,
        extension === '.bat' || extension === '.cmd' ? 'crlf' : 'lf',
        `${record.path} has an unexpected working-tree EOL`
      )
      continue
    }

    binaryCount += 1
    assert.ok(binaryExtensions.has(extension), `${record.path} uses an unregistered binary format`)
    assert.equal(pathAttributes.binary, 'set', `${record.path} must set the binary macro`)
    assert.equal(pathAttributes.text, 'unset', `${record.path} must disable text conversion`)
    assert.equal(pathAttributes.diff, 'unset', `${record.path} must disable text diff`)
    assert.equal(pathAttributes.merge, 'unset', `${record.path} must disable text merge`)
  }

  assert.ok(textCount > 0, 'repository must contain governed text blobs')
  assert.ok(binaryCount > 0, 'repository must contain governed binary blobs')
})

test('Git normalizes index text while preserving checkout-specific EOL and binary bytes', (t) => {
  const fixture = mkdtempSync(join(tmpdir(), 'arena-git-attributes-'))
  t.after(() => rmSync(fixture, { force: true, recursive: true }))
  runGit(fixture, ['init', '--quiet'])
  mkdirSync(join(fixture, 'android'), { recursive: true })
  mkdirSync(join(fixture, 'public'), { recursive: true })
  mkdirSync(join(fixture, 'src'), { recursive: true })
  const attributesBody = stagedText(root, '.gitattributes')
  writeFileSync(join(fixture, '.gitattributes'), attributesBody)
  writeFileSync(join(fixture, 'src/app.ts'), 'export const value = true\r\n')
  writeFileSync(join(fixture, 'android/gradlew.bat'), '@echo off\r\necho arena\r\n')
  writeFileSync(join(fixture, 'android/run.cmd'), '@echo off\r\necho arena\r\n')
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0xff])
  writeFileSync(join(fixture, 'public/logo.png'), binary)
  runGit(fixture, ['add', '--', '.gitattributes', 'android', 'public', 'src'], {
    stdio: 'pipe',
  })
  writeFileSync(join(fixture, '.gitattributes'), '* -text\n')
  governedBlobRecords(fixture, new Set())
  const stagedAttributes = attributesForPaths(fixture, ['src/app.ts', 'public/logo.png'])
  assert.equal(stagedAttributes.get('src/app.ts').text, 'auto')
  assert.equal(stagedAttributes.get('src/app.ts').eol, 'lf')
  assert.equal(stagedAttributes.get('public/logo.png').binary, 'set')
  assert.equal(stagedAttributes.get('public/logo.png').text, 'unset')

  assert.equal(runGit(fixture, ['show', ':src/app.ts']).includes('\r'), false)
  assert.equal(runGit(fixture, ['show', ':android/gradlew.bat']).includes('\r'), false)
  assert.equal(runGit(fixture, ['show', ':android/run.cmd']).includes('\r'), false)
  assert.deepEqual(runGit(fixture, ['show', ':public/logo.png'], { encoding: null }), binary)

  writeFileSync(join(fixture, '.gitattributes'), attributesBody)

  for (const path of ['src/app.ts', 'android/gradlew.bat', 'android/run.cmd', 'public/logo.png']) {
    rmSync(join(fixture, path))
  }
  runGit(fixture, ['checkout-index', '--force', '--all'])
  assert.equal(readFileSync(join(fixture, 'src/app.ts'), 'utf8').includes('\r'), false)
  assert.match(readFileSync(join(fixture, 'android/gradlew.bat'), 'utf8'), /\r\n/u)
  assert.match(readFileSync(join(fixture, 'android/run.cmd'), 'utf8'), /\r\n/u)
  assert.deepEqual(readFileSync(join(fixture, 'public/logo.png')), binary)

  const futureAttributes = attributesForPaths(fixture, [
    'scripts/task.sh',
    'android/launch.cmd',
    'public/photo.jpeg',
  ])
  assert.equal(futureAttributes.get('scripts/task.sh').eol, 'lf')
  assert.equal(futureAttributes.get('android/launch.cmd').eol, 'crlf')
  assert.equal(futureAttributes.get('public/photo.jpeg').binary, 'set')
})

test('attribute policy fails closed on staged drift, nested policy, local overrides, and modes', async (t) => {
  async function policyFixture(name, callback) {
    await t.test(name, () => {
      const fixture = mkdtempSync(join(tmpdir(), 'arena-git-attribute-policy-'))
      try {
        runGit(fixture, ['init', '--quiet'])
        writeFileSync(join(fixture, '.gitattributes'), stagedText(root, '.gitattributes'))
        runGit(fixture, ['add', '--', '.gitattributes'])
        callback(fixture)
      } finally {
        rmSync(fixture, { force: true, recursive: true })
      }
    })
  }

  await policyFixture(
    'rejects a bad staged policy hidden by a good working-tree copy',
    (fixture) => {
      writeFileSync(join(fixture, '.gitattributes'), '* text=auto eol=lf\n')
      runGit(fixture, ['add', '--', '.gitattributes'])
      writeFileSync(join(fixture, '.gitattributes'), stagedText(root, '.gitattributes'))
      assert.throws(
        () => governedBlobRecords(fixture, new Set()),
        /staged \.gitattributes directives/u
      )
    }
  )

  await policyFixture('rejects nested attribute policy', (fixture) => {
    mkdirSync(join(fixture, 'app'), { recursive: true })
    writeFileSync(join(fixture, 'app/.gitattributes'), '*.ts filter=evil -diff -merge\n')
    runGit(fixture, ['add', '--', 'app/.gitattributes'])
    assert.throws(
      () => governedBlobRecords(fixture, new Set()),
      /only the canonical root \.gitattributes/u
    )
  })

  await policyFixture('rejects repository-local info attribute overrides', (fixture) => {
    const rawPath = runGit(fixture, ['rev-parse', '--git-path', 'info/attributes']).trim()
    const infoAttributesPath = resolve(fixture, rawPath)
    mkdirSync(dirname(infoAttributesPath), { recursive: true })
    writeFileSync(infoAttributesPath, '*.png binary\n')
    assert.throws(
      () => governedBlobRecords(fixture, new Set()),
      /info\/attributes must not override/u
    )
  })

  await policyFixture('rejects unregistered index modes', (fixture) => {
    const objectId = runGit(fixture, ['hash-object', '-w', '--stdin'], {
      input: 'target\n',
    }).trim()
    runGit(fixture, ['update-index', '--add', '--cacheinfo', `120000,${objectId},link`])
    assert.throws(() => governedBlobRecords(fixture, new Set()), /unsupported Git index mode/u)
  })
})

test('binary index parsing preserves tab, newline, and Unicode path bytes', () => {
  const objectId = 'a'.repeat(40)
  const paths = ['src/tab\tname.ts', 'src/new\nline.ts', 'src/Σ.ts']
  const output = Buffer.concat(
    paths.map((path) => Buffer.from(`100644 ${objectId} 0\t${path}\0`, 'utf8'))
  )
  assert.deepEqual(
    parseIndexRecords(output).map(({ path }) => path),
    paths
  )
})

test('editor policy rejects duplicate and case-variant EOL overrides', () => {
  const body = stagedText(root, '.editorconfig')
  assert.throws(
    () =>
      assertEditorConfigBody(
        body.replace('end_of_line = lf', 'end_of_line = lf\nEND_OF_LINE = CRLF')
      ),
    /EOL assignments must match/u
  )
  assert.throws(
    () =>
      assertEditorConfigBody(
        body.replace('[*.{bat,cmd}]', '[*.ts]\nend_of_line = crlf\n\n[*.{bat,cmd}]')
      ),
    /EOL assignments must match/u
  )
})
