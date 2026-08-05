import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function readTextTree(directory, extensions, requireAllFiles = false) {
  const files = []

  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const entryPath = join(path, entry.name)
      if (entry.isDirectory()) visit(entryPath)
      else if (entry.isSymbolicLink()) {
        assert.fail(`policy source must not be a symbolic link: ${entryPath}`)
      } else if (entry.isFile()) {
        if (extensions.has(extname(entry.name))) files.push(readFileSync(entryPath, 'utf8'))
        else if (requireAllFiles) assert.fail(`unscanned policy source: ${entryPath}`)
      }
    }
  }

  visit(resolve(root, directory))
  return files
}

function assertTracked(path) {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', path], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || `${path} must be tracked`)
  assert.equal(result.stdout.trim(), path)
}

test('documentation index contains only resolvable local links', () => {
  const indexPath = resolve(root, 'docs/README.md')
  const markdown = readFileSync(indexPath, 'utf8')
  const links = [
    ...markdown.matchAll(/\[[^\]]+\]\((?!https?:|mailto:|#)([^)#?]+)(?:#[^)]+)?\)/g),
  ].map((match) => match[1].replace(/^<|>$/g, ''))

  assert.ok(links.length > 0, 'docs/README.md must index local documentation')
  for (const link of links) {
    assert.ok(
      existsSync(resolve(dirname(indexPath), decodeURIComponent(link))),
      `missing docs index target: ${link}`
    )
  }
})

test('concrete CODEOWNERS paths exist', () => {
  const entries = read('.github/CODEOWNERS')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/)[0])
    .filter((pattern) => pattern.startsWith('/') && !/[?*[]/.test(pattern))

  for (const entry of entries) {
    assert.ok(existsSync(resolve(root, `.${entry}`)), `stale concrete CODEOWNERS path: ${entry}`)
  }
})

test('tracked Claude conductor config is explicitly admitted by gitignore', () => {
  const conductorPath = '.claude/conductor.json'
  const rules = read('.gitignore').split('\n')
  const blanketRule = '/.claude/*'
  const admissionRule = '!/.claude/conductor.json'

  assert.equal(rules.filter((rule) => rule === admissionRule).length, 1)
  assert.ok(
    rules.lastIndexOf(admissionRule) > rules.lastIndexOf(blanketRule),
    `${admissionRule} must follow ${blanketRule}`
  )
  assertTracked(conductorPath)

  const ignored = spawnSync('git', ['check-ignore', '--quiet', '--no-index', '--', conductorPath], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(ignored.status, 1, ignored.stderr || `${conductorPath} must not be ignored`)
})

test('architecture separates tracked topology config from runtime source inventory', () => {
  const architecture = read('docs/ARCHITECTURE.md')
  const authorities = ['lib/ingest/adapters/register.ts', 'vercel.json']

  assert.doesNotMatch(architecture, /\bmemory\//i)
  assert.match(architecture, /实际启用的 source 清单以运行时\s*>\s*`arena\.sources` registry 为准/)
  assert.match(architecture, /本文不固化这些会随配置变化的数量/)
  assert.doesNotMatch(architecture, /\b\d+\s+(?:sources|Vercel Crons)\b/)
  for (const authority of authorities) {
    assert.equal(
      architecture.includes(`\`${authority}\``),
      true,
      `architecture must cite tracked authority: ${authority}`
    )
    assert.ok(existsSync(resolve(root, authority)), `missing architecture authority: ${authority}`)
    assertTracked(authority)
  }
})

test('security review points at the deployed Stripe webhook', () => {
  const reviewer = read('.claude/agents/security-reviewer.md')
  const webhookDirectory = 'app/api/stripe/webhook/'
  const webhookRoute = `${webhookDirectory}route.ts`

  assert.match(reviewer, /`app\/api\/stripe\/webhook\/`/)
  assert.doesNotMatch(reviewer, /app\/api\/webhooks\/stripe/)
  assert.ok(statSync(resolve(root, webhookDirectory)).isDirectory())
  assert.ok(statSync(resolve(root, webhookRoute)).isFile())
  assertTracked(webhookRoute)
})

test('runbook does not restore retired or fictional recovery controls', () => {
  const runbook = read('docs/RUNBOOK.md')
  assert.doesNotMatch(runbook, /scripts\/pipeline-report\.ts/)
  assert.doesNotMatch(runbook, /FEATURE_READ_ONLY/)
  assert.doesNotMatch(runbook, /Redis is non-critical|all Redis consumers fail-open/i)
})

test('keeps the Cloudflare compatibility artifact outside the active control plane', () => {
  const packageJson = JSON.parse(read('cloudflare-worker/package.json'))
  const artifactReadme = read('cloudflare-worker/README.md')
  const skillRouter = read('.claude/ARENA_SKILL_SYSTEM.md')
  const guidanceExtensions = new Set(['.json', '.md', '.sh', '.yaml', '.yml'])
  const runtimeExtensions = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])
  const activeGuidance = [
    read('README.md'),
    read('CLAUDE.md'),
    read('docs/REPOSITORY_STRUCTURE.md'),
    read('docs/RUNBOOK.md'),
    read('docs/SCRAPER.md'),
    ...readTextTree('.claude', guidanceExtensions, true),
  ].join('\n')
  const runtimeSources = ['app', 'lib', 'worker']
    .flatMap((directory) => readTextTree(directory, runtimeExtensions))
    .join('\n')

  assert.deepEqual(Object.keys(packageJson.scripts).sort(), ['dev'])
  assert.equal(packageJson.scripts.dev, 'wrangler dev --local --ip 127.0.0.1')
  assert.equal(existsSync(resolve(root, '.claude/skills/arena-cf-worker-patterns')), false)
  assert.doesNotMatch(skillRouter, /arena-cf-worker-patterns/)
  assert.doesNotMatch(activeGuidance, /workers\.dev|CLOUDFLARE_API_TOKEN|ranking-arena-proxy/i)
  assert.doesNotMatch(activeGuidance, /\b(?:npx\s+)?wrangler\s+[a-z][\w-]*/i)
  assert.doesNotMatch(
    runtimeSources,
    /cloudflare-worker|workers\.dev|ranking-arena-proxy|\b(?:CLOUDFLARE|CF)_(?:(?:WORKER|PROXY)(?:_(?:URL|ENDPOINT|HOST))?|URL)\b/i
  )
  assert.match(artifactReadme, /Status:\*\* Quarantined/)
  assert.match(artifactReadme, /external-traffic audit/)
  assert.match(artifactReadme, /Historical audit locator only \(current state unverified\)/)
  assert.match(artifactReadme, /ranking-arena-proxy\.broosbook\.workers\.dev/)
  for (const artifact of [
    'cloudflare-worker/package-lock.json',
    'cloudflare-worker/src/index.ts',
    'cloudflare-worker/wrangler.toml',
  ]) {
    assert.equal(existsSync(resolve(root, artifact)), true, `${artifact} remains audit evidence`)
  }
})

test('source policies scan the owned repository boundary in clean CI checkouts', () => {
  const packageJson = JSON.parse(read('package.json'))
  const workflow = read('.github/workflows/ci.yml')
  const policy = read('scripts/qa/source-policy-check.mjs')

  assert.equal(packageJson.scripts.lint, 'eslint .')
  assert.equal(packageJson.scripts['qa:source-policy'], 'node scripts/qa/source-policy-check.mjs')
  assert.match(workflow, /run: npm run qa:source-policy/)
  assert.match(policy, /git\(\['ls-files', '-co', '--exclude-standard'/)
  assert.doesNotMatch(policy, /git\(\['diff'/)
})

test('CI audits the independent Worker production lock without rewriting or swallowing failures', () => {
  const workflow = parse(read('.github/workflows/ci.yml'))
  const workerJob = workflow.jobs['worker-package']
  const stepsByName = new Map(
    workerJob.steps.filter((step) => step.name).map((step) => [step.name, step])
  )
  const checkout = workerJob.steps.find(
    (step) => step.uses === 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262'
  )
  const setupNode = workerJob.steps.find(
    (step) => step.uses === 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38'
  )
  const productionInstall = stepsByName.get('Install the independent Worker production closure')
  const audit = stepsByName.get('Audit the Worker production closure')
  const productionLayout = stepsByName.get(
    'Verify the production tree and mirror the release layout'
  )
  const imports = stepsByName.get('Load every declared Worker dependency')
  const alias = stepsByName.get('Prove Worker tsx alias and shared-source resolution')
  const returnProduction = stepsByName.get('Return the production tree to the Worker prefix')
  const developmentInstall = stepsByName.get('Install the independent Worker development closure')
  const developmentLayout = stepsByName.get(
    'Verify the development tree and mirror the release layout'
  )
  const typecheck = stepsByName.get('Type-check from the independent Worker tree')
  const boundary = stepsByName.get('Worker package boundary contract')

  assert.equal(workerJob['runs-on'], 'ubuntu-latest')
  assert.equal(checkout?.with?.['persist-credentials'], false)
  assert.equal(setupNode?.with?.['node-version'], '22')
  assert.equal(setupNode?.with?.cache, 'npm')
  assert.equal(setupNode?.with?.['cache-dependency-path'], 'worker/package-lock.json')
  assert.equal(
    productionInstall?.run,
    'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefix worker --omit=dev'
  )
  assert.equal(audit?.run, 'npm audit --prefix worker --omit=dev --audit-level=high')
  assert.match(productionLayout?.run ?? '', /npm ls --prefix worker --omit=dev --all/)
  assert.match(productionLayout?.run ?? '', /test ! -e node_modules/)
  assert.match(productionLayout?.run ?? '', /mv worker\/node_modules node_modules/)
  assert.ok(
    productionLayout.run.indexOf('test ! -e node_modules') <
      productionLayout.run.indexOf('mv worker/node_modules node_modules')
  )
  assert.match(imports?.run ?? '', /Object\.keys\(manifest\.dependencies\)/)
  assert.match(alias?.run ?? '', /TSX_TSCONFIG_PATH="\$PWD\/worker\/tsconfig\.json"/)
  assert.match(alias?.run ?? '', /import\('@\/lib\/ingest\/core\/regions'\)/)
  assert.match(returnProduction?.run ?? '', /mv node_modules worker\/node_modules/)
  assert.equal(developmentInstall?.run, 'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefix worker')
  assert.match(developmentLayout?.run ?? '', /npm ls --prefix worker --all/)
  assert.match(developmentLayout?.run ?? '', /test ! -e node_modules/)
  assert.match(developmentLayout?.run ?? '', /mv worker\/node_modules node_modules/)
  assert.equal(
    typecheck?.run,
    'node node_modules/typescript/bin/tsc -p worker/tsconfig.json --noEmit'
  )
  assert.equal(boundary?.run, 'node --test scripts/qa/worker-package-boundary.test.mjs')
  assert.ok(
    workerJob.steps.indexOf(productionInstall) < workerJob.steps.indexOf(productionLayout) &&
      workerJob.steps.indexOf(productionLayout) < workerJob.steps.indexOf(imports) &&
      workerJob.steps.indexOf(alias) < workerJob.steps.indexOf(returnProduction) &&
      workerJob.steps.indexOf(returnProduction) < workerJob.steps.indexOf(developmentInstall) &&
      workerJob.steps.indexOf(developmentInstall) < workerJob.steps.indexOf(developmentLayout) &&
      workerJob.steps.indexOf(developmentLayout) < workerJob.steps.indexOf(typecheck)
  )
  assert.deepEqual(workflow.jobs['lint-typecheck'].needs, ['pre-checks', 'worker-package'])
  for (const step of workerJob.steps) {
    assert.equal(step['continue-on-error'], undefined)
    if (step.run) assert.doesNotMatch(step.run, /\|\|\s*true/)
  }
})

test('session worktrees isolate credentials, dependencies, and destructive cleanup', () => {
  const scriptPath = resolve(root, 'scripts/new-session-worktree.sh')
  const script = read('scripts/new-session-worktree.sh')

  assert.notEqual(
    statSync(scriptPath).mode & 0o111,
    0,
    'session worktree helper must be executable'
  )
  assert.match(script, /validate_name/)
  assert.match(script, /git worktree remove "\$WT_BASE\/\$NAME"/)
  assert.match(script, /git branch -d "session\/\$NAME"/)
  assert.match(script, /gh pr create --base main --head \$BRANCH/)
  assert.match(script, /nvm use && npm ci/)
  assert.doesNotMatch(script, /ln -s/)
  assert.doesNotMatch(script, /git worktree remove[^\n]*--force/)
  assert.doesNotMatch(script, /git branch -D/)
})
