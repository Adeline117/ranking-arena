# Smart Contracts

This directory is an independently built Foundry unit. Solidity sources live
in `contracts/`; executable Foundry scripts live in the root `script/`
directory. The old TypeScript deployment placeholder has been retired.

## Reproducible build

```bash
git submodule update --init --recursive
nvm use
npm ci --ignore-scripts
npm run contracts:build
```

The dependency inputs are pinned to OpenZeppelin Contracts 5.4.0 and the
`forge-std` gitlink recorded by this repository. CI compiles the unit whenever
its source or dependency inputs change.

## Deployment policy

Compilation does not authorize deployment. `ArenaCopyTrading` v1 remains
quarantined; follow [COPY_TRADING_QUARANTINE.md](../docs/COPY_TRADING_QUARANTINE.md)
and require an explicit owner-approved change before any on-chain action.
Never put a private key, RPC credential, or signed transaction in this
repository.
