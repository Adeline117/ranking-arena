#!/usr/bin/env node
/**
 * Version Sync Script
 *
 * Syncs version from package.json to:
 * - capacitor.config.json (if version field exists)
 * - android/app/build.gradle (versionCode, versionName)
 * - ios/App/App.xcodeproj/project.pbxproj (MARKETING_VERSION, CURRENT_PROJECT_VERSION)
 *
 * Usage:
 *   node scripts/sync-version.mjs [--bump patch|minor|major]
 */

import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')

// Parse command line arguments
const args = process.argv.slice(2)
const bumpIndex = args.indexOf('--bump')
const bumpType = bumpIndex !== -1 ? args[bumpIndex + 1] : null

async function readJSON(filePath) {
  const content = await fs.readFile(filePath, 'utf-8')
  return JSON.parse(content)
}

async function writeJSON(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n')
}

function bumpVersion(version, type) {
  const [major, minor, patch] = version.split('.').map(Number)
  switch (type) {
    case 'major':
      return `${major + 1}.0.0`
    case 'minor':
      return `${major}.${minor + 1}.0`
    case 'patch':
    default:
      return `${major}.${minor}.${patch + 1}`
  }
}

function versionToCode(version) {
  // Convert semver to integer: 1.2.3 -> 10203
  const [major, minor, patch] = version.split('.').map(Number)
  return major * 10000 + minor * 100 + patch
}

async function syncAndroidVersion(version) {
  const buildGradlePath = path.join(rootDir, 'android/app/build.gradle')

  try {
    let content = await fs.readFile(buildGradlePath, 'utf-8')
    const versionCode = versionToCode(version)

    // Update versionCode
    content = content.replace(
      /versionCode\s+\d+/,
      `versionCode ${versionCode}`
    )

    // Update versionName
    content = content.replace(
      /versionName\s+"[^"]+"/,
      `versionName "${version}"`
    )

    await fs.writeFile(buildGradlePath, content)
    console.log(`  Android: versionCode=${versionCode}, versionName=${version}`)
    return true
  } catch (error) {
    console.warn(`  Android: Skipped (${error.message})`)
    return false
  }
}

async function synciOSVersion(version) {
  const pbxprojPath = path.join(rootDir, 'ios/App/App.xcodeproj/project.pbxproj')

  try {
    let content = await fs.readFile(pbxprojPath, 'utf-8')
    const buildNumber = versionToCode(version)

    // Update MARKETING_VERSION (display version)
    content = content.replace(
      /MARKETING_VERSION = [^;]+;/g,
      `MARKETING_VERSION = ${version};`
    )

    // Update CURRENT_PROJECT_VERSION (build number)
    content = content.replace(
      /CURRENT_PROJECT_VERSION = [^;]+;/g,
      `CURRENT_PROJECT_VERSION = ${buildNumber};`
    )

    await fs.writeFile(pbxprojPath, content)
    console.log(`  iOS: MARKETING_VERSION=${version}, CURRENT_PROJECT_VERSION=${buildNumber}`)
    return true
  } catch (error) {
    console.warn(`  iOS: Skipped (${error.message})`)
    return false
  }
}

async function main() {
  console.log('\n🔄 Version Sync\n')

  // Read package.json
  const packagePath = path.join(rootDir, 'package.json')
  const pkg = await readJSON(packagePath)
  let version = pkg.version

  // Bump version if requested
  if (bumpType) {
    const oldVersion = version
    version = bumpVersion(version, bumpType)
    pkg.version = version
    await writeJSON(packagePath, pkg)
    console.log(`📦 package.json: ${oldVersion} → ${version} (${bumpType})`)
  } else {
    console.log(`📦 package.json: ${version}`)
  }

  console.log('\nSyncing to native projects...')

  // Sync to Android
  await syncAndroidVersion(version)

  // Sync to iOS
  await synciOSVersion(version)

  console.log('\n✅ Version sync complete!')
  console.log(`\nNext steps:`)
  console.log(`  1. Commit the version changes`)
  console.log(`  2. Create a git tag: git tag v${version}`)
  console.log(`  3. Push with tags: git push origin main --tags`)
}

main().catch(error => {
  console.error('\n❌ Error:', error.message)
  process.exit(1)
})
