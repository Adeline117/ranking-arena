import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { parseDocument } from 'yaml'

const root = path.resolve(import.meta.dirname, '../..')
const workflowPath = path.join(root, '.github/workflows/mobile-build.yml')
const pinnedAction = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$/

function readWorkflow() {
  const metadata = fs.lstatSync(workflowPath)
  assert.equal(metadata.isSymbolicLink(), false, 'mobile workflow must not be a symlink')
  assert.equal(metadata.isFile(), true, 'mobile workflow must be a regular file')

  const source = fs.readFileSync(workflowPath, 'utf8')
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
    `mobile workflow must be strict YAML:\n${diagnostics.map(String).join('\n')}`
  )

  return { source, workflow: document.toJS({ maxAliasCount: 100 }) }
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
    'android/app/google-services.json',
    'android/release.keystore',
    'service_credentials_content.json',
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
