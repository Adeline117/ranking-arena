import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { parseDocument } from 'yaml'

const root = path.resolve(import.meta.dirname, '../..')
const ciWorkflowPath = path.join(root, '.github/workflows/ci.yml')
const workflowPath = path.join(root, '.github/workflows/mobile-build.yml')
const dependabotPath = path.join(root, '.github/dependabot.yml')
const codeownersPath = path.join(root, '.github/CODEOWNERS')
const repositoryStructurePath = path.join(root, 'docs/REPOSITORY_STRUCTURE.md')
const gitignorePath = path.join(root, '.gitignore')
const vercelIgnorePath = path.join(root, '.vercelignore')
const dockerIgnorePath = path.join(root, '.dockerignore')
const rootPackagePath = path.join(root, 'package.json')
const rootPackageLockPath = path.join(root, 'package-lock.json')
const releaseToolingPath = path.join(root, 'tooling/mobile-release')
const releaseToolingPackagePath = path.join(releaseToolingPath, 'package.json')
const releaseToolingLockPath = path.join(releaseToolingPath, 'package-lock.json')
const pinnedAction = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/
const firebaseToolsVersion = '15.25.1'
const firebaseToolsIntegrity =
  'sha512-TcKCgmlHducC3XrzS+FPgGXe2DlDl1Fh2GSN2Vkh71eGGvP7jE/JuEOFcE3osI0TBb1Os6MNTSsGL8mjdZ1IKA=='

function readStrictYaml(filePath, description) {
  const metadata = fs.lstatSync(filePath)
  assert.equal(metadata.isSymbolicLink(), false, `${description} must not be a symlink`)
  assert.equal(metadata.isFile(), true, `${description} must be a regular file`)

  const source = fs.readFileSync(filePath, 'utf8')
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
    `${description} must be strict YAML:\n${diagnostics.map(String).join('\n')}`
  )

  return { source, value: document.toJS({ maxAliasCount: 100 }) }
}

function readWorkflow() {
  const { source, value } = readStrictYaml(workflowPath, 'mobile workflow')
  return { source, workflow: value }
}

function namedStep(job, name) {
  const matches = job.steps.filter((step) => step.name === name)
  assert.equal(matches.length, 1, `${name} must be defined exactly once`)
  return matches[0]
}

function assertSecretFileStep(job, name, secretName, temporaryFile) {
  const step = namedStep(job, name)
  assert.equal(
    step.env?.[secretName],
    '${{ secrets.' + secretName + ' }}',
    `${name} must receive ${secretName} through step env`
  )
  assert.match(step.run, /(^|\n)umask 077(?:\n|$)/, `${name} must create private files`)
  assert.ok(
    step.run.includes(`$RUNNER_TEMP/${temporaryFile}`),
    `${name} must stage credentials under RUNNER_TEMP`
  )
  assert.ok(
    step.run.includes(`printf '%s' "$${secretName}"`),
    `${name} must write the environment value with printf`
  )
}

test('mobile workflow scopes token permissions and checkout credentials', () => {
  const { workflow } = readWorkflow()
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.equal(workflow.jobs['build-android'].permissions, undefined)
  assert.equal(workflow.jobs['build-ios'].permissions, undefined)
  assert.deepEqual(workflow.jobs['create-release'].permissions, { contents: 'write' })

  const allSteps = Object.values(workflow.jobs).flatMap((job) => job.steps)
  const checkoutSteps = allSteps.filter((step) => step.uses?.startsWith('actions/checkout@'))
  assert.equal(checkoutSteps.length, 2, 'both mobile build jobs must checkout source')
  for (const step of checkoutSteps) {
    assert.equal(step.with?.['persist-credentials'], false)
  }

  const actionSteps = allSteps.filter((step) => step.uses)
  assert.ok(actionSteps.length > 0, 'mobile workflow must use at least one action')
  for (const step of actionSteps) {
    assert.match(step.uses, pinnedAction, `${step.name} must pin its action to a full commit SHA`)
  }
})

test('mobile workflow stages and cleans credential files without shell secret interpolation', () => {
  const { workflow } = readWorkflow()
  const android = workflow.jobs['build-android']
  const ios = workflow.jobs['build-ios']

  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps) {
      if (typeof step.run !== 'string') continue
      assert.doesNotMatch(
        step.run,
        /\$\{\{\s*secrets\./,
        `${jobName}/${step.name} must not interpolate secrets into a shell program`
      )
    }
  }

  assertSecretFileStep(
    android,
    'Create google-services.json',
    'GOOGLE_SERVICES_JSON',
    'android-google-services.json'
  )
  assertSecretFileStep(
    android,
    'Build Android AAB (Release)',
    'ANDROID_KEYSTORE_BASE64',
    'android-release.keystore'
  )
  assertSecretFileStep(
    ios,
    'Create GoogleService-Info.plist',
    'GOOGLE_SERVICE_INFO_PLIST',
    'ios-google-service-info.plist'
  )
  assertSecretFileStep(
    ios,
    'Install Provisioning Profile',
    'APPLE_PROVISIONING_PROFILE',
    'ios-profile.mobileprovision'
  )

  const androidCleanup = namedStep(android, 'Clean Android credentials')
  assert.equal(androidCleanup.if, 'always()')
  for (const pathToClean of [
    '$RUNNER_TEMP/android-google-services.json',
    '$RUNNER_TEMP/android-release.keystore',
    '$RUNNER_TEMP/firebase-service-account.json',
    'android/app/google-services.json',
    'android/release.keystore',
  ]) {
    assert.ok(
      androidCleanup.run.includes(pathToClean),
      `Android cleanup must remove ${pathToClean}`
    )
  }
  assert.equal(android.steps.at(-1), androidCleanup, 'Android credential cleanup must be last')

  const iosCleanup = namedStep(ios, 'Clean iOS credentials')
  assert.equal(iosCleanup.if, 'always()')
  for (const pathToClean of [
    '$RUNNER_TEMP/ios-google-service-info.plist',
    '$RUNNER_TEMP/ios-profile.mobileprovision',
    'ios/App/App/GoogleService-Info.plist',
    '$HOME/Library/MobileDevice/Provisioning Profiles/profile.mobileprovision',
  ]) {
    assert.ok(iosCleanup.run.includes(pathToClean), `iOS cleanup must remove ${pathToClean}`)
  }
  assert.equal(ios.steps.at(-1), iosCleanup, 'iOS credential cleanup must be last')
})

test('Android tester distribution uses the isolated lockfile-owned official Firebase CLI', () => {
  const { source, workflow } = readWorkflow()
  const android = workflow.jobs['build-android']
  const install = namedStep(android, 'Install Firebase release tooling')
  const distribution = namedStep(android, 'Upload to Firebase App Distribution')

  assert.equal(install.if, "github.event_name == 'workflow_dispatch'")
  assert.equal(install.run, 'npm ci --prefix tooling/mobile-release --ignore-scripts')
  assert.ok(
    android.steps.indexOf(install) < android.steps.indexOf(distribution),
    'release tooling must be installed before Firebase distribution'
  )

  assert.equal(distribution.if, "github.event_name == 'workflow_dispatch'")
  assert.equal(distribution.uses, undefined, 'Firebase distribution must not execute an action')
  assert.equal(distribution.with, undefined, 'Firebase distribution must not use action inputs')
  assert.equal(distribution.env?.FIREBASE_ANDROID_APP_ID, '${{ secrets.FIREBASE_ANDROID_APP_ID }}')
  assert.equal(
    distribution.env?.FIREBASE_SERVICE_ACCOUNT,
    '${{ secrets.FIREBASE_SERVICE_ACCOUNT }}'
  )
  assert.equal(
    distribution.env?.GOOGLE_APPLICATION_CREDENTIALS,
    '${{ runner.temp }}/firebase-service-account.json'
  )
  assert.match(distribution.run, /(^|\n)umask 077(?:\n|$)/)
  assert.ok(
    distribution.run.includes(
      `printf '%s' "$FIREBASE_SERVICE_ACCOUNT" > "$GOOGLE_APPLICATION_CREDENTIALS"`
    )
  )
  assert.ok(distribution.run.includes(`trap 'rm -f "$GOOGLE_APPLICATION_CREDENTIALS"' EXIT`))
  assert.ok(distribution.run.includes('unset FIREBASE_SERVICE_ACCOUNT'))
  assert.match(
    distribution.run,
    /\.\/tooling\/mobile-release\/node_modules\/\.bin\/firebase appdistribution:distribute \\\n+\s+android\/app\/build\/outputs\/apk\/debug\/app-debug\.apk \\\n+\s+--app "\$FIREBASE_ANDROID_APP_ID" \\\n+\s+--groups testers \\\n+\s+--non-interactive/
  )
  assert.doesNotMatch(source, /wzieba\/Firebase-Distribution-Github-Action/i)
  assert.doesNotMatch(distribution.run, /\bnpx\b|\bnpm exec\b/)

  const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, 'utf8'))
  const rootPackageLock = JSON.parse(fs.readFileSync(rootPackageLockPath, 'utf8'))
  assert.equal(rootPackage.devDependencies?.['firebase-tools'], undefined)
  assert.equal(rootPackageLock.packages?.['']?.devDependencies?.['firebase-tools'], undefined)
  assert.equal(rootPackageLock.packages?.['node_modules/firebase-tools'], undefined)

  const packageJson = JSON.parse(fs.readFileSync(releaseToolingPackagePath, 'utf8'))
  const packageLock = JSON.parse(fs.readFileSync(releaseToolingLockPath, 'utf8'))
  assert.equal(packageJson.private, true)
  assert.deepEqual(packageJson.engines, rootPackage.engines)
  assert.equal(packageJson.devDependencies?.['firebase-tools'], firebaseToolsVersion)
  assert.equal(packageLock.lockfileVersion, 3)
  assert.equal(packageLock.name, packageJson.name)
  assert.equal(packageLock.version, packageJson.version)
  assert.equal(packageLock.packages?.['']?.name, packageJson.name)
  assert.equal(packageLock.packages?.['']?.version, packageJson.version)
  assert.deepEqual(packageLock.packages?.['']?.engines, packageJson.engines)
  assert.equal(
    packageLock.packages?.['']?.devDependencies?.['firebase-tools'],
    firebaseToolsVersion
  )

  const lockedCli = packageLock.packages?.['node_modules/firebase-tools']
  assert.equal(lockedCli?.version, firebaseToolsVersion)
  assert.equal(
    lockedCli?.resolved,
    `https://registry.npmjs.org/firebase-tools/-/firebase-tools-${firebaseToolsVersion}.tgz`
  )
  assert.equal(lockedCli?.integrity, firebaseToolsIntegrity)
  assert.equal(lockedCli?.dev, true)
  assert.equal(lockedCli?.bin?.firebase, 'lib/bin/firebase.js')
  for (const [packageEntry, metadata] of Object.entries(packageLock.packages)) {
    if (packageEntry === '') continue
    assert.equal(metadata.dev, true, packageEntry + ' must remain release-tooling-only')
    assert.equal(
      typeof metadata.resolved,
      'string',
      packageEntry + ' must resolve from the npm registry'
    )
    assert.match(metadata.resolved, /^https:\/\/registry\.npmjs\.org\//)
    assert.equal(
      typeof metadata.integrity,
      'string',
      packageEntry + ' must carry package integrity'
    )
    assert.match(metadata.integrity, /^sha512-/)
  }

  const dependabotDocument = parseDocument(fs.readFileSync(dependabotPath, 'utf8'), {
    strict: true,
    uniqueKeys: true,
    version: '1.2',
  })
  assert.deepEqual(
    [...dependabotDocument.errors, ...dependabotDocument.warnings],
    [],
    'Dependabot configuration must remain strict YAML'
  )
  const dependabot = dependabotDocument.toJS({ maxAliasCount: 100 })
  const npmPolicies = dependabot.updates.filter((update) => update['package-ecosystem'] === 'npm')
  const rootPolicy = npmPolicies.find((update) => update.directory === '/')
  const toolingPolicies = npmPolicies.filter(
    (update) => update.directory === '/tooling/mobile-release'
  )
  assert.ok(rootPolicy, 'root npm Dependabot policy must exist')
  assert.equal(toolingPolicies.length, 1, 'release tooling must have one npm Dependabot policy')
  for (const field of [
    'schedule',
    'open-pull-requests-limit',
    'commit-message',
    'labels',
    'ignore',
    'groups',
  ]) {
    assert.deepEqual(
      toolingPolicies[0][field],
      rootPolicy[field],
      'release tooling Dependabot ' + field + ' must match the root policy'
    )
  }
})

test('isolated release tooling stays owned and outside deployable contexts', () => {
  const structure = fs.readFileSync(repositoryStructurePath, 'utf8')
  const codeowners = fs.readFileSync(codeownersPath, 'utf8')
  const gitignore = fs.readFileSync(gitignorePath, 'utf8')
  const vercelIgnore = fs.readFileSync(vercelIgnorePath, 'utf8')
  const dockerIgnore = fs.readFileSync(dockerIgnorePath, 'utf8')

  assert.match(structure, /`tooling\/` contains non-deployable, lockfile-isolated release tool/)
  assert.match(structure, /^tooling\/\s+Non-deployable, lockfile-isolated release tool packages$/m)
  assert.match(codeowners, /^\/tooling\/\s+@Adeline117$/m)
  assert.match(gitignore, /^\/tooling\/\*\/node_modules\/$/m)
  assert.match(vercelIgnore, /^tooling\/$/m)
  assert.match(dockerIgnore, /^tooling$/m)
})

test('isolated release tooling lock has a secret-free high-severity CI audit gate', () => {
  const { value: workflow } = readStrictYaml(ciWorkflowPath, 'CI workflow')
  const auditJob = workflow.jobs['mobile-release-tooling-audit']

  assert.ok(auditJob, 'CI must define the mobile release tooling audit job')
  assert.deepEqual(workflow.permissions, { contents: 'read' })
  assert.equal(auditJob.needs, undefined, 'the audit job must remain independently runnable')
  assert.equal(auditJob.if, undefined, 'the audit job must run for every CI event')
  assert.equal(auditJob['runs-on'], 'ubuntu-latest')
  assert.equal(auditJob['timeout-minutes'], 5)
  assert.equal(auditJob.permissions, undefined)
  assert.equal(auditJob.env, undefined)
  assert.equal(auditJob.environment, undefined)
  assert.equal(auditJob.strategy, undefined)
  assert.equal(auditJob['continue-on-error'], undefined)
  assert.equal(auditJob.steps.length, 3)

  const [checkout, setupNode, audit] = auditJob.steps
  assert.equal(checkout.uses, 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262')
  assert.deepEqual(checkout.with, { 'persist-credentials': false })
  assert.equal(checkout.run, undefined)
  assert.equal(setupNode.uses, 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38')
  assert.deepEqual(setupNode.with, { 'node-version': '22' })
  assert.equal(setupNode.run, undefined)
  assert.equal(audit.name, 'Audit the isolated mobile release tooling lock')
  assert.equal(audit.run, 'npm audit --prefix tooling/mobile-release --audit-level=high')
  assert.equal(audit.uses, undefined)

  for (const step of auditJob.steps) {
    assert.equal(step.if, undefined)
    assert.equal(step['continue-on-error'], undefined)
    assert.equal(step.env, undefined)
    if (step.run) {
      assert.doesNotMatch(step.run, /\|\|\s*true/)
      assert.doesNotMatch(step.run, /\bnpm\s+(?:ci|install)\b|\bnpx\b|\bfirebase\b/i)
    }
  }
  assert.doesNotMatch(
    JSON.stringify(auditJob),
    /secrets\.|FIREBASE_|GOOGLE_APPLICATION_CREDENTIALS/
  )
  assert.deepEqual(workflow.jobs['lint-typecheck'].needs, [
    'pre-checks',
    'worker-package',
    'mobile-release-tooling-audit',
  ])
})

test('mobile build uses local Capacitor and fail-closed short-lived artifacts', () => {
  const { workflow } = readWorkflow()
  const android = workflow.jobs['build-android']
  const ios = workflow.jobs['build-ios']

  assert.equal(namedStep(android, 'Sync Capacitor').run, './node_modules/.bin/cap sync android')
  assert.equal(namedStep(ios, 'Sync Capacitor').run, './node_modules/.bin/cap sync ios')

  const artifactPolicy = new Map([
    ['android-debug-apk', 3],
    ['android-release-aab', 7],
    ['ios-release-ipa', 7],
  ])
  const artifactSteps = [...android.steps, ...ios.steps].filter((step) =>
    step.uses?.startsWith('actions/upload-artifact@')
  )
  assert.equal(artifactSteps.length, artifactPolicy.size)
  for (const step of artifactSteps) {
    const artifactName = step.with?.name
    assert.equal(step.with?.['if-no-files-found'], 'error', `${artifactName} must fail closed`)
    assert.equal(
      step.with?.['retention-days'],
      artifactPolicy.get(artifactName),
      `${artifactName} must use its bounded retention policy`
    )
  }
})
