import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

import { getOptionalWalletPeerWarningRules } from '../../lib/config/webpack-warning-policy.mjs'

const root = process.cwd()

function read(path) {
  return readFileSync(resolve(root, path), 'utf8')
}

function isIgnored(module, message) {
  return getOptionalWalletPeerWarningRules().some(
    (rule) => rule.module.test(module) && rule.message.test(message)
  )
}

test('RainbowKit uses an explicit security-reviewed wallet allowlist', () => {
  const config = read('lib/web3/config.ts')
  assert.match(config, /from ['"]\.\/wallet-factories['"]/)
  assert.doesNotMatch(config, /@rainbow-me\/rainbowkit\/wallets/)

  const group = config.match(
    /wallets:\s*\[\s*\{\s*groupName:\s*['"][^'"]+['"],\s*wallets:\s*\[([^\]]+)\],?\s*\},?\s*\]/
  )
  assert.ok(group, 'getDefaultConfig must provide one explicit wallet group')

  const wallets = group[1]
    .split(',')
    .map((wallet) => wallet.trim())
    .filter(Boolean)
  assert.deepEqual(wallets, ['browserWallet', 'walletConnectWallet'])
  assert.doesNotMatch(group[0], /\b(?:safeWallet|baseAccount|metaMaskWallet|coinbaseWallet)\b/)
})

test('local wallet factories use only generic connectors and disable telemetry', () => {
  const factories = read('lib/web3/wallet-factories.ts')

  assert.match(factories, /import \{ createConnector \} from ['"]wagmi['"]/)
  assert.match(factories, /import \{ injected, walletConnect \} from ['"]wagmi\/connectors['"]/)
  assert.match(factories, /\.\.\.injected\(\)\(config\)/)
  assert.match(factories, /\.\.\.connector\(config\)/)
  assert.match(factories, /showQrModal: walletDetails\.rkDetails\.showQrModal === true/)
  assert.match(factories, /isWalletConnectModalConnector === true/)
  assert.match(factories, /customStoragePrefix:/)
  assert.match(factories, /telemetryEnabled: false/)
  assert.doesNotMatch(factories, /\b(?:safe|baseAccount|metaMask|coinbaseWallet)\s*\(/)
})

test('specialized connector peers are not direct production dependencies', () => {
  const { dependencies } = JSON.parse(read('package.json'))

  for (const dependency of [
    '@base-org/account',
    '@metamask/connect-evm',
    '@safe-global/safe-apps-sdk',
    '@safe-global/safe-apps-provider',
  ]) {
    assert.equal(
      dependencies[dependency],
      undefined,
      `${dependency} must stay outside the allowlist`
    )
  }
})

test('optional peer warning policy is constrained by importer and request', () => {
  const rules = getOptionalWalletPeerWarningRules()
  assert.equal(rules.length, 6)

  const allowedWarnings = [
    {
      module: '/repo/node_modules/@privy-io/react-auth/dist/esm/FiatOnrampScreen-abc123.mjs',
      request: '@stripe/crypto',
    },
    {
      module: '/repo/node_modules/@wagmi/connectors/dist/esm/coinbaseWallet.js',
      request: '@coinbase/wallet-sdk',
    },
    {
      module: '/repo/node_modules/@wagmi/connectors/dist/esm/baseAccount.js',
      request: '@base-org/account',
    },
    {
      module: '/repo/node_modules/@wagmi/connectors/dist/esm/metaMask.js',
      request: '@metamask/connect-evm',
    },
    {
      module: '/repo/node_modules/@wagmi/connectors/dist/esm/safe.js',
      request: '@safe-global/safe-apps-sdk',
    },
    {
      module: '/repo/node_modules/@wagmi/connectors/dist/esm/safe.js',
      request: '@safe-global/safe-apps-provider',
    },
  ]

  for (const warning of allowedWarnings) {
    const message = `Module not found: Error: Can't resolve '${warning.request}'`
    assert.equal(
      isIgnored(warning.module, message),
      true,
      `expected narrow rule for ${warning.request}`
    )
    assert.equal(
      isIgnored('/repo/app/wallet.ts', message),
      false,
      `${warning.request} must not be ignored from application code`
    )
    assert.equal(
      isIgnored(warning.module, "Module not found: Error: Can't resolve '@example/unrelated'"),
      false,
      `${warning.module} must not suppress unrelated requests`
    )
  }

  assert.equal(
    isIgnored(
      'C:\\repo\\node_modules\\@privy-io\\react-auth\\dist\\cjs\\FiatOnrampScreen-abc123.js',
      "Module not found: Error: Can't resolve '@stripe/crypto'"
    ),
    true
  )
  assert.equal(
    isIgnored(
      '/repo/node_modules/@wagmi/connectors/dist/esm/metaMask.js',
      "Module not found: Error: Can't resolve '@safe-global/safe-apps-sdk'"
    ),
    false
  )
  assert.equal(
    isIgnored(
      '/repo/node_modules/@wagmi/connectors/dist/esm/safe.js',
      "Module not found: Error: Can't resolve '@metamask/connect-evm'"
    ),
    false
  )
  assert.equal(
    isIgnored(
      '/repo/node_modules/@wagmi/connectors/dist/esm/coinbaseWallet.js',
      'Critical dependency: the request of a dependency is an expression'
    ),
    false
  )
})

test('Next webpack config uses the narrow policy instead of global IgnorePlugin entries', () => {
  const config = read('next.config.ts')
  assert.match(config, /\.\.\.getOptionalWalletPeerWarningRules\(\)/)

  const ignorePlugin = config.match(/new webpack\.IgnorePlugin\(\{[\s\S]*?\}\)/)?.[0]
  assert.ok(ignorePlugin, 'expected the existing IgnorePlugin configuration')
  for (const dependency of [
    /@stripe[\\/]crypto/,
    /@coinbase[\\/]wallet-sdk/,
    /@metamask[\\/]connect-evm/,
    /@safe-global[\\/]safe-apps-(?:sdk|provider)/,
  ]) {
    assert.doesNotMatch(ignorePlugin, dependency)
  }
})
