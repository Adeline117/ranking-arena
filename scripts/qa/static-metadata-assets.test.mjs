import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const thisTest = 'scripts/qa/static-metadata-assets.test.mjs'

const retiredPublicAliases = [
  'public/favicon-16.png',
  'public/favicon-32.png',
  'public/icon-192.png',
  'public/icon-512.png',
]

const canonicalAssetByRoute = new Map([
  ['/favicon.ico', 'app/favicon.ico'],
  ['/icons/icon.svg', 'public/icons/icon.svg'],
  ['/icons/icon-192x192.png', 'public/icons/icon-192x192.png'],
  ['/icons/icon-512x512.png', 'public/icons/icon-512x512.png'],
  ['/icons/apple-touch-icon.png', 'public/icons/apple-touch-icon.png'],
])

const expectedLayoutIconRoutes = [
  '/favicon.ico',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192x192.png',
  '/icons/icon.svg',
]

const expectedManifestIconRoutes = [
  '/icons/apple-touch-icon.png',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  '/icons/icon.svg',
]

function assertTracked(path) {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', path], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || `${path} must be tracked`)
  assert.equal(result.stdout.trim(), path)
}

function assertUntracked(path) {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', path], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 1, result.stderr || `${path} must not be tracked`)
}

function assertRegularTrackedFile(path) {
  const segments = path.split('/')
  let cursor = root

  for (const [index, segment] of segments.entries()) {
    cursor = resolve(cursor, segment)
    const metadata = lstatSync(cursor, { throwIfNoEntry: false })
    assert.ok(metadata, `${path} must exist`)
    assert.equal(metadata.isSymbolicLink(), false, `${path} must not traverse a symbolic link`)
    if (index === segments.length - 1) {
      assert.equal(metadata.isFile(), true, `${path} must be a regular file`)
    } else {
      assert.equal(metadata.isDirectory(), true, `${path} has a non-directory ancestor`)
    }
  }

  assertTracked(path)
}

function propertyName(property) {
  if (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) {
    return property.name.text
  }
  return undefined
}

function unwrapExpression(expression) {
  let current = expression
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function requiredProperty(object, name, owner) {
  const matches = object.properties.filter(
    (property) => ts.isPropertyAssignment(property) && propertyName(property) === name
  )
  assert.equal(matches.length, 1, `${owner} must declare exactly one ${name} property`)
  return unwrapExpression(matches[0].initializer)
}

function assertNoSpreadProperties(object, owner) {
  for (const property of object.properties) {
    assert.equal(ts.isSpreadAssignment(property), false, `${owner} must not use spread properties`)
  }
}

function requiredString(expression, owner) {
  assert.equal(ts.isStringLiteralLike(expression), true, `${owner} must be a string literal`)
  return expression.text
}

function readLayoutMetadata(layout) {
  const source = ts.createSourceFile(
    'app/layout.tsx',
    layout,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  assert.equal(source.parseDiagnostics.length, 0, 'app/layout.tsx must parse without diagnostics')
  const declarations = []

  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    )
    if (!exported) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === 'metadata') {
        declarations.push(declaration)
      }
    }
  }

  assert.equal(declarations.length, 1, 'app/layout.tsx must export exactly one metadata variable')
  assert.ok(declarations[0].initializer, 'metadata must have an initializer')
  const metadata = unwrapExpression(declarations[0].initializer)
  assert.equal(ts.isObjectLiteralExpression(metadata), true, 'metadata must be an object literal')
  assertNoSpreadProperties(metadata, 'metadata')

  const manifest = requiredString(
    requiredProperty(metadata, 'manifest', 'metadata'),
    'metadata.manifest'
  )
  const icons = requiredProperty(metadata, 'icons', 'metadata')
  assert.equal(
    ts.isObjectLiteralExpression(icons),
    true,
    'metadata.icons must be an object literal'
  )
  assertNoSpreadProperties(icons, 'metadata.icons')
  assert.deepEqual(
    icons.properties.map(propertyName).sort(),
    ['apple', 'icon'],
    'metadata.icons must contain only the reviewed icon groups'
  )

  const iconRoutes = []
  for (const group of ['icon', 'apple']) {
    const entries = requiredProperty(icons, group, 'metadata.icons')
    assert.equal(
      ts.isArrayLiteralExpression(entries),
      true,
      `metadata.icons.${group} must be an array`
    )
    for (const [index, entryExpression] of entries.elements.entries()) {
      const entry = unwrapExpression(entryExpression)
      assert.equal(
        ts.isObjectLiteralExpression(entry),
        true,
        `metadata.icons.${group}[${index}] must be an object literal`
      )
      assertNoSpreadProperties(entry, `metadata.icons.${group}[${index}]`)
      iconRoutes.push(
        requiredString(
          requiredProperty(entry, 'url', `metadata.icons.${group}[${index}]`),
          `metadata.icons.${group}[${index}].url`
        )
      )
    }
  }

  return { iconRoutes, manifest }
}

function collectManifestIconRoutes(value, owner = 'manifest') {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectManifestIconRoutes(entry, `${owner}[${index}]`))
  }
  if (value === null || typeof value !== 'object') return []

  const routes = []
  for (const [key, child] of Object.entries(value)) {
    const childOwner = `${owner}.${key}`
    if (key === 'icons') {
      assert.equal(Array.isArray(child), true, `${childOwner} must be an array`)
      for (const [index, icon] of child.entries()) {
        assert.equal(
          icon !== null && typeof icon === 'object' && !Array.isArray(icon),
          true,
          `${childOwner}[${index}] must be an object`
        )
        assert.equal(typeof icon.src, 'string', `${childOwner}[${index}].src must be a string`)
        routes.push(icon.src)
      }
    }
    routes.push(...collectManifestIconRoutes(child, childOwner))
  }
  return routes
}

function pathname(route) {
  const query = route.indexOf('?')
  const hash = route.indexOf('#')
  const end = Math.min(query === -1 ? route.length : query, hash === -1 ? route.length : hash)
  return route.slice(0, end)
}

function assertCanonicalRoutes(routes, expected, owner) {
  const normalized = routes.map(pathname)
  assert.deepEqual([...new Set(normalized)].sort(), [...expected].sort(), `${owner} routes drifted`)

  for (const route of normalized) {
    assert.equal(
      canonicalAssetByRoute.has(route),
      true,
      `${owner} references non-canonical ${route}`
    )
    assertRegularTrackedFile(canonicalAssetByRoute.get(route))
  }
}

test('favicon has one canonical App Router owner', () => {
  const canonical = 'app/favicon.ico'
  const duplicatePublicRoute = 'public/favicon.ico'
  const canonicalMetadata = lstatSync(resolve(root, canonical))

  assert.equal(canonicalMetadata.isSymbolicLink(), false)
  assert.equal(canonicalMetadata.isFile(), true)
  assertTracked(canonical)
  assert.equal(
    lstatSync(resolve(root, duplicatePublicRoute), { throwIfNoEntry: false }),
    undefined,
    `${duplicatePublicRoute} must not duplicate the App Router metadata route`
  )
})

test('retired public icon aliases stay absent, untracked, and unreferenced', () => {
  for (const path of retiredPublicAliases) {
    assert.equal(
      lstatSync(resolve(root, path), { throwIfNoEntry: false }),
      undefined,
      `${path} must stay retired, including as a symbolic link`
    )
    assertUntracked(path)
  }

  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'buffer' })
  assert.equal(listed.status, 0, listed.stderr.toString() || 'git ls-files failed')
  const trackedPaths = listed.stdout.toString('utf8').split('\0').filter(Boolean)

  for (const trackedPath of trackedPaths) {
    if (trackedPath === thisTest) continue
    const metadata = lstatSync(resolve(root, trackedPath), { throwIfNoEntry: false })
    assert.ok(metadata, `${trackedPath} is tracked but missing from the worktree`)
    let contents
    if (metadata.isSymbolicLink()) {
      contents = Buffer.from(readlinkSync(resolve(root, trackedPath)))
    } else if (metadata.isFile()) {
      contents = readFileSync(resolve(root, trackedPath))
    } else {
      continue
    }
    for (const retiredPath of retiredPublicAliases) {
      const retiredName = retiredPath.slice(retiredPath.lastIndexOf('/') + 1)
      assert.equal(
        contents.includes(Buffer.from(retiredName)),
        false,
        `${trackedPath} must not reference retired asset ${retiredName}`
      )
    }
  }
})

test('layout and web manifest reference only canonical tracked regular icon assets', () => {
  const layout = readFileSync(resolve(root, 'app/layout.tsx'), 'utf8')
  const metadata = readLayoutMetadata(layout)
  assert.equal(metadata.manifest, '/manifest.json')
  assertRegularTrackedFile('public/manifest.json')
  assertCanonicalRoutes(metadata.iconRoutes, expectedLayoutIconRoutes, 'app/layout.tsx metadata')

  const manifest = JSON.parse(readFileSync(resolve(root, 'public/manifest.json'), 'utf8'))
  const manifestIconRoutes = collectManifestIconRoutes(manifest)
  assert.ok(manifestIconRoutes.length > 0, 'public/manifest.json must declare icon assets')
  assertCanonicalRoutes(manifestIconRoutes, expectedManifestIconRoutes, 'public/manifest.json')
})
