# Copy Trading v1 Quarantine

Status: **P0 product-side quarantine implemented; the on-chain owner block is
still pending. Do not enable or restore v1.**

This runbook covers the deployed ArenaCopyTrading v1 contract only. Product-side
gating prevents Arena from advertising or returning the contract address, but it
cannot stop a user from calling the public contract directly. The on-chain owner
must therefore complete the blocking transaction below. Merging this runbook or
the product gate is not evidence that the owner transaction happened.

## Deployment and audit record

| Item                       | Audited value                                                                                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network                    | Base mainnet (`chainId=8453`)                                                                                                                                                                        |
| v1 address                 | `0x84AfC435aF5a2d4C8535F8AA677Dc1501B0A9195`                                                                                                                                                         |
| Creation transaction       | `0x668345e71f28a8c39e20b01fddc89586ee6b5d2d6e161f066cd59056037701c9`                                                                                                                                 |
| Creation block / time      | `41,766,262` / `2026-02-05T20:04:31Z`                                                                                                                                                                |
| Owner                      | `0x8c3d9Bb2e1EB8B7af8D59a2e6F8E27B4ECA2aa1b` (EOA)                                                                                                                                                   |
| Collateral                 | Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`                                                                                                                                               |
| Upgradeability             | Direct, non-proxy v1; no upgrade function                                                                                                                                                            |
| Explorer verification      | Source is not verified on BaseScan/Blockscout                                                                                                                                                        |
| Internal bytecode evidence | Runtime reproduced from repository commit `e6f400e1e9ed93ed89ea32f8267f00250a6bb4d3`, Solidity `0.8.20`, optimizer `200`, OpenZeppelin `5.4.0`, forge-std `1801b0541f4fda118a10798fd3486bb7051c5dd6` |

Read-only audit point: Base block `48,796,256`
(`2026-07-18T13:37:39Z`).

- Contract runtime: `8,912` bytes; keccak256
  `0x084a90115b11af8ec07aa9164784b5d04bd1e99478bc223bf4892d480b7d3a14`.
- Contract USDC balance: `0`; native ETH balance: `0`.
- Activity since deployment: one transaction (creation) and one log
  (`OwnershipTransferred` during construction). No `StrategyCreated`,
  `StrategyUnsubscribed`, `EmergencyExit`, position, or PnL events.
- `maxFollowersPerTrader()` was still `100`; the on-chain block below was not
  yet complete at the audit point.

## Confirmed v1 defects

These findings apply to the deployed runtime, not merely an unshipped source
draft:

1. `emergencyExit` marks a strategy `Stopped` but transfers no collateral,
   does not decrement `traderFollowerCount`, and makes `unsubscribe` revert as
   "Already unsubscribed". A follower can permanently lose access to deposited
   funds by using the advertised emergency path.
2. The owner or any authorized executor can set arbitrary signed PnL through
   `updatePnl`, or supply arbitrary PnL to `recordPositionClose`. There is no
   on-chain trade, price, or settlement proof.
3. `withdrawFees(to, amount)` can transfer any amount of collateral without
   accrued-fee accounting or a reserve check. User principal is not segregated
   from owner withdrawals.
4. Positive PnL increases the follower withdrawal amount, but v1 has no profit
   funding or solvency mechanism. A profitable withdrawal can consume another
   follower's deposit or fail for insufficient balance.
5. There is no global pause/circuit breaker. Setting
   `maxFollowersPerTrader(0)` is the available on-chain control that rejects all
   new subscriptions; it does not repair existing strategies.

Because v1 is not upgradeable, these defects cannot be patched in place.
**Never re-enable or restore this address**, even after the follower cap is set
to zero.

## Required owner action: block every new subscription

The product flag is designed to fail closed, but this transaction is still
mandatory because direct contract calls bypass the website. At the audit point
above, the cap remained `100`; treat the owner action as incomplete until a
successful receipt and a post-transaction getter value of `0` are archived.

### 1. Read-only preflight

```bash
export BASE_RPC_URL=https://mainnet.base.org
export COPY_TRADING_V1=0x84AfC435aF5a2d4C8535F8AA677Dc1501B0A9195
export EXPECTED_OWNER=0x8c3d9Bb2e1EB8B7af8D59a2e6F8E27B4ECA2aa1b

cast call "$COPY_TRADING_V1" 'owner()(address)' --rpc-url "$BASE_RPC_URL"
cast call "$COPY_TRADING_V1" 'maxFollowersPerTrader()(uint256)' --rpc-url "$BASE_RPC_URL"
cast estimate "$COPY_TRADING_V1" \
  'setMaxFollowersPerTrader(uint256)' 0 \
  --from "$EXPECTED_OWNER" \
  --rpc-url "$BASE_RPC_URL"
```

Stop if the returned owner is not exactly `EXPECTED_OWNER`.

### 2. Owner submits the blocking transaction

Use the owner wallet through a hardware wallet or an encrypted local keystore.
Never paste a private key into a command, shell history, ticket, or this
document. Example for a connected Ledger:

```bash
cast send "$COPY_TRADING_V1" \
  'setMaxFollowersPerTrader(uint256)' 0 \
  --from "$EXPECTED_OWNER" \
  --ledger \
  --rpc-url "$BASE_RPC_URL"
```

Record the transaction hash in the incident/change log. This repository must
not automate, sign, or submit the transaction.

### 3. Receipt and fail-closed verification

```bash
export BLOCK_TX=0x_owner_supplied_transaction_hash

cast receipt "$BLOCK_TX" --rpc-url "$BASE_RPC_URL"
cast call "$COPY_TRADING_V1" \
  'maxFollowersPerTrader()(uint256)' \
  --rpc-url "$BASE_RPC_URL"
```

The receipt must have `status=1`, and the getter must return `0`. The setter
emits no event, so retain the transaction receipt and the post-transaction
getter output as the audit evidence.

Then verify a simulated subscription is rejected before any token transfer:

```bash
cast call "$COPY_TRADING_V1" \
  'subscribe(address,uint256,uint256,uint8,uint8)(bytes32)' \
  0x0000000000000000000000000000000000000002 \
  100000000 \
  100000000 \
  10 \
  1 \
  --from 0x0000000000000000000000000000000000000001 \
  --rpc-url "$BASE_RPC_URL"
```

Expected result: the read-only call reverts with `Trader at max capacity`.

## Read-only recurring audit

```bash
export BASE_RPC_URL=https://mainnet.base.org
export COPY_TRADING_V1=0x84AfC435aF5a2d4C8535F8AA677Dc1501B0A9195
export USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

cast block-number --rpc-url "$BASE_RPC_URL"
cast code "$COPY_TRADING_V1" --rpc-url "$BASE_RPC_URL" | cast keccak
cast call "$COPY_TRADING_V1" 'owner()(address)' --rpc-url "$BASE_RPC_URL"
cast call "$COPY_TRADING_V1" \
  'maxFollowersPerTrader()(uint256)' \
  --rpc-url "$BASE_RPC_URL"
cast call "$USDC" \
  'balanceOf(address)(uint256)' "$COPY_TRADING_V1" \
  --rpc-url "$BASE_RPC_URL"
cast balance "$COPY_TRADING_V1" --rpc-url "$BASE_RPC_URL"
```

For complete transaction and log pagination, use the public Blockscout v2
endpoints and archive the JSON response with the audit timestamp:

```bash
curl -fsS \
  "https://base.blockscout.com/api/v2/addresses/$COPY_TRADING_V1/transactions"
curl -fsS \
  "https://base.blockscout.com/api/v2/addresses/$COPY_TRADING_V1/logs"
```

Escalate immediately if the cap is non-zero, balances become non-zero, the
owner changes, or any post-deployment strategy/PnL event appears.

## V2 release gate

V1 has no recovery path. A V2 address may be added only after:

1. an independent security audit and remediation sign-off;
2. tests proving emergency exit returns funds and preserves accounting;
3. reserve/fee segregation and a funded, invariant-checked PnL settlement
   design;
4. bounded owner/executor authority, global pause, and monitored governance;
5. source verification, reproducible bytecode, deployment manifest, and live
   canary evidence;
6. an explicit owner launch decision followed by setting
   `NEXT_PUBLIC_COPY_TRADING_ENABLED=true` together with the audited V2 address.

An address by itself must never activate the product.
