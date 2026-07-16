import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// SWC/Turbopack has previously lowered `bigint ** BigInt(...)` to
// `Math.pow(bigint, BigInt(...))`. Browsers reject that at module evaluation
// time, which prevents Privy and the rest of the interactive shell from
// mounting. Keep this check on emitted browser code instead of relying on the
// source tree or a particular compiler implementation.
const UNSAFE_BIGINT_POWER =
  /(?:Math\.pow|\(\s*0\s*,\s*Math\.pow\s*\))\s*\([^,\r\n]{1,512},\s*BigInt\s*\(/g

function javascriptFiles(directory) {
  const files = []

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...javascriptFiles(target))
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(target)
  }

  return files
}

export function findUnsafeBigIntPower(chunksDirectory) {
  if (!fs.existsSync(chunksDirectory)) {
    throw new Error(`browser chunks directory does not exist: ${chunksDirectory}`)
  }

  const files = javascriptFiles(chunksDirectory)
  if (files.length === 0) {
    throw new Error(`no browser JavaScript chunks found in: ${chunksDirectory}`)
  }

  return files.filter((file) => {
    UNSAFE_BIGINT_POWER.lastIndex = 0
    return UNSAFE_BIGINT_POWER.test(fs.readFileSync(file, 'utf8'))
  })
}

function run(chunksDirectory) {
  const unsafeFiles = findUnsafeBigIntPower(chunksDirectory)
  if (unsafeFiles.length > 0) {
    console.error('Unsafe Math.pow(..., BigInt(...)) output found in browser chunks:')
    for (const file of unsafeFiles) console.error(`- ${path.relative(process.cwd(), file)}`)
    process.exitCode = 1
    return
  }

  process.stdout.write(
    `BigInt build-output check passed (${javascriptFiles(chunksDirectory).length} chunks)\n`
  )
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (invokedDirectly) {
  run(path.resolve(process.argv[2] ?? '.next/static/chunks'))
}
