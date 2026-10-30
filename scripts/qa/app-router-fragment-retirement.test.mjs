import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { devNull, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import test from 'node:test'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const root = resolve(import.meta.dirname, '../..')
const contractPath = relative(root, import.meta.filename)
const appRoot = join(root, 'app')
const legacySource = '/admin/data-health'
const canonicalDestination = '/admin?tab=scraperStatus'
const retainedPrototypePath = 'app/design-system/LeaderboardRedesignPreview.tsx'
const prototypeReferenceNeedles = [
  'LeaderboardRedesignPreview',
  'app/design-system/LeaderboardRedesignPreview',
]

const retiredFragmentPaths = [
  'app/(app)/admin/data-health/error.tsx',
  'app/(app)/admin/data-health/loading.tsx',
]
const retiredFragmentDirectory = 'app/(app)/admin/data-health'
const retiredRoutes = new Set(['/design-system', legacySource])
const retiredReferenceNeedles = [
  'app/(app)/admin/data-health/error.tsx',
  'app/(app)/admin/data-health/loading.tsx',
  'admin/data-health/error',
  'admin/data-health/loading',
]
const routeEntryPattern = /^(?:page|route)\.(?:js|jsx|ts|tsx)$/
const interceptionMarkerOnly = new Set(['(.)', '(..)', '(..)(..)', '(...)'])
const explicitTestDirectorySegments = new Set(['__mocks__', '__tests__'])
const topLevelTestRoots = new Set(['__integration__', 'e2e', 'test', 'tests'])
const rootToolingSources = new Set([
  'check-bigint-build-output.mjs',
  'eslint.config.mjs',
  'jest.config.js',
  'jest.ingest-integration.config.js',
  'jest.setup.js',
  'lighthouserc.js',
  'playwright.authenticated.config.ts',
  'playwright.config.ts',
])

function lstatOrNull(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
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
  }
}

function runGit(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd ?? root,
    encoding: Object.hasOwn(options, 'encoding') ? options.encoding : 'utf8',
    env: isolatedGitEnvironment(options.inheritedEnvironment),
    input: options.input,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
  })
}

function assertSafeRepositoryPath(repositoryRoot, repositoryPath) {
  assert.ok(repositoryPath.length > 0, 'Git returned an empty repository path')
  assert.equal(
    isAbsolute(repositoryPath),
    false,
    `Git returned an absolute path: ${repositoryPath}`
  )

  const resolvedRoot = resolve(repositoryRoot)
  const resolvedPath = resolve(resolvedRoot, repositoryPath)
  const pathFromRoot = relative(resolvedRoot, resolvedPath)
  assert.ok(
    pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`),
    `Git returned a path outside the repository: ${repositoryPath}`
  )
}

function gitIndexEntries(paths = [], inheritedEnvironment = process.env) {
  const args = ['ls-files', '-z']
  if (paths.length > 0) args.push('--', ...paths)
  return runGit(args, { inheritedEnvironment }).split('\0').filter(Boolean)
}

function gitIndexStageRecords(repositoryRoot = root, paths = []) {
  const arguments_ = ['ls-files', '--stage', '-z']
  if (paths.length > 0) arguments_.push('--', ...paths)
  const output = runGit(arguments_, { cwd: repositoryRoot })
  return output
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const match = /^(\d+) ([0-9a-f]+) (\d+)\t([\s\S]+)$/.exec(entry)
      assert.ok(match, `unexpected git ls-files --stage entry: ${entry}`)
      assertSafeRepositoryPath(repositoryRoot, match[4])
      return {
        mode: match[1],
        objectId: match[2],
        path: match[4],
        stage: Number(match[3]),
      }
    })
}

function gitIndexStageEntries(paths) {
  return gitIndexStageRecords(root, paths).map(({ mode, path, stage }) => ({
    mode,
    path,
    stage,
  }))
}

function isProductionJavaScriptSource(path) {
  if (!/\.(?:[cm]?[jt]sx?)$/.test(path) || path.endsWith('.d.ts')) return false
  if (path === retainedPrototypePath || path === contractPath) return false

  const segments = path.split('/')
  const fileName = segments.at(-1)
  if (/\.(?:spec|test)\.(?:[cm]?[jt]sx?)$/.test(fileName)) return false

  if (segments[0] === 'app') return true
  if (segments[0] === 'lib' || segments[0] === 'worker') {
    const sourceDirectories = segments.slice(1, -1)
    if (sourceDirectories.some((segment) => explicitTestDirectorySegments.has(segment))) {
      return false
    }
    return !topLevelTestRoots.has(segments[1])
  }
  return segments.length === 1 && !rootToolingSources.has(path)
}

function readIndexBlobs(repositoryRoot, entries) {
  if (entries.length === 0) return []
  const response = runGit(['cat-file', '--batch'], {
    cwd: repositoryRoot,
    encoding: null,
    input: `${entries.map(({ objectId }) => objectId).join('\n')}\n`,
    maxBuffer: 128 * 1024 * 1024,
  })
  const blobs = []
  let offset = 0

  for (const entry of entries) {
    const headerEnd = response.indexOf(10, offset)
    assert.notEqual(headerEnd, -1, `${entry.path} blob response is missing a header delimiter`)
    const header = response.subarray(offset, headerEnd).toString('ascii')
    const match = /^([0-9a-f]{40,64}) blob ([0-9]+)$/.exec(header)
    assert.ok(match, `${entry.path} index object is not a readable blob: ${header}`)
    assert.equal(match[1], entry.objectId, `${entry.path} index object identity drifted`)

    const size = Number(match[2])
    assert.ok(Number.isSafeInteger(size), `${entry.path} blob size is unsafe`)
    const contentStart = headerEnd + 1
    const contentEnd = contentStart + size
    assert.ok(contentEnd < response.length, `${entry.path} blob response was truncated`)
    assert.equal(response[contentEnd], 10, `${entry.path} blob response is missing its delimiter`)
    blobs.push({ ...entry, content: response.subarray(contentStart, contentEnd) })
    offset = contentEnd + 1
  }

  assert.equal(offset, response.length, 'Git returned unexpected trailing batch data')
  return blobs
}

function productionPrototypeReferenceOffenders(repositoryRoot = root) {
  const sourceEntries = gitIndexStageRecords(repositoryRoot).filter(({ path }) =>
    isProductionJavaScriptSource(path)
  )
  for (const entry of sourceEntries) {
    assert.equal(entry.stage, 0, `${entry.path} production source must be index stage zero`)
    assert.ok(
      entry.mode === '100644' || entry.mode === '100755',
      `${entry.path} production source must be a tracked regular file`
    )
  }

  const offenders = []
  for (const { content, path } of readIndexBlobs(repositoryRoot, sourceEntries)) {
    assert.equal(content.includes(0), false, `${path} production source must be textual`)
    const matches = prototypeReferenceNeedles.filter((needle) =>
      content.includes(Buffer.from(needle))
    )
    if (matches.length > 0) offenders.push({ matches, path })
  }
  return offenders
}

function trackedReferenceOffenders() {
  const offenders = []

  for (const path of gitIndexEntries()) {
    if (path === contractPath) continue

    const absolutePath = join(root, path)
    const stats = lstatOrNull(absolutePath)
    if (!stats) continue

    let source
    if (stats.isSymbolicLink()) {
      source = readlinkSync(absolutePath)
    } else if (stats.isFile()) {
      const contents = readFileSync(absolutePath)
      if (contents.includes(0)) continue
      source = contents.toString('utf8')
    } else {
      continue
    }

    for (const needle of retiredReferenceNeedles) {
      if (source.includes(needle)) offenders.push(`${path}: ${needle}`)
    }
  }

  return offenders
}

function routeFromDirectory(routerRoot, directory) {
  const pathFromApp = relative(routerRoot, directory)
  assert.ok(
    pathFromApp !== '..' && !pathFromApp.startsWith(`..${sep}`),
    'route directory escaped its app root'
  )

  const routeSegments = []
  for (const segment of pathFromApp.split(sep).filter(Boolean)) {
    if (segment.startsWith('@')) continue

    let routeSegment = segment
    if (routeSegment.startsWith('(') && routeSegment.endsWith(')')) {
      assert.equal(
        interceptionMarkerOnly.has(routeSegment),
        false,
        'interception marker requires a route segment'
      )
      continue
    }
    if (routeSegment.startsWith('(...)')) {
      routeSegments.length = 0
      routeSegment = routeSegment.slice('(...)'.length)
      assert.notEqual(routeSegment, '', 'root interception marker requires a route segment')
      assert.equal(
        /^(?:\(\.\)|\(\.\.\)|\(\.\.\.\))/.test(routeSegment),
        false,
        'unsupported interception marker chain'
      )
    } else if (routeSegment.startsWith('(.)')) {
      routeSegment = routeSegment.slice('(.)'.length)
      assert.notEqual(routeSegment, '', 'same-level interception marker requires a route segment')
      assert.equal(
        /^(?:\(\.\)|\(\.\.\)|\(\.\.\.\))/.test(routeSegment),
        false,
        'unsupported interception marker chain'
      )
    } else if (routeSegment.startsWith('(..)')) {
      let levels = 0
      while (levels < 2 && routeSegment.startsWith('(..)')) {
        levels += 1
        routeSegment = routeSegment.slice('(..)'.length)
      }
      assert.notEqual(routeSegment, '', 'parent interception marker requires a route segment')
      assert.equal(
        /^(?:\(\.\)|\(\.\.\)|\(\.\.\.\))/.test(routeSegment),
        false,
        'unsupported interception marker chain'
      )
      assert.ok(
        levels <= routeSegments.length,
        'parent interception marker escaped the app route root'
      )
      routeSegments.splice(routeSegments.length - levels, levels)
    }

    routeSegments.push(routeSegment)
  }

  return `/${routeSegments.join('/')}`
}

function routePatternMatchesPath(routePattern, concretePath) {
  const patternSegments = routePattern.split('/').filter(Boolean)
  const concreteSegments = concretePath.split('/').filter(Boolean)
  const memo = new Map()

  function matches(patternIndex, concreteIndex) {
    const memoKey = `${patternIndex}:${concreteIndex}`
    if (memo.has(memoKey)) return memo.get(memoKey)

    let result
    if (patternIndex === patternSegments.length) {
      result = concreteIndex === concreteSegments.length
    } else {
      const segment = patternSegments[patternIndex]
      if (/^\[\[\.\.\.[^/\[\]]+\]\]$/.test(segment)) {
        result = false
        for (let nextIndex = concreteIndex; nextIndex <= concreteSegments.length; nextIndex += 1) {
          if (matches(patternIndex + 1, nextIndex)) {
            result = true
            break
          }
        }
      } else if (/^\[\.\.\.[^/\[\]]+\]$/.test(segment)) {
        result = false
        for (
          let nextIndex = concreteIndex + 1;
          nextIndex <= concreteSegments.length;
          nextIndex += 1
        ) {
          if (matches(patternIndex + 1, nextIndex)) {
            result = true
            break
          }
        }
      } else if (/^\[[^/\[\]]+\]$/.test(segment)) {
        result =
          concreteIndex < concreteSegments.length && matches(patternIndex + 1, concreteIndex + 1)
      } else {
        result =
          segment === concreteSegments[concreteIndex] &&
          matches(patternIndex + 1, concreteIndex + 1)
      }
    }

    memo.set(memoKey, result)
    return result
  }

  return matches(0, 0)
}

function activeAppRouterEntries(routerRoot = appRoot, directory = routerRoot) {
  const routes = []

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      routes.push(...activeAppRouterEntries(routerRoot, path))
      continue
    }
    if (entry.isSymbolicLink()) {
      let target
      try {
        target = statSync(path)
      } catch (error) {
        throw new Error(
          `unresolved symlink is not allowed under app/: ${relative(routerRoot, path)}`,
          { cause: error }
        )
      }
      assert.equal(
        target.isDirectory(),
        false,
        `directory symlink is not allowed under app/: ${relative(routerRoot, path)}`
      )
      if (routeEntryPattern.test(entry.name)) {
        routes.push({
          path: relative(routerRoot, path),
          route: routeFromDirectory(routerRoot, dirname(path)),
        })
      }
      continue
    }
    if (entry.isFile() && routeEntryPattern.test(entry.name)) {
      routes.push({
        path: relative(routerRoot, path),
        route: routeFromDirectory(routerRoot, dirname(path)),
      })
    }
  }

  return routes
}

function retiredRouteOffenders(routerRoot = appRoot) {
  const offenders = []
  for (const entry of activeAppRouterEntries(routerRoot)) {
    for (const retiredRoute of retiredRoutes) {
      if (routePatternMatchesPath(entry.route, retiredRoute)) {
        offenders.push({ ...entry, retiredRoute })
      }
    }
  }
  return offenders
}

function unwrapExpression(expression) {
  let current = expression
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function staticPropertyName(name) {
  if (!name) return undefined
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text
  }
  if (ts.isComputedPropertyName(name)) {
    const expression = unwrapExpression(name.expression)
    if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) {
      return expression.text
    }
  }
  return undefined
}

function staticString(expression) {
  const value = unwrapExpression(expression)
  return ts.isStringLiteralLike(value) ? value.text : undefined
}

function criticalRedirectFields(object) {
  const values = new Map()
  const counts = new Map()
  let containsSpread = false
  let containsDynamicProperty = false

  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      containsSpread = true
      for (const name of ['source', 'destination', 'permanent']) values.set(name, undefined)
      continue
    }

    const name = staticPropertyName(property.name)
    if (name === undefined) {
      containsDynamicProperty = true
      for (const field of ['source', 'destination', 'permanent']) values.set(field, undefined)
      continue
    }
    if (!['source', 'destination', 'permanent'].includes(name)) continue

    counts.set(name, (counts.get(name) ?? 0) + 1)
    if (!ts.isPropertyAssignment(property)) {
      values.set(name, undefined)
      continue
    }

    const initializer = unwrapExpression(property.initializer)
    if (name === 'permanent') {
      values.set(name, initializer.kind === ts.SyntaxKind.TrueKeyword ? true : undefined)
    } else {
      values.set(name, staticString(initializer))
    }
  }

  return { containsDynamicProperty, containsSpread, counts, values }
}

function isNamedMutationTarget(expression, bindingName) {
  const target = unwrapExpression(expression)
  if (ts.isIdentifier(target)) return target.text === bindingName
  if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) {
    return isNamedMutationTarget(target.expression, bindingName)
  }
  return false
}

function bindingMutations(sourceFile, bindingName) {
  const mutations = []
  const objectMutators = new Set([
    'assign',
    'defineProperties',
    'defineProperty',
    'freeze',
    'preventExtensions',
    'seal',
    'setPrototypeOf',
  ])

  sourceFile.forEachChild(function visit(node) {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      isNamedMutationTarget(node.left, bindingName)
    ) {
      mutations.push('assignment')
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator) &&
      isNamedMutationTarget(node.operand, bindingName)
    ) {
      mutations.push('increment/decrement')
    } else if (ts.isDeleteExpression(node) && isNamedMutationTarget(node.expression, bindingName)) {
      mutations.push('delete')
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = unwrapExpression(node.expression)
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const owner = unwrapExpression(callee.expression)
        const method = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : (staticString(callee.argumentExpression) ?? '<dynamic>')
        const isMutator =
          ts.isIdentifier(owner) &&
          ((owner.text === 'Object' && objectMutators.has(method)) || owner.text === 'Reflect')
        if (isMutator && isNamedMutationTarget(node.arguments[0], bindingName)) {
          mutations.push(`${owner.text}.${method}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  })

  return mutations
}

function assertExactNextConfigType(type, label) {
  assert.ok(
    type &&
      ts.isTypeReferenceNode(type) &&
      ts.isIdentifier(type.typeName) &&
      type.typeName.text === 'NextConfig' &&
      type.typeArguments === undefined,
    `${label} must use the exact NextConfig type`
  )
}

function assertCanonicalBundleAnalyzerBinding(sourceFile, exportCallee, defaultExport) {
  const declarations = []
  sourceFile.forEachChild(function collectDeclarations(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'withBundleAnalyzer'
    ) {
      declarations.push(node)
    }
    ts.forEachChild(node, collectDeclarations)
  })
  assert.equal(
    declarations.length,
    1,
    'next.config.ts must declare exactly one withBundleAnalyzer binding'
  )

  const declaration = declarations[0]
  assert.ok(
    ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0 &&
      declaration.parent.declarations.length === 1,
    'withBundleAnalyzer must be declared by one const declaration'
  )
  assert.ok(
    ts.isVariableStatement(declaration.parent.parent) &&
      ts.isSourceFile(declaration.parent.parent.parent),
    'withBundleAnalyzer must be a top-level const'
  )
  assert.ok(
    declaration.getStart(sourceFile) < defaultExport.getStart(sourceFile),
    'withBundleAnalyzer must be declared before the default export'
  )
  assert.equal(declaration.type, undefined, 'withBundleAnalyzer must not have a decoy type')
  assert.equal(
    declaration.exclamationToken,
    undefined,
    'withBundleAnalyzer must not use definite assignment'
  )

  const initializer = declaration.initializer
  assert.ok(
    initializer && ts.isConditionalExpression(initializer),
    'withBundleAnalyzer must retain its exact environment conditional'
  )
  const condition = initializer.condition
  assert.ok(
    ts.isBinaryExpression(condition) &&
      condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken,
    'withBundleAnalyzer condition must use strict equality'
  )
  const analyzeAccess = condition.left
  assert.ok(
    ts.isPropertyAccessExpression(analyzeAccess) &&
      analyzeAccess.questionDotToken === undefined &&
      analyzeAccess.name.text === 'ANALYZE',
    'withBundleAnalyzer condition must read process.env.ANALYZE'
  )
  const environmentAccess = analyzeAccess.expression
  assert.ok(
    ts.isPropertyAccessExpression(environmentAccess) &&
      environmentAccess.questionDotToken === undefined &&
      environmentAccess.name.text === 'env' &&
      ts.isIdentifier(environmentAccess.expression) &&
      environmentAccess.expression.text === 'process',
    'withBundleAnalyzer condition must read process.env.ANALYZE'
  )
  assert.ok(
    ts.isStringLiteral(condition.right) && condition.right.text === 'true',
    "withBundleAnalyzer condition must compare ANALYZE with 'true'"
  )

  const enabledBranch = initializer.whenTrue
  assert.ok(
    ts.isCallExpression(enabledBranch) &&
      enabledBranch.questionDotToken === undefined &&
      enabledBranch.typeArguments === undefined,
    'withBundleAnalyzer enabled branch must be a direct untyped call'
  )
  assert.equal(enabledBranch.arguments.length, 1, 'bundle analyzer factory must receive one option')
  const requireCall = enabledBranch.expression
  assert.ok(
    ts.isCallExpression(requireCall) &&
      requireCall.questionDotToken === undefined &&
      requireCall.typeArguments === undefined &&
      ts.isIdentifier(requireCall.expression) &&
      requireCall.expression.text === 'require' &&
      requireCall.arguments.length === 1 &&
      ts.isStringLiteral(requireCall.arguments[0]) &&
      requireCall.arguments[0].text === '@next/bundle-analyzer',
    'withBundleAnalyzer must require the exact bundle analyzer package'
  )
  const analyzerOptions = enabledBranch.arguments[0]
  assert.ok(
    ts.isObjectLiteralExpression(analyzerOptions) && analyzerOptions.properties.length === 1,
    'bundle analyzer options must contain only enabled'
  )
  const enabledProperty = analyzerOptions.properties[0]
  assert.ok(
    ts.isPropertyAssignment(enabledProperty) &&
      ts.isIdentifier(enabledProperty.name) &&
      enabledProperty.name.text === 'enabled' &&
      enabledProperty.initializer.kind === ts.SyntaxKind.TrueKeyword,
    'bundle analyzer must be enabled in the ANALYZE branch'
  )

  const disabledBranch = initializer.whenFalse
  assert.ok(
    ts.isArrowFunction(disabledBranch) &&
      disabledBranch.modifiers === undefined &&
      disabledBranch.parameters.length === 1 &&
      disabledBranch.typeParameters === undefined &&
      disabledBranch.type === undefined,
    'withBundleAnalyzer disabled branch must be a one-parameter identity arrow'
  )
  const configParameter = disabledBranch.parameters[0]
  assert.ok(
    ts.isIdentifier(configParameter.name) &&
      configParameter.name.text === 'config' &&
      configParameter.dotDotDotToken === undefined &&
      configParameter.questionToken === undefined &&
      configParameter.initializer === undefined,
    'withBundleAnalyzer disabled branch must accept config directly'
  )
  assertExactNextConfigType(configParameter.type, 'withBundleAnalyzer disabled parameter')
  assert.ok(
    ts.isIdentifier(disabledBranch.body) && disabledBranch.body.text === 'config',
    'withBundleAnalyzer disabled branch must return the same config'
  )

  assert.deepEqual(
    bindingMutations(sourceFile, 'require'),
    [],
    'ambient require must remain immutable'
  )
  const unsupportedRequireReferences = []
  sourceFile.forEachChild(function collectRequireReferences(node) {
    if (ts.isIdentifier(node) && node.text === 'require' && node !== requireCall.expression) {
      unsupportedRequireReferences.push(node.getStart(sourceFile))
    }
    ts.forEachChild(node, collectRequireReferences)
  })
  assert.deepEqual(
    unsupportedRequireReferences,
    [],
    'ambient require must not be shadowed, rebound, or referenced outside bundle analyzer loading'
  )

  assert.deepEqual(
    bindingMutations(sourceFile, 'withBundleAnalyzer'),
    [],
    'withBundleAnalyzer must remain immutable'
  )
  const allowedIdentifiers = new Set([declaration.name, exportCallee])
  const unsupportedReferences = []
  sourceFile.forEachChild(function collectReferences(node) {
    if (
      ts.isIdentifier(node) &&
      node.text === 'withBundleAnalyzer' &&
      !allowedIdentifiers.has(node)
    ) {
      unsupportedReferences.push(node.getStart(sourceFile))
    }
    ts.forEachChild(node, collectReferences)
  })
  assert.deepEqual(
    unsupportedReferences,
    [],
    'withBundleAnalyzer must not be shadowed, rebound, or referenced outside its export'
  )
}

function parsedNextConfig(source) {
  const sourceFile = ts.createSourceFile(
    'next.config.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  assert.deepEqual(
    sourceFile.parseDiagnostics.map((diagnostic) => diagnostic.messageText),
    [],
    'next.config.ts must parse without recovery'
  )

  const declarations = []
  sourceFile.forEachChild(function collectDeclarations(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'nextConfig'
    ) {
      declarations.push(node)
    }
    ts.forEachChild(node, collectDeclarations)
  })
  assert.equal(declarations.length, 1, 'next.config.ts must declare exactly one nextConfig')

  const declaration = declarations[0]
  assert.ok(
    ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0,
    'nextConfig must be declared with const'
  )
  assert.ok(
    ts.isVariableStatement(declaration.parent.parent) &&
      ts.isSourceFile(declaration.parent.parent.parent),
    'nextConfig must be a top-level const'
  )
  const initializer = declaration.initializer && unwrapExpression(declaration.initializer)
  assert.ok(initializer && ts.isObjectLiteralExpression(initializer), 'nextConfig must be static')

  const topLevelPropertyNames = new Set()
  for (const property of initializer.properties) {
    assert.equal(
      ts.isSpreadAssignment(property),
      false,
      'nextConfig must not contain top-level spreads'
    )
    const name = staticPropertyName(property.name)
    assert.notEqual(name, undefined, 'nextConfig top-level properties must have static names')
    assert.notEqual(name, 'then', 'nextConfig must not be thenable')
    assert.notEqual(name, '__proto__', 'nextConfig must use the default object prototype')
    assert.notEqual(name, 'pageExtensions', 'nextConfig must retain default page extensions')
    assert.equal(
      topLevelPropertyNames.has(name),
      false,
      `nextConfig must define top-level ${name} exactly once`
    )
    topLevelPropertyNames.add(name)
  }

  const defaultExports = sourceFile.statements.filter(
    (statement) => ts.isExportAssignment(statement) && !statement.isExportEquals
  )
  assert.equal(defaultExports.length, 1, 'next.config.ts must have one default export')
  const defaultExport = defaultExports[0]
  assert.ok(
    declaration.getStart(sourceFile) < defaultExport.getStart(sourceFile),
    'nextConfig must be declared before the default export'
  )
  const exportExpression = defaultExport.expression
  assert.ok(
    ts.isCallExpression(exportExpression),
    'nextConfig must use the approved export wrapper'
  )
  assert.ok(
    ts.isIdentifier(exportExpression.expression) &&
      exportExpression.expression.text === 'withBundleAnalyzer',
    'nextConfig must use withBundleAnalyzer directly'
  )
  assert.equal(exportExpression.arguments.length, 1, 'withBundleAnalyzer must receive one config')
  const exportArgument = exportExpression.arguments[0]
  assert.ok(ts.isAsExpression(exportArgument), 'nextConfig export must retain its NextConfig cast')
  assert.ok(
    ts.isIdentifier(exportArgument.expression) && exportArgument.expression.text === 'nextConfig',
    'withBundleAnalyzer must receive nextConfig'
  )
  assertExactNextConfigType(exportArgument.type, 'nextConfig export')
  assertCanonicalBundleAnalyzerBinding(sourceFile, exportExpression.expression, defaultExport)

  assert.deepEqual(
    bindingMutations(sourceFile, 'nextConfig'),
    [],
    'nextConfig must remain immutable'
  )
  const allowedIdentifiers = new Set([declaration.name, exportArgument.expression])
  const unsupportedReferences = []
  sourceFile.forEachChild(function collectReferences(node) {
    if (ts.isIdentifier(node) && node.text === 'nextConfig' && !allowedIdentifiers.has(node)) {
      unsupportedReferences.push(node.getStart(sourceFile))
    }
    ts.forEachChild(node, collectReferences)
  })
  assert.deepEqual(
    unsupportedReferences,
    [],
    'nextConfig must not escape or be referenced outside its exact export'
  )

  return { initializer, sourceFile }
}

function redirectsArrayFromConfig(source) {
  const { initializer } = parsedNextConfig(source)
  const redirectMembers = []

  for (const property of initializer.properties) {
    const name = staticPropertyName(property.name)
    if (name === 'redirects') {
      redirectMembers.push(property)
    }
  }

  assert.equal(redirectMembers.length, 1, 'nextConfig must define one redirects function')
  const member = redirectMembers[0]
  assert.ok(ts.isMethodDeclaration(member), 'redirects must remain a static method')
  assert.ok(member.body, 'redirects method must have a body')
  assert.equal(member.body.statements.length, 1, 'redirects must directly return one static array')

  const statement = member.body.statements[0]
  assert.ok(
    ts.isReturnStatement(statement) && statement.expression,
    'redirects must return an array'
  )
  const expression = unwrapExpression(statement.expression)
  assert.ok(
    ts.isArrayLiteralExpression(expression),
    'redirects return value must be a static array'
  )
  return expression
}

function assertCanonicalLegacyRedirect(source) {
  const redirects = redirectsArrayFromConfig(source)
  assert.ok(redirects.elements.length > 0, 'redirects must contain the canonical legacy rule')

  for (const [index, element] of redirects.elements.entries()) {
    assert.ok(!ts.isSpreadElement(element), 'redirects array must not contain spread entries')
    const entry = unwrapExpression(element)
    assert.ok(ts.isObjectLiteralExpression(entry), 'redirect entries must be static objects')

    const fields = criticalRedirectFields(entry)
    const entrySource = fields.values.get('source')
    assert.notEqual(entrySource, undefined, 'redirect source must be a static string')
    if (index === 0) {
      assert.equal(entry.properties.length, 3, 'canonical legacy redirect must have three fields')
      assert.equal(fields.containsSpread, false, 'legacy redirect must not inherit spread fields')
      assert.equal(
        fields.containsDynamicProperty,
        false,
        'legacy redirect must not contain dynamic properties'
      )
      for (const property of entry.properties) {
        const name = staticPropertyName(property.name)
        assert.ok(
          ['source', 'destination', 'permanent'].includes(name),
          `canonical legacy redirect contains unsupported field ${name}`
        )
      }
      for (const name of ['source', 'destination', 'permanent']) {
        assert.equal(fields.counts.get(name), 1, `legacy redirect must define ${name} exactly once`)
      }
      assert.equal(entrySource, legacySource, 'canonical legacy redirect must be the first rule')
      assert.equal(
        fields.values.get('destination'),
        canonicalDestination,
        'legacy redirect destination drifted'
      )
      assert.equal(fields.values.get('permanent'), true, 'legacy redirect must remain permanent')
    } else {
      assert.notEqual(entrySource, legacySource, 'legacy source must have exactly one redirect')
    }
  }
}

const canonicalBundleAnalyzerBinding = `const withBundleAnalyzer =
  process.env.ANALYZE === 'true'
    ? require('@next/bundle-analyzer')({ enabled: true })
    : (config: NextConfig) => config`

function configWithRedirectEntries(entries, options = {}) {
  const declaration = options.declaration ?? 'const'
  const mutation = options.mutation ?? ''
  const wrapperBinding = options.wrapperBinding ?? canonicalBundleAnalyzerBinding
  const wrapperMutation = options.wrapperMutation ?? ''
  const exportExpression =
    options.exportExpression ?? 'withBundleAnalyzer(nextConfig as NextConfig)'
  return `${wrapperBinding}\n${wrapperMutation}\n${declaration} nextConfig = { async redirects() { return [${entries}] } }\n${mutation}\nexport default ${exportExpression}`
}

function temporaryFixture(t, prefix) {
  const fixture = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(fixture, { force: true, recursive: true }))
  return fixture
}

function writeFixturePage(routerRoot, directory) {
  const pageDirectory = join(routerRoot, directory)
  mkdirSync(pageDirectory, { recursive: true })
  writeFileSync(join(pageDirectory, 'page.tsx'), 'export default function Page() { return null }\n')
}

function writeFixtureFile(repositoryRoot, path, source) {
  const absolutePath = join(repositoryRoot, path)
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, source)
}

const canonicalEntry = `{ source: '${legacySource}', destination: '${canonicalDestination}', permanent: true }`

test('the owner-gated leaderboard redesign prototype stays a tracked regular source file', () => {
  const absolutePath = join(root, retainedPrototypePath)
  const stats = lstatOrNull(absolutePath)
  assert.ok(stats?.isFile(), `${retainedPrototypePath} must remain a regular file`)
  assert.equal(stats.isSymbolicLink(), false, `${retainedPrototypePath} must not be a symlink`)
  assert.deepEqual(gitIndexEntries([retainedPrototypePath]), [retainedPrototypePath])
  assert.deepEqual(gitIndexStageEntries([retainedPrototypePath]), [
    { mode: '100644', path: retainedPrototypePath, stage: 0 },
  ])
  assert.match(
    readFileSync(absolutePath, 'utf8'),
    /export default function LeaderboardRedesignPreview\s*\(/
  )
})

test('source-only prototype has no production source reference closure', (t) => {
  assert.deepEqual(productionPrototypeReferenceOffenders(), [])

  const fixture = temporaryFixture(t, 'arena-prototype-reference-')
  runGit(['init', '--quiet'], { cwd: fixture })
  writeFixtureFile(
    fixture,
    retainedPrototypePath,
    'export default function LeaderboardRedesignPreview() { return null }\n'
  )
  writeFixtureFile(
    fixture,
    'docs/DESIGN.md',
    '`app/design-system/LeaderboardRedesignPreview.tsx` remains source-only.\n'
  )
  writeFixtureFile(
    fixture,
    'docs/UIUX_OVERHAUL_2026-07.md',
    '`LeaderboardRedesignPreview` is not a production route.\n'
  )
  writeFixtureFile(
    fixture,
    contractPath,
    `const retainedPrototypePath = '${retainedPrototypePath}'\n`
  )
  writeFixtureFile(
    fixture,
    'app/__tests__/preview.test.tsx',
    "import LeaderboardRedesignPreview from '@/app/design-system/LeaderboardRedesignPreview'\n"
  )
  writeFixtureFile(
    fixture,
    'app/test/page.tsx',
    `import LeaderboardRedesignPreview from '@/app/design-system/LeaderboardRedesignPreview'\nexport default function Page() { return <LeaderboardRedesignPreview /> }\n`
  )
  writeFixtureFile(
    fixture,
    'proxy.ts',
    "export const forbiddenPrototype = 'LeaderboardRedesignPreview'\n"
  )
  runGit(['add', '--', '.'], { cwd: fixture })

  assert.deepEqual(productionPrototypeReferenceOffenders(fixture), [
    {
      matches: prototypeReferenceNeedles,
      path: 'app/test/page.tsx',
    },
    {
      matches: ['LeaderboardRedesignPreview'],
      path: 'proxy.ts',
    },
  ])
})

test('retired data-health fragments stay absent from the filesystem, index, and references', () => {
  for (const path of [...retiredFragmentPaths, retiredFragmentDirectory]) {
    assert.equal(lstatOrNull(join(root, path)), null, `${path} must remain physically absent`)
  }
  assert.deepEqual(
    gitIndexEntries([...retiredFragmentPaths, retiredFragmentDirectory]),
    [],
    'retired fragments must remain absent from the Git index'
  )
  assert.deepEqual(trackedReferenceOffenders(), [], 'retired fragment references were restored')
})

test('Git index checks ignore hostile inherited repository and config selectors', (t) => {
  const fixture = temporaryFixture(t, 'arena-route-git-canary-')
  const externalRoot = join(fixture, 'external')
  mkdirSync(externalRoot)
  runGit(['init', '--quiet'], { cwd: externalRoot })
  writeFileSync(join(externalRoot, 'external-only.txt'), 'external canary\n')
  runGit(['add', '--', 'external-only.txt'], { cwd: externalRoot })
  const externalEntriesBefore = runGit(['ls-files', '-z'], { cwd: externalRoot })

  const hostileConfig = join(fixture, 'hostile.gitconfig')
  writeFileSync(hostileConfig, `[core]\n\tworktree = ${externalRoot}\n`)
  const hostileEnvironment = {
    ...process.env,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(externalRoot, '.git', 'objects'),
    GIT_CEILING_DIRECTORIES: fixture,
    GIT_COMMON_DIR: join(externalRoot, '.git'),
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_GLOBAL: hostileConfig,
    GIT_CONFIG_KEY_0: 'core.worktree',
    GIT_CONFIG_KEY_1: 'core.bare',
    GIT_CONFIG_SYSTEM: hostileConfig,
    GIT_CONFIG_VALUE_0: externalRoot,
    GIT_CONFIG_VALUE_1: 'true',
    GIT_DIR: join(externalRoot, '.git'),
    GIT_INDEX_FILE: join(externalRoot, '.git', 'index'),
    GIT_OBJECT_DIRECTORY: join(externalRoot, '.git', 'objects'),
    GIT_WORK_TREE: externalRoot,
  }

  const entries = gitIndexEntries([], hostileEnvironment)
  assert.ok(entries.includes(retainedPrototypePath), 'current worktree index was not read')
  assert.equal(entries.includes('external-only.txt'), false, 'alternate index escaped isolation')
  assert.equal(runGit(['ls-files', '-z'], { cwd: externalRoot }), externalEntriesBefore)
})

test('retired URL paths cannot be restored by another App Router route surface', () => {
  assert.deepEqual(retiredRouteOffenders(), [])
})

test('route mapping detects ordinary groups, slots, and every Next interception marker', (t) => {
  assert.deepEqual(
    ['page.js', 'page.jsx', 'page.ts', 'page.tsx', 'page.mdx', 'page.mjs', 'route.cts'].filter(
      (fileName) => routeEntryPattern.test(fileName)
    ),
    ['page.js', 'page.jsx', 'page.ts', 'page.tsx']
  )

  const fixture = temporaryFixture(t, 'arena-route-markers-')
  const fixtureApp = join(fixture, 'app')
  mkdirSync(fixtureApp)

  for (const directory of [
    '(preview)/design-system',
    '@modal/(.)design-system',
    'admin/monitoring/@modal/(..)data-health',
    'nested/deep/@modal/(...)design-system',
    'one/two/@modal/(..)(..)admin/data-health',
    '(app)/@children/settings',
    '(odd)group)/@children/profile',
    '(.)marker-like-group)/@children/account',
  ]) {
    writeFixturePage(fixtureApp, directory)
  }

  const entries = activeAppRouterEntries(fixtureApp)
  assert.ok(
    entries.some(({ route }) => route === '/settings'),
    'ordinary group/slot was rejected'
  )
  assert.ok(
    entries.some(({ route }) => route === '/profile'),
    'Next group-segment boundary semantics drifted'
  )
  assert.ok(
    entries.some(({ route }) => route === '/account'),
    'marker-like group segment was not handled by Next group semantics'
  )
  assert.deepEqual(
    retiredRouteOffenders(fixtureApp)
      .map(({ retiredRoute }) => retiredRoute)
      .sort(),
    ['/design-system', '/design-system', '/design-system', legacySource, legacySource].sort()
  )
})

test('dynamic and catch-all App Router segments match retired concrete URLs', (t) => {
  const fixture = temporaryFixture(t, 'arena-route-dynamic-')
  const fixtureApp = join(fixture, 'app')
  mkdirSync(fixtureApp)

  for (const directory of [
    '[slug]',
    'admin/[section]',
    '[...path]',
    '[[...path]]',
    'admin/[...path]',
    'admin/[[...path]]',
    'market/[symbol]',
  ]) {
    writeFixturePage(fixtureApp, directory)
  }

  assert.deepEqual(
    retiredRouteOffenders(fixtureApp)
      .map(({ path, retiredRoute }) => `${path} -> ${retiredRoute}`)
      .sort(),
    [
      '[...path]/page.tsx -> /admin/data-health',
      '[...path]/page.tsx -> /design-system',
      '[[...path]]/page.tsx -> /admin/data-health',
      '[[...path]]/page.tsx -> /design-system',
      '[slug]/page.tsx -> /design-system',
      'admin/[...path]/page.tsx -> /admin/data-health',
      'admin/[[...path]]/page.tsx -> /admin/data-health',
      'admin/[section]/page.tsx -> /admin/data-health',
    ].sort()
  )
})

test('unsupported interception marker chains fail closed', (t) => {
  const fixture = temporaryFixture(t, 'arena-route-invalid-markers-')

  for (const [name, directory] of [
    ['three-parent', 'one/two/three/@modal/(..)(..)(..)design-system'],
    ['repeated-same-level', 'admin/@modal/(.)(.)data-health'],
    ['mixed-parent-same', 'admin/@modal/(..)(.)data-health'],
    ['mixed-root-same', '@modal/(...)(.)design-system'],
  ]) {
    const fixtureApp = join(fixture, name, 'app')
    mkdirSync(fixtureApp, { recursive: true })
    writeFixturePage(fixtureApp, directory)
    assert.throws(() => activeAppRouterEntries(fixtureApp), /unsupported interception marker chain/)
  }
})

test('App Router scanning fails closed on directory and broken directory symlinks', (t) => {
  const fixture = temporaryFixture(t, 'arena-route-symlink-')
  const fixtureApp = join(fixture, 'directory', 'app')
  const target = join(fixture, 'linked-route-target')
  mkdirSync(fixtureApp, { recursive: true })
  mkdirSync(target)
  writeFileSync(join(target, 'page.tsx'), 'export default function Page() { return null }\n')
  symlinkSync(target, join(fixtureApp, 'linked-route'), 'dir')

  assert.throws(
    () => activeAppRouterEntries(fixtureApp),
    /directory symlink is not allowed under app\//
  )

  const brokenFixtureApp = join(fixture, 'broken', 'app')
  mkdirSync(brokenFixtureApp, { recursive: true })
  symlinkSync(join(fixture, 'missing-route-target'), join(brokenFixtureApp, 'broken-route'), 'dir')
  assert.throws(
    () => activeAppRouterEntries(brokenFixtureApp),
    /unresolved symlink is not allowed under app\//
  )
})

test('legacy data-health has one exact permanent redirect to its canonical admin tab', () => {
  assertCanonicalLegacyRedirect(readFileSync(join(root, 'next.config.ts'), 'utf8'))
})

test('bundle analyzer binding retains its exact conditional identity semantics', () => {
  const invalidBindings = new Map([
    ['same-name dropper', 'const withBundleAnalyzer = (_config: NextConfig) => undefined'],
    [
      'duplicate dropper binding',
      `${canonicalBundleAnalyzerBinding}\nconst withBundleAnalyzer = (_config: NextConfig) => undefined`,
    ],
    [
      'wrong environment condition',
      canonicalBundleAnalyzerBinding.replace(
        "process.env.ANALYZE === 'true'",
        "process.env.NODE_ENV === 'production'"
      ),
    ],
    [
      'wrong condition operator',
      canonicalBundleAnalyzerBinding.replace("ANALYZE === 'true'", "ANALYZE !== 'false'"),
    ],
    [
      'wrong analyzer package',
      canonicalBundleAnalyzerBinding.replace('@next/bundle-analyzer', '@arena/bundle-analyzer'),
    ],
    [
      'disabled analyzer',
      canonicalBundleAnalyzerBinding.replace('{ enabled: true }', '{ enabled: false }'),
    ],
    [
      'false-branch dropper',
      canonicalBundleAnalyzerBinding.replace(
        '(config: NextConfig) => config',
        '(_config: NextConfig) => ({})'
      ),
    ],
    [
      'ANALYZE-only dropper',
      canonicalBundleAnalyzerBinding.replace(
        "require('@next/bundle-analyzer')({ enabled: true })",
        '(_config: NextConfig) => undefined'
      ),
    ],
    [
      'wrong false-branch type',
      canonicalBundleAnalyzerBinding.replace('config: NextConfig', 'config: unknown'),
    ],
    [
      'async false branch',
      canonicalBundleAnalyzerBinding.replace(
        '(config: NextConfig) => config',
        'async (config: NextConfig) => config'
      ),
    ],
    [
      'optional analyzer factory call',
      canonicalBundleAnalyzerBinding.replace(
        "require('@next/bundle-analyzer')({ enabled: true })",
        "require('@next/bundle-analyzer')?.({ enabled: true })"
      ),
    ],
    [
      'typed analyzer factory call',
      canonicalBundleAnalyzerBinding.replace(
        "require('@next/bundle-analyzer')({ enabled: true })",
        "require('@next/bundle-analyzer')<unknown>({ enabled: true })"
      ),
    ],
    [
      'optional require call',
      canonicalBundleAnalyzerBinding.replace(
        "require('@next/bundle-analyzer')",
        "require?.('@next/bundle-analyzer')"
      ),
    ],
    [
      'typed require call',
      canonicalBundleAnalyzerBinding.replace(
        "require('@next/bundle-analyzer')",
        "require<string>('@next/bundle-analyzer')"
      ),
    ],
  ])

  for (const [name, wrapperBinding] of invalidBindings) {
    assert.throws(
      () =>
        assertCanonicalLegacyRedirect(
          configWithRedirectEntries(canonicalEntry, { wrapperBinding })
        ),
      /withBundleAnalyzer|bundle analyzer/,
      name
    )
  }

  for (const [name, wrapperMutation] of new Map([
    ['reassignment', 'withBundleAnalyzer = (_config: NextConfig) => undefined'],
    ['property assignment', 'withBundleAnalyzer.enabled = false'],
    ['Object mutation', 'Object.assign(withBundleAnalyzer, { enabled: false })'],
    ['Reflect mutation', "Reflect.set(withBundleAnalyzer, 'enabled', false)"],
  ])) {
    assert.throws(
      () =>
        assertCanonicalLegacyRedirect(
          configWithRedirectEntries(canonicalEntry, { wrapperMutation })
        ),
      (error) => {
        assert.match(error.message, /withBundleAnalyzer must remain immutable/, name)
        assert.doesNotMatch(error.message, /must not be shadowed, rebound, or referenced/, name)
        return true
      },
      name
    )
  }

  assert.throws(
    () =>
      assertCanonicalLegacyRedirect(
        configWithRedirectEntries(canonicalEntry, {
          wrapperMutation: 'require = (_id: string) => (_options: unknown) => undefined',
        })
      ),
    (error) => {
      assert.match(error.message, /ambient require must remain immutable/)
      assert.doesNotMatch(error.message, /must not be shadowed, rebound, or referenced/)
      return true
    },
    'ambient require reassignment'
  )

  for (const [name, wrapperMutation] of new Map([
    [
      'shadow binding',
      'function shadow(withBundleAnalyzer: unknown) { return withBundleAnalyzer }',
    ],
    ['extra reference', 'void withBundleAnalyzer'],
  ])) {
    assert.throws(
      () =>
        assertCanonicalLegacyRedirect(
          configWithRedirectEntries(canonicalEntry, { wrapperMutation })
        ),
      /withBundleAnalyzer must not be shadowed, rebound, or referenced outside its export/,
      name
    )
  }

  for (const [name, wrapperMutation] of new Map([
    ['top-level require shadow', 'const require = (_id: string) => () => undefined'],
    ['local require shadow', 'function shadowRequire(require: unknown) { return require }'],
  ])) {
    assert.throws(
      () =>
        assertCanonicalLegacyRedirect(
          configWithRedirectEntries(canonicalEntry, { wrapperMutation })
        ),
      /ambient require must not be shadowed, rebound, or referenced outside bundle analyzer loading/,
      name
    )
  }
})

test('every nextConfig mutator fails through the dedicated immutable contract', () => {
  const mutationFixtures = new Map([
    ['reassignment', `nextConfig = { redirects: async () => [] }`],
    ['property assignment', `nextConfig.redirects = async () => []`],
    ['delete', `delete nextConfig.redirects`],
    ['Object.assign', `Object.assign(nextConfig, { redirects: async () => [] })`],
    [
      'Object.defineProperty',
      `Object.defineProperty(nextConfig, 'redirects', { value: async () => [] })`,
    ],
    [
      'Object.defineProperties',
      `Object.defineProperties(nextConfig, { redirects: { value: async () => [] } })`,
    ],
    ['Object.setPrototypeOf', `Object.setPrototypeOf(nextConfig, null)`],
    ['Object.freeze', `Object.freeze(nextConfig)`],
    ['Object.preventExtensions', `Object.preventExtensions(nextConfig)`],
    ['Object.seal', `Object.seal(nextConfig)`],
    ['Reflect.apply', `Reflect.apply(nextConfig, undefined, [])`],
    ['Reflect.construct', `Reflect.construct(nextConfig, [])`],
    [
      'Reflect.defineProperty',
      `Reflect.defineProperty(nextConfig, 'redirects', { value: async () => [] })`,
    ],
    ['Reflect.deleteProperty', `Reflect.deleteProperty(nextConfig, 'redirects')`],
    ['Reflect.get', `Reflect.get(nextConfig, 'redirects')`],
    [
      'Reflect.getOwnPropertyDescriptor',
      `Reflect.getOwnPropertyDescriptor(nextConfig, 'redirects')`,
    ],
    ['Reflect.getPrototypeOf', `Reflect.getPrototypeOf(nextConfig)`],
    ['Reflect.has', `Reflect.has(nextConfig, 'redirects')`],
    ['Reflect.isExtensible', `Reflect.isExtensible(nextConfig)`],
    ['Reflect.ownKeys', `Reflect.ownKeys(nextConfig)`],
    ['Reflect.preventExtensions', `Reflect.preventExtensions(nextConfig)`],
    ['Reflect.set', `Reflect.set(nextConfig, 'redirects', async () => [])`],
    ['Reflect.setPrototypeOf', `Reflect.setPrototypeOf(nextConfig, null)`],
    ['Reflect dynamic method', `Reflect[reflectMethod](nextConfig)`],
  ])

  for (const [name, mutation] of mutationFixtures) {
    assert.throws(
      () => assertCanonicalLegacyRedirect(configWithRedirectEntries(canonicalEntry, { mutation })),
      (error) => {
        assert.match(error.message, /nextConfig must remain immutable/, name)
        assert.doesNotMatch(error.message, /must not escape or be referenced/, name)
        return true
      },
      name
    )
  }
})

test('redirect contract rejects dynamic, spread, duplicate, and behavior-drift variants', () => {
  const invalidConfigs = [
    configWithRedirectEntries(`...legacyRedirects`),
    configWithRedirectEntries(`makeRedirect()`),
    configWithRedirectEntries(
      `{ source: legacySource, destination: '${canonicalDestination}', permanent: true }`
    ),
    configWithRedirectEntries(
      `{ ...legacyRedirect, source: '${legacySource}', destination: '${canonicalDestination}', permanent: true }`
    ),
    configWithRedirectEntries(`${canonicalEntry}, ${canonicalEntry}`),
    configWithRedirectEntries(
      `{ source: '${legacySource}', destination: '/admin', permanent: true }`
    ),
    configWithRedirectEntries(
      `{ source: '${legacySource}', destination: '${canonicalDestination}', permanent: false }`
    ),
    configWithRedirectEntries(
      `{ source: '${legacySource}', destination: '${canonicalDestination}', permanent: true, has: [] }`
    ),
    configWithRedirectEntries(
      `{ source: '/admin/:path*', destination: '/admin', permanent: false }, ${canonicalEntry}`
    ),
    configWithRedirectEntries(canonicalEntry).replace(
      'nextConfig = {',
      "nextConfig = { pageExtensions: ['js', 'jsx', 'ts', 'tsx', 'mdx'],"
    ),
    configWithRedirectEntries(canonicalEntry).replace(
      'nextConfig = {',
      'nextConfig = { ...runtimeConfig,'
    ),
    configWithRedirectEntries(canonicalEntry).replace(
      'nextConfig = {',
      'nextConfig = { [runtimeKey]: true,'
    ),
    configWithRedirectEntries(canonicalEntry).replace(
      'nextConfig = {',
      `nextConfig = { then(resolve) { resolve({ pageExtensions: ['js', 'jsx', 'ts', 'tsx', 'mdx'], async redirects() { return [${canonicalEntry}] } }) },`
    ),
    configWithRedirectEntries(canonicalEntry).replace(
      'nextConfig = {',
      `nextConfig = { __proto__: { then(resolve) { resolve({ pageExtensions: ['js', 'jsx', 'ts', 'tsx', 'mdx'] }) } },`
    ),
    configWithRedirectEntries(canonicalEntry, { declaration: 'let' }),
    configWithRedirectEntries(canonicalEntry, { declaration: 'var' }),
    `${configWithRedirectEntries(canonicalEntry)}\nconst nextConfig = {}`,
    configWithRedirectEntries(canonicalEntry, {
      exportExpression: 'evilWrapper(nextConfig as NextConfig)',
    }),
    configWithRedirectEntries(canonicalEntry, {
      exportExpression: 'withBundleAnalyzer(nextConfig as unknown)',
    }),
    configWithRedirectEntries(canonicalEntry, {
      exportExpression: 'nextConfig',
    }),
    `${canonicalBundleAnalyzerBinding}\nconst nextConfig = { async redirects() { return [${canonicalEntry}] }, ...runtimeConfig }; export default withBundleAnalyzer(nextConfig as NextConfig)`,
    `${canonicalBundleAnalyzerBinding}\nexport default withBundleAnalyzer(nextConfig as NextConfig)\nconst nextConfig = { async redirects() { return [${canonicalEntry}] } }`,
    `const nextConfig = { async redirects() { return [${canonicalEntry}] } }\nexport default withBundleAnalyzer(nextConfig as NextConfig)\n${canonicalBundleAnalyzerBinding}`,
  ]

  for (const source of invalidConfigs) {
    assert.throws(() => assertCanonicalLegacyRedirect(source))
  }

  assert.doesNotThrow(() =>
    assertCanonicalLegacyRedirect(
      configWithRedirectEntries(
        `${canonicalEntry}, { ...unrelatedRedirect, source: '/elsewhere' }, { source: '/other', destination: computeDestination(), permanent: false }`
      )
    )
  )
})
