import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { builtinModules, createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

const require = createRequire(import.meta.url)
const ts = require('typescript')
const root = resolve(import.meta.dirname, '../..')
const workerRoot = join(root, 'worker')
const manifestPath = join(workerRoot, 'package.json')
const lockfilePath = join(workerRoot, 'package-lock.json')
const tsconfigPath = join(workerRoot, 'tsconfig.json')

const entries = [
  'worker/src/ingest-worker.ts',
  'worker/preflight-local-release.ts',
  'worker/preflight-sg-runtime.ts',
  'worker/verify-local-heartbeat.ts',
  'worker/verify-sg-heartbeat.ts',
]
const extensions = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json']
const runtimeInfrastructure = ['next', 'react', 'react-dom', 'tsx', 'webpack']

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function resolveLocalImport(from, specifier) {
  let base
  if (specifier.startsWith('@/')) base = join(root, specifier.slice(2))
  else if (specifier.startsWith('.')) base = resolve(dirname(from), specifier)
  else return null

  for (const extension of extensions) {
    const candidate = base + extension
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  for (const extension of extensions.slice(1)) {
    const candidate = join(base, `index${extension}`)
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return undefined
}

function externalPackage(specifier) {
  if (specifier.startsWith('node:') || builtinModules.includes(specifier)) return null
  return specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]
}

function importDeclarationHasRuntimeValue(node) {
  const clause = node.importClause
  if (!clause) return true
  if (clause.isTypeOnly) return false
  if (clause.name) return true
  if (!clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return true
  return clause.namedBindings.elements.some((element) => !element.isTypeOnly)
}

function exportDeclarationHasRuntimeValue(node) {
  if (node.isTypeOnly) return false
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return true
  return node.exportClause.elements.some((element) => !element.isTypeOnly)
}

function staticString(expression, bindings = new Map()) {
  if (ts.isStringLiteralLike(expression)) return expression.text
  if (ts.isIdentifier(expression)) return bindings.get(expression.text)
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticString(expression.left, bindings)
    const right = staticString(expression.right, bindings)
    if (left !== undefined && right !== undefined) return left + right
  }
  return undefined
}

function runtimeDependencyGraph() {
  const queue = entries.map((entry) => join(root, entry))
  const visited = new Set()
  const packages = new Set()
  const outsideWorker = new Set()
  const unresolved = []
  const expressionImports = []

  while (queue.length > 0) {
    const file = queue.pop()
    if (visited.has(file)) continue
    visited.add(file)

    const sourceFile = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    const staticBindings = new Map()
    sourceFile.forEachChild(function collectStaticBindings(node) {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const value = staticString(node.initializer, staticBindings)
        if (value !== undefined) staticBindings.set(node.name.text, value)
      }
      ts.forEachChild(node, collectStaticBindings)
    })
    const addSpecifier = (specifier) => {
      const resolved = resolveLocalImport(file, specifier)
      if (resolved === undefined) {
        unresolved.push(`${relative(root, file)} -> ${specifier}`)
      } else if (resolved) {
        if (!resolved.startsWith(`${workerRoot}/`)) outsideWorker.add(relative(root, resolved))
        queue.push(resolved)
      } else {
        const dependency = externalPackage(specifier)
        if (dependency) packages.add(dependency)
      }
    }

    sourceFile.forEachChild(function visit(node) {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        importDeclarationHasRuntimeValue(node)
      ) {
        addSpecifier(node.moduleSpecifier.text)
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        exportDeclarationHasRuntimeValue(node)
      ) {
        addSpecifier(node.moduleSpecifier.text)
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        const specifier =
          node.arguments.length === 1 ? staticString(node.arguments[0], staticBindings) : undefined
        if (specifier !== undefined) {
          addSpecifier(specifier)
        } else {
          expressionImports.push(relative(root, file))
        }
      }
      ts.forEachChild(node, visit)
    })
  }

  return { expressionImports, outsideWorker, packages, unresolved, visited }
}

test('Worker manifest owns the exact reachable production dependency closure', () => {
  const manifest = readJson(manifestPath)
  const graph = runtimeDependencyGraph()
  const expected = [...new Set([...graph.packages, ...runtimeInfrastructure])].sort()

  assert.equal(manifest.name, '@ranking-arena/ingest-worker')
  assert.equal(manifest.private, true)
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), expected)
  assert.deepEqual(Object.keys(manifest.devDependencies).sort(), [
    '@types/jest',
    '@types/node',
    '@types/pg',
    'typescript',
    'yaml',
  ])
  assert.deepEqual(
    graph.unresolved,
    [],
    `unresolved local imports:\n${graph.unresolved.join('\n')}`
  )
  assert.deepEqual(
    graph.expressionImports,
    [],
    `non-literal runtime imports bypass the manifest contract:\n${graph.expressionImports.join('\n')}`
  )
  assert.ok(
    graph.visited.size > 150,
    'dependency graph unexpectedly stopped traversing shared code'
  )
  assert.ok(graph.outsideWorker.size > 100, 'shared source boundary unexpectedly disappeared')
  for (const path of graph.outsideWorker) {
    assert.match(path, /^lib\//, `Worker reached source outside worker/** or lib/**: ${path}`)
  }
})

test('Worker lockfile is self-contained and mechanically matches its manifest', () => {
  const manifest = readJson(manifestPath)
  const lockfile = readJson(lockfilePath)
  const lockRoot = lockfile.packages?.['']

  assert.equal(lockfile.lockfileVersion, 3)
  assert.equal(lockfile.name, manifest.name)
  assert.equal(lockfile.version, manifest.version)
  assert.equal(lockRoot?.name, manifest.name)
  assert.equal(lockRoot?.version, manifest.version)
  assert.deepEqual(lockRoot?.dependencies, manifest.dependencies)
  assert.deepEqual(lockRoot?.devDependencies, manifest.devDependencies)
  assert.deepEqual(lockRoot?.engines, manifest.engines)
  assert.ok(Object.keys(lockfile.packages).some((path) => path.startsWith('node_modules/')))

  const rootManifest = readJson(join(root, 'package.json'))
  const rootLockfile = readJson(join(root, 'package-lock.json'))
  assert.equal(rootManifest.workspaces, undefined)
  assert.equal(rootLockfile.packages?.worker, undefined)
})

test('Worker lock has independent Dependabot governance without release identity coupling', () => {
  const dependabot = parse(readFileSync(join(root, '.github/dependabot.yml'), 'utf8'))
  const npmUpdates = dependabot.updates.filter((update) => update['package-ecosystem'] === 'npm')
  const rootPolicy = npmUpdates.find((update) => update.directory === '/')
  const workerPolicies = npmUpdates.filter((update) => update.directory === '/worker')

  assert.ok(rootPolicy, 'root npm Dependabot policy is missing')
  assert.equal(workerPolicies.length, 1, 'Worker must have one independent npm update policy')
  const workerPolicy = workerPolicies[0]
  for (const field of [
    'schedule',
    'open-pull-requests-limit',
    'commit-message',
    'labels',
    'ignore',
    'groups',
  ]) {
    assert.deepEqual(workerPolicy[field], rootPolicy[field], `Worker Dependabot ${field} drifted`)
  }
  for (const policy of [rootPolicy, workerPolicy]) {
    const securityGroup = policy.groups?.['security-updates']
    assert.equal(securityGroup?.['applies-to'], 'security-updates')
    assert.deepEqual(securityGroup?.patterns, ['*'])
    assert.equal(securityGroup?.['update-types'], undefined)
  }

  const releaseHelper = readFileSync(join(root, 'scripts/ci/worker-release-id.mjs'), 'utf8')
  assert.doesNotMatch(releaseHelper, /\.github\/dependabot\.yml/)
})

test('Worker TypeScript config owns alias resolution without extending the app config', () => {
  const config = readJson(tsconfigPath)
  const rootManifest = readJson(join(root, 'package.json'))

  assert.equal(config.extends, undefined)
  assert.equal(config.compilerOptions.baseUrl, '..')
  assert.deepEqual(config.compilerOptions.paths, { '@/*': ['./*'] })
  assert.deepEqual(config.compilerOptions.plugins, undefined)
  assert.equal(
    rootManifest.scripts['type-check:ingest-worker'],
    'tsc -p worker/tsconfig.json --noEmit'
  )
  assert.equal(existsSync(join(root, 'tsconfig.ingest-worker.json')), false)
  assert.equal(readFileSync(join(workerRoot, '.npmrc'), 'utf8'), 'legacy-peer-deps=true\n')
})

test('build and deploy paths consume only Worker-owned install inputs', () => {
  const dockerfile = readFileSync(join(workerRoot, 'Dockerfile.ingest'), 'utf8')
  const sgDeploy = readFileSync(join(workerRoot, 'deploy-ingest-sg.sh'), 'utf8')
  const localDeploy = readFileSync(join(workerRoot, 'deploy-ingest-local.sh'), 'utf8')
  const sgWorkflow = readFileSync(join(root, '.github/workflows/deploy-ingest-sg.yml'), 'utf8')

  assert.match(
    dockerfile,
    /COPY worker\/package\.json worker\/package-lock\.json worker\/\.npmrc \.\//
  )
  assert.match(dockerfile, /RUN npm ci --omit=dev/)
  assert.match(dockerfile, /npm ls --omit=dev --all/)
  assert.doesNotMatch(dockerfile, /COPY package\.json package-lock\.json/)
  assert.match(sgWorkflow, /npm ci --prefix worker --omit=dev/)
  assert.match(sgWorkflow, /npm ls --prefix worker --omit=dev --all/)
  assert.match(localDeploy, /"\$NPM_CLI" ci --prefix worker --omit=dev/)
  assert.match(localDeploy, /"\$NPM_CLI" ls --prefix worker --omit=dev --all/)

  for (const source of [sgDeploy, sgWorkflow]) {
    assert.match(source, /worker\/\.npmrc worker\/package\.json worker\/package-lock\.json/)
  }
  assert.match(sgDeploy, /CODE_PATHS=\(lib worker\)/)
  assert.doesNotMatch(sgDeploy, /for (?:file|f) in \.npmrc package\.json package-lock\.json/)
})
