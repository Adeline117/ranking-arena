import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { parseDocument, visit } from 'yaml'

const root = path.resolve(import.meta.dirname, '../..')
const workflowsDirectory = path.join(root, '.github/workflows')
const githubActionReference =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/
const dockerReference = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/
const releaseComment = /^v\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?$/

function relativePath(filePath) {
  return path.relative(root, filePath).split(path.sep).join('/')
}

function readRegularFile(filePath) {
  const metadata = fs.lstatSync(filePath)
  assert.equal(metadata.isSymbolicLink(), false, `${relativePath(filePath)} must not be a symlink`)
  assert.equal(metadata.isFile(), true, `${relativePath(filePath)} must be a regular file`)
  return fs.readFileSync(filePath, 'utf8')
}

function parseYaml(filePath) {
  const source = readRegularFile(filePath)
  const document = parseDocument(source, {
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
    version: '1.2',
  })
  const errors = [...document.errors, ...document.warnings]
  assert.equal(
    errors.length,
    0,
    `${relativePath(filePath)} must be strict YAML:\n${errors.map(String).join('\n')}`
  )

  let value
  try {
    value = document.toJS({ maxAliasCount: 100 })
  } catch (error) {
    assert.fail(`${relativePath(filePath)} could not be safely decoded: ${String(error)}`)
  }
  return { document, source, value }
}

function discoverWorkflowFiles(directory = workflowsDirectory) {
  const metadata = fs.lstatSync(directory)
  assert.equal(metadata.isSymbolicLink(), false, `${relativePath(directory)} must not be a symlink`)
  assert.equal(metadata.isDirectory(), true, `${relativePath(directory)} must be a directory`)

  const files = []
  for (const entry of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(directory, entry.name)
    const entryMetadata = fs.lstatSync(entryPath)
    assert.equal(
      entryMetadata.isSymbolicLink(),
      false,
      `${relativePath(entryPath)} must not be a symlink`
    )
    if (entryMetadata.isDirectory()) {
      files.push(...discoverWorkflowFiles(entryPath))
      continue
    }
    assert.equal(entryMetadata.isFile(), true, `${relativePath(entryPath)} has an unsupported type`)
    if (/\.ya?ml$/i.test(entry.name)) files.push(entryPath)
  }
  return files
}

function lineNumber(source, node) {
  const offset = node?.range?.[0] ?? 0
  return source.slice(0, offset).split('\n').length
}

function classifyUsesReference(reference, context) {
  assert.equal(typeof reference, 'string', `${context}: uses must be a string`)
  assert.notEqual(reference.length, 0, `${context}: uses must not be empty`)

  if (reference.startsWith('./')) {
    assert.equal(
      reference.includes('\\'),
      false,
      `${context}: local uses must use POSIX separators`
    )
    assert.match(reference, /^\.\/[^@\s]+$/, `${context}: invalid local action reference`)
    const segments = reference.slice(2).split('/')
    assert.ok(
      segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
      `${context}: local uses must not contain empty or traversal segments`
    )
    return 'local'
  }

  if (reference.startsWith('docker://')) {
    assert.match(
      reference,
      dockerReference,
      `${context}: Docker actions must use a lowercase sha256 digest`
    )
    return 'docker'
  }

  assert.match(
    reference,
    githubActionReference,
    `${context}: GitHub actions must use a full lowercase 40-character commit SHA`
  )
  return 'github'
}

function validateLocalTarget(reference, context) {
  const segments = reference.slice(2).split('/')
  const target = path.resolve(root, ...segments)
  const repositoryRelative = path.relative(root, target)
  assert.ok(
    repositoryRelative !== '' &&
      !repositoryRelative.startsWith(`..${path.sep}`) &&
      repositoryRelative !== '..' &&
      !path.isAbsolute(repositoryRelative),
    `${context}: local action target must stay inside the repository`
  )

  let current = root
  let targetMetadata
  for (const segment of segments) {
    current = path.join(current, segment)
    try {
      targetMetadata = fs.lstatSync(current)
    } catch (error) {
      assert.fail(`${context}: local action target does not exist (${String(error)})`)
    }
    assert.equal(
      targetMetadata.isSymbolicLink(),
      false,
      `${context}: local action path uses a symlink`
    )
  }
  assert.ok(
    targetMetadata?.isDirectory() || targetMetadata?.isFile(),
    `${context}: local action target must be a file or directory`
  )
}

function validateWorkflow(filePath) {
  const { document, source, value } = parseYaml(filePath)
  const workflowName = relativePath(filePath)
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${workflowName} is empty`)
  assert.ok(
    value.jobs && typeof value.jobs === 'object' && !Array.isArray(value.jobs),
    `${workflowName} must define a jobs mapping`
  )

  let references = 0
  visit(document, {
    Pair(_key, pair) {
      if (pair.key?.value !== 'uses') return
      references += 1
      const context = `${workflowName}:${lineNumber(source, pair.value)}`
      const reference = pair.value?.value
      const kind = classifyUsesReference(reference, context)

      if (kind === 'local') validateLocalTarget(reference, context)
      if (kind === 'github') {
        assert.equal(
          typeof pair.value.comment,
          'string',
          `${context}: pinned GitHub action must retain its release comment`
        )
        assert.match(
          pair.value.comment.trim(),
          releaseComment,
          `${context}: release comment must be a v-prefixed release`
        )
      }
    },
  })
  return references
}

function validateGithubActionsDependabotPolicy(policy, context) {
  assert.equal(policy.directory, '/', `${context}: directory must be /`)
  assert.ok(
    ['daily', 'weekly', 'monthly'].includes(policy.schedule?.interval),
    `${context}: schedule interval must be daily, weekly, or monthly`
  )
  assert.ok(
    Number.isInteger(policy['open-pull-requests-limit']) && policy['open-pull-requests-limit'] > 0,
    `${context}: open-pull-requests-limit must be a positive integer`
  )

  for (const [index, rule] of (policy.ignore ?? []).entries()) {
    if (rule['dependency-name'] !== '*') continue
    const updateTypes = rule['update-types']
    assert.ok(
      Array.isArray(updateTypes) && updateTypes.length > 0,
      `${context}: wildcard ignore ${index} must name update-types`
    )
    assert.deepEqual(
      updateTypes,
      ['version-update:semver-major'],
      `${context}: wildcard ignore may suppress only semver-major updates`
    )
  }
}

test('all workflow action references are immutable and auditable', () => {
  const workflowFiles = discoverWorkflowFiles()
  assert.ok(workflowFiles.length > 0, 'at least one workflow YAML file is required')
  const referenceCount = workflowFiles.reduce(
    (count, workflowFile) => count + validateWorkflow(workflowFile),
    0
  )
  assert.ok(referenceCount > 0, 'at least one workflow action reference is required')
})

test('reference validation rejects mutable and unsafe action sources', () => {
  const sha = 'a'.repeat(40)
  const digest = 'b'.repeat(64)
  assert.equal(classifyUsesReference(`owner/action@${sha}`, 'fixture'), 'github')
  assert.equal(
    classifyUsesReference(`docker://ghcr.io/acme/action@sha256:${digest}`, 'fixture'),
    'docker'
  )
  assert.equal(classifyUsesReference('./.github/actions/example', 'fixture'), 'local')

  for (const reference of [
    'owner/action@main',
    'owner/action@v4',
    'owner/action@abcdef0',
    'owner/action@${{ github.sha }}',
    'docker://ghcr.io/acme/action:latest',
    `docker://ghcr.io/acme/action@sha256:${'B'.repeat(64)}`,
    './../outside',
    './.github/../outside',
    '.\\github\\actions\\example',
  ]) {
    assert.throws(() => classifyUsesReference(reference, 'fixture'), { name: 'AssertionError' })
  }
})

test('Dependabot keeps pinned GitHub actions updateable', () => {
  const dependabotPath = path.join(root, '.github/dependabot.yml')
  const { value } = parseYaml(dependabotPath)
  assert.equal(value?.version, 2, '.github/dependabot.yml must use version 2')
  assert.ok(Array.isArray(value.updates), '.github/dependabot.yml must define updates')

  const policies = value.updates.filter(
    (update) => update?.['package-ecosystem'] === 'github-actions'
  )
  assert.equal(policies.length, 1, 'Dependabot must define exactly one github-actions policy')
  validateGithubActionsDependabotPolicy(policies[0], 'Dependabot github-actions policy')

  const basePolicy = {
    directory: '/',
    schedule: { interval: 'monthly' },
    'open-pull-requests-limit': 10,
  }
  for (const ignore of [
    [{ 'dependency-name': '*' }],
    [{ 'dependency-name': '*', 'update-types': ['version-update:semver-minor'] }],
    [{ 'dependency-name': '*', 'update-types': ['version-update:semver-patch'] }],
  ]) {
    assert.throws(
      () => validateGithubActionsDependabotPolicy({ ...basePolicy, ignore }, 'fixture'),
      { name: 'AssertionError' }
    )
  }
  assert.throws(
    () =>
      validateGithubActionsDependabotPolicy(
        { ...basePolicy, 'open-pull-requests-limit': 0 },
        'fixture'
      ),
    { name: 'AssertionError' }
  )
})
