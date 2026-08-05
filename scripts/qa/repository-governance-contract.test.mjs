import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
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

test('runbook does not restore retired or fictional recovery controls', () => {
  const runbook = read('docs/RUNBOOK.md')
  assert.doesNotMatch(runbook, /scripts\/pipeline-report\.ts/)
  assert.doesNotMatch(runbook, /FEATURE_READ_ONLY/)
  assert.doesNotMatch(runbook, /Redis is non-critical|all Redis consumers fail-open/i)
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
  assert.deepEqual(workflow.jobs['lint-typecheck'].needs, [
    'pre-checks',
    'worker-package',
    'mobile-release-tooling-audit',
  ])
  for (const step of workerJob.steps) {
    assert.equal(step['continue-on-error'], undefined)
    if (step.run) assert.doesNotMatch(step.run, /\|\|\s*true/)
  }
})

test('the required lint context propagates every prerequisite gate outcome', () => {
  const workflow = parse(read('.github/workflows/ci.yml'))
  const lintJob = workflow.jobs['lint-typecheck']
  const propagation = lintJob.steps[0]

  assert.equal(lintJob.if, '${{ always() }}')
  assert.equal(lintJob['continue-on-error'], undefined)
  assert.equal(propagation.name, 'Enforce prerequisite gate results')
  assert.equal(propagation.if, undefined)
  assert.equal(propagation['continue-on-error'], undefined)
  assert.deepEqual(propagation.env, {
    PRE_CHECKS_RESULT: '${{ needs.pre-checks.result }}',
    WORKER_PACKAGE_RESULT: '${{ needs.worker-package.result }}',
    MOBILE_RELEASE_TOOLING_AUDIT_RESULT: '${{ needs.mobile-release-tooling-audit.result }}',
  })
  assert.match(propagation.run, /set -euo pipefail/)
  for (const result of [
    'PRE_CHECKS_RESULT',
    'WORKER_PACKAGE_RESULT',
    'MOBILE_RELEASE_TOOLING_AUDIT_RESULT',
  ]) {
    assert.match(propagation.run, new RegExp(`\\"\\$${result}\\" = success`))
  }
  assert.match(propagation.run, /exit 1/)
  assert.doesNotMatch(propagation.run, /\|\|\s*true/)

  const runPropagation = (results) =>
    spawnSync('bash', ['-c', propagation.run], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...results },
    })
  assert.equal(
    runPropagation({
      PRE_CHECKS_RESULT: 'success',
      WORKER_PACKAGE_RESULT: 'success',
      MOBILE_RELEASE_TOOLING_AUDIT_RESULT: 'success',
    }).status,
    0
  )
  for (const results of [
    {
      PRE_CHECKS_RESULT: 'failure',
      WORKER_PACKAGE_RESULT: 'success',
      MOBILE_RELEASE_TOOLING_AUDIT_RESULT: 'success',
    },
    {
      PRE_CHECKS_RESULT: 'success',
      WORKER_PACKAGE_RESULT: 'skipped',
      MOBILE_RELEASE_TOOLING_AUDIT_RESULT: 'success',
    },
    {
      PRE_CHECKS_RESULT: 'success',
      WORKER_PACKAGE_RESULT: 'success',
      MOBILE_RELEASE_TOOLING_AUDIT_RESULT: 'cancelled',
    },
  ]) {
    assert.equal(runPropagation(results).status, 1)
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
