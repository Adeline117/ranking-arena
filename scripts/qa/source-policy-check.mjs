import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sourceExtensions = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length
}

function addViolation(violations, path, rule, source, match) {
  violations.push({
    path,
    rule,
    line: lineNumberAt(source, match.index ?? 0),
  })
}

function isTestPath(path) {
  return /(^|\/)(?:__tests__|__integration__|test-helpers|fixtures)(\/|$)|\.(?:test|spec)\.[^.]+$/.test(
    path
  )
}

/**
 * Evaluate repository policies that previously existed only in an untracked,
 * machine-local pre-push hook. Exemptions are narrow, named, and reviewable.
 */
export function evaluateSource(path, source) {
  const violations = []
  const apiRoute = /^app\/api\/.*\.(?:[cm]?[jt]sx?)$/.test(path)
  const cronRoute = /^app\/api\/cron\//.test(path)

  if (!isTestPath(path)) {
    const directSpecializedWalletPeer =
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"](?:@base-org\/account|@coinbase\/wallet-sdk|@metamask\/connect-evm|@safe-global\/safe-apps-(?:sdk|provider))(?:\/[^'"]*)?['"]/g.exec(
        source
      )
    if (directSpecializedWalletPeer) {
      addViolation(
        violations,
        path,
        'specialized-wallet-peer-boundary',
        source,
        directSpecializedWalletPeer
      )
    }

    const specializedWagmiConnector =
      /import\s*\{[^}]*\b(?:baseAccount|coinbaseWallet|metaMask|safe)\b[^}]*\}\s*from\s*['"]wagmi\/connectors['"]/gs.exec(
        source
      ) ??
      /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]wagmi\/connectors\/(?:baseAccount|coinbaseWallet|metaMask|safe)['"]/g.exec(
        source
      )
    if (specializedWagmiConnector) {
      addViolation(
        violations,
        path,
        'specialized-wallet-connector-boundary',
        source,
        specializedWagmiConnector
      )
    }

    const opaqueWagmiConnectorImport =
      /import\s+(?:\*\s+as\s+|[A-Za-z_$][\w$]*\s+from\s*)[^;\n]*['"]wagmi\/connectors['"]/g.exec(
        source
      ) ?? /(?:\bimport|\brequire)\s*\(\s*['"]wagmi\/connectors['"]\s*\)/g.exec(source)
    if (opaqueWagmiConnectorImport) {
      addViolation(
        violations,
        path,
        'opaque-wallet-connector-boundary',
        source,
        opaqueWagmiConnectorImport
      )
    }

    const directOverflow = /document\s*\.\s*body\s*\.\s*style\s*\.\s*overflow\s*=/g.exec(source)
    if (directOverflow) {
      addViolation(violations, path, 'modal-scroll-lock', source, directOverflow)
    }

    if (path !== 'lib/ingest/db.ts' && /^(?:lib\/ingest\/|worker\/src\/ingest\/)/.test(path)) {
      const rawPoolCheckout = /(?:\bpool|getIngestPool\(\))\s*\.\s*connect\s*\(/g.exec(source)
      if (rawPoolCheckout) {
        addViolation(violations, path, 'ingest-pool-checkout', source, rawPoolCheckout)
      }
    }
  }

  if (!apiRoute || cronRoute || isTestPath(path)) return violations

  const notificationInsert = /\.from\(\s*(['"])notifications\1\s*\)\s*\.\s*insert\s*\(/gs.exec(
    source
  )
  if (notificationInsert && !/source-policy-exempt:\s*notification-batch\b/.test(source)) {
    addViolation(violations, path, 'notification-writer-boundary', source, notificationInsert)
  }

  const rawCounter = /\.rpc\(\s*(['"])(?:increment_|decrement_)[a-z0-9_]*\1/gs.exec(source)
  if (rawCounter && !/source-policy-exempt:\s*counter-rpc\b/.test(source)) {
    addViolation(violations, path, 'counter-service-boundary', source, rawCounter)
  }

  const checkoutCreation = /\.checkout\s*\.\s*sessions\s*\.\s*create\s*\(/gs.exec(source)
  if (
    checkoutCreation &&
    !/\bidempotencyKey\b/.test(source) &&
    !/\b(?:createCheckoutSession|createOneTimePaymentSession)\b/.test(source)
  ) {
    addViolation(violations, path, 'stripe-idempotency', source, checkoutCreation)
  }

  const interpolatedIlike = /\.ilike\([^)]*`[^`]*\$\{/gs.exec(source)
  if (interpolatedIlike && !/\bescapeLikePattern\b/.test(source)) {
    addViolation(violations, path, 'ilike-escaping', source, interpolatedIlike)
  }

  return violations
}

export function evaluateFiles(paths, root = repositoryRoot) {
  const violations = []
  for (const rawPath of paths) {
    const absolutePath = resolve(root, rawPath)
    const path = relative(root, absolutePath).replaceAll('\\', '/')
    if (
      path.startsWith('../') ||
      !sourceExtensions.has(extname(path)) ||
      !existsSync(absolutePath)
    ) {
      continue
    }
    violations.push(...evaluateSource(path, readFileSync(absolutePath, 'utf8')))
  }
  return violations
}

function git(args) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function pathsFromInput() {
  const explicitPaths = process.argv.slice(2).filter(Boolean)
  if (explicitPaths.length > 0) return explicitPaths

  if (!process.stdin.isTTY) {
    const piped = readFileSync(0, 'utf8').trim()
    if (piped) return piped.split('\n')
  }

  const output = git(['ls-files', '-co', '--exclude-standard', '--', 'app', 'lib', 'worker'])
  return output ? output.split('\n') : []
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMainModule()) {
  try {
    const paths = pathsFromInput()
    const violations = evaluateFiles(paths)
    if (violations.length > 0) {
      console.error('Source policy violations:')
      for (const violation of violations) {
        console.error(`- ${violation.path}:${violation.line} [${violation.rule}]`)
      }
      process.exitCode = 1
    } else {
      console.log(`Source policy passed (${paths.length} repository paths checked).`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 2
  }
}
