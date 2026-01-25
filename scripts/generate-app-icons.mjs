#!/usr/bin/env node
/**
 * App Icon Generator
 *
 * Generates all required icon sizes for iOS App Store and Google Play
 * from a single source icon (1024x1024 recommended).
 *
 * Usage:
 *   node scripts/generate-app-icons.mjs [source-icon-path]
 *
 * If no source is provided, uses public/icon-source.png
 */

import sharp from 'sharp'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.join(__dirname, '..')

// iOS icon sizes (App Store requires 1024x1024)
const IOS_ICONS = [
  { size: 20, scales: [1, 2, 3], name: 'AppIcon-20' },      // Notification
  { size: 29, scales: [1, 2, 3], name: 'AppIcon-29' },      // Settings
  { size: 40, scales: [1, 2, 3], name: 'AppIcon-40' },      // Spotlight
  { size: 60, scales: [2, 3], name: 'AppIcon-60' },         // iPhone
  { size: 76, scales: [1, 2], name: 'AppIcon-76' },         // iPad
  { size: 83.5, scales: [2], name: 'AppIcon-83.5' },        // iPad Pro
  { size: 1024, scales: [1], name: 'AppIcon-1024' },        // App Store
]

// Android icon sizes (adaptive icons)
const ANDROID_ICONS = [
  { density: 'mdpi', size: 48 },
  { density: 'hdpi', size: 72 },
  { density: 'xhdpi', size: 96 },
  { density: 'xxhdpi', size: 144 },
  { density: 'xxxhdpi', size: 192 },
]

// Android adaptive icon foreground (with padding)
const ANDROID_ADAPTIVE_ICONS = [
  { density: 'mdpi', size: 108 },
  { density: 'hdpi', size: 162 },
  { density: 'xhdpi', size: 216 },
  { density: 'xxhdpi', size: 324 },
  { density: 'xxxhdpi', size: 432 },
]

// PWA icons
const PWA_ICONS = [
  { size: 72, name: 'icon-72x72' },
  { size: 96, name: 'icon-96x96' },
  { size: 128, name: 'icon-128x128' },
  { size: 144, name: 'icon-144x144' },
  { size: 152, name: 'icon-152x152' },
  { size: 192, name: 'icon-192x192' },
  { size: 384, name: 'icon-384x384' },
  { size: 512, name: 'icon-512x512' },
]

async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true })
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
  }
}

async function generateIcon(source, outputPath, size, options = {}) {
  const { round = false, padding = 0 } = options

  let image = sharp(source).resize(size - padding * 2, size - padding * 2, {
    fit: 'contain',
    background: { r: 11, g: 10, b: 16, alpha: 1 } // #0B0A10
  })

  if (padding > 0) {
    image = image.extend({
      top: padding,
      bottom: padding,
      left: padding,
      right: padding,
      background: { r: 11, g: 10, b: 16, alpha: 1 }
    })
  }

  if (round) {
    const roundedCorners = Buffer.from(
      `<svg><rect x="0" y="0" width="${size}" height="${size}" rx="${size * 0.2}" ry="${size * 0.2}"/></svg>`
    )
    image = image.composite([{
      input: roundedCorners,
      blend: 'dest-in'
    }])
  }

  await image.png().toFile(outputPath)
  console.log(`  Generated: ${path.basename(outputPath)} (${size}x${size})`)
}

async function generateIOSIcons(source) {
  console.log('\n📱 Generating iOS Icons...')
  const iosDir = path.join(rootDir, 'ios/App/App/Assets.xcassets/AppIcon.appiconset')
  await ensureDir(iosDir)

  const contents = {
    images: [],
    info: { author: 'xcode', version: 1 }
  }

  for (const icon of IOS_ICONS) {
    for (const scale of icon.scales) {
      const size = Math.round(icon.size * scale)
      const filename = `${icon.name}@${scale}x.png`
      await generateIcon(source, path.join(iosDir, filename), size)

      contents.images.push({
        filename,
        idiom: icon.size >= 76 ? 'ipad' : 'iphone',
        scale: `${scale}x`,
        size: `${icon.size}x${icon.size}`
      })
    }
  }

  // App Store icon (no scale suffix)
  const storeFilename = 'AppIcon-1024.png'
  contents.images.push({
    filename: storeFilename,
    idiom: 'ios-marketing',
    scale: '1x',
    size: '1024x1024'
  })

  await fs.writeFile(
    path.join(iosDir, 'Contents.json'),
    JSON.stringify(contents, null, 2)
  )
  console.log('  Generated: Contents.json')
}

async function generateAndroidIcons(source) {
  console.log('\n🤖 Generating Android Icons...')
  const resDir = path.join(rootDir, 'android/app/src/main/res')

  // Standard launcher icons
  for (const icon of ANDROID_ICONS) {
    const dir = path.join(resDir, `mipmap-${icon.density}`)
    await ensureDir(dir)
    await generateIcon(source, path.join(dir, 'ic_launcher.png'), icon.size)
    await generateIcon(source, path.join(dir, 'ic_launcher_round.png'), icon.size, { round: true })
  }

  // Adaptive icon foreground (with padding for safe zone)
  for (const icon of ANDROID_ADAPTIVE_ICONS) {
    const dir = path.join(resDir, `mipmap-${icon.density}`)
    await ensureDir(dir)
    // Foreground should have ~18% padding for adaptive icon safe zone
    const padding = Math.round(icon.size * 0.18)
    await generateIcon(source, path.join(dir, 'ic_launcher_foreground.png'), icon.size, { padding })
  }

  // Play Store icon (512x512)
  const playStoreDir = path.join(rootDir, 'appstore/android')
  await ensureDir(playStoreDir)
  await generateIcon(source, path.join(playStoreDir, 'play-store-icon.png'), 512)
  console.log('  Generated: play-store-icon.png (512x512)')
}

async function generatePWAIcons(source) {
  console.log('\n🌐 Generating PWA Icons...')
  const iconsDir = path.join(rootDir, 'public/icons')
  await ensureDir(iconsDir)

  for (const icon of PWA_ICONS) {
    await generateIcon(source, path.join(iconsDir, `${icon.name}.png`), icon.size)
  }

  // Maskable icons (with padding for safe area)
  console.log('\n  Generating maskable icons...')
  for (const icon of PWA_ICONS) {
    const padding = Math.round(icon.size * 0.1) // 10% padding for maskable
    await generateIcon(
      source,
      path.join(iconsDir, `${icon.name}-maskable.png`),
      icon.size,
      { padding }
    )
  }
}

async function generateSplashScreens(source) {
  console.log('\n🎨 Generating Splash Screens...')

  // iOS splash screens
  const iosSplashDir = path.join(rootDir, 'ios/App/App/Assets.xcassets/Splash.imageset')
  await ensureDir(iosSplashDir)

  const splashSizes = [
    { name: 'splash-2732x2732', size: 2732 },  // iPad Pro 12.9"
    { name: 'splash-1668x1668', size: 1668 },  // iPad Pro 11"
    { name: 'splash-1284x1284', size: 1284 },  // iPhone 14 Pro Max
  ]

  for (const splash of splashSizes) {
    // Create centered icon on dark background
    const icon = await sharp(source)
      .resize(splash.size / 3, splash.size / 3)
      .toBuffer()

    await sharp({
      create: {
        width: splash.size,
        height: splash.size,
        channels: 4,
        background: { r: 11, g: 10, b: 16, alpha: 1 }
      }
    })
      .composite([{
        input: icon,
        gravity: 'center'
      }])
      .png()
      .toFile(path.join(iosSplashDir, `${splash.name}.png`))

    console.log(`  Generated: ${splash.name}.png`)
  }

  // Contents.json for splash
  const splashContents = {
    images: splashSizes.map(s => ({
      filename: `${s.name}.png`,
      idiom: 'universal'
    })),
    info: { author: 'xcode', version: 1 }
  }
  await fs.writeFile(
    path.join(iosSplashDir, 'Contents.json'),
    JSON.stringify(splashContents, null, 2)
  )

  // Android splash
  const androidSplashDir = path.join(rootDir, 'android/app/src/main/res/drawable')
  await ensureDir(androidSplashDir)
  await generateIcon(source, path.join(androidSplashDir, 'splash.png'), 512)
}

async function main() {
  const sourceArg = process.argv[2]
  const sourcePath = sourceArg
    ? path.resolve(sourceArg)
    : path.join(rootDir, 'public/icon-source.png')

  try {
    await fs.access(sourcePath)
  } catch {
    console.error(`\n❌ Source icon not found: ${sourcePath}`)
    console.error('\nPlease provide a 1024x1024 PNG icon:')
    console.error('  node scripts/generate-app-icons.mjs path/to/icon.png')
    console.error('\nOr place your icon at: public/icon-source.png')
    process.exit(1)
  }

  const metadata = await sharp(sourcePath).metadata()
  console.log(`\n🎯 Source icon: ${sourcePath}`)
  console.log(`   Dimensions: ${metadata.width}x${metadata.height}`)

  if (metadata.width < 1024 || metadata.height < 1024) {
    console.warn('\n⚠️  Warning: Source icon should be at least 1024x1024 for best quality')
  }

  await generateIOSIcons(sourcePath)
  await generateAndroidIcons(sourcePath)
  await generatePWAIcons(sourcePath)
  await generateSplashScreens(sourcePath)

  console.log('\n✅ All icons generated successfully!')
  console.log('\nNext steps:')
  console.log('  1. Review generated icons in ios/App/App/Assets.xcassets/')
  console.log('  2. Review generated icons in android/app/src/main/res/mipmap-*/')
  console.log('  3. Review PWA icons in public/icons/')
  console.log('  4. Run: npm run cap:sync')
}

main().catch(console.error)
