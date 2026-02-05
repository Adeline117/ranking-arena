# Smart Contract Deployment Guide

This guide covers deploying Arena's smart contracts to Base L2.

## Contracts

| Contract | Description | Status |
|----------|-------------|--------|
| `ArenaMembership.sol` | ERC-721 Pro membership NFT | Ready |
| `ArenaCopyTrading.sol` | On-chain copy trading subscriptions | Ready |

## Prerequisites

### 1. Install Foundry

```bash
# Install Foundry
curl -L https://foundry.paradigm.xyz | bash

# Update to latest version
foundryup

# Verify installation
forge --version
```

### 2. Get Testnet ETH

For Base Sepolia testnet:
- [Coinbase Faucet](https://www.coinbase.com/faucets/base-ethereum-goerli-faucet)
- [Alchemy Faucet](https://www.alchemy.com/faucets/base-sepolia)

### 3. Set Environment Variables

Create or update `.env`:

```bash
# Deployment wallet private key (DO NOT use production keys for testnet!)
DEPLOYER_PRIVATE_KEY=0x...

# RPC URLs
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
BASE_RPC_URL=https://mainnet.base.org

# Basescan API key for contract verification
BASESCAN_API_KEY=your_api_key

# USDC addresses (for CopyTrading contract)
# Base Sepolia USDC: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
# Base Mainnet USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

## Deployment Steps

### Option 1: Using Foundry (Recommended)

#### Step 1: Compile Contracts

```bash
# From project root
forge build
```

#### Step 2: Deploy ArenaMembership

```bash
# Base Sepolia (Testnet)
forge create contracts/ArenaMembership.sol:ArenaMembership \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --constructor-args $DEPLOYER_ADDRESS 2592000 \
  --verify \
  --etherscan-api-key $BASESCAN_API_KEY

# Base Mainnet (Production)
forge create contracts/ArenaMembership.sol:ArenaMembership \
  --rpc-url $BASE_RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --constructor-args $DEPLOYER_ADDRESS 2592000 \
  --verify \
  --etherscan-api-key $BASESCAN_API_KEY
```

Constructor args:
- `initialOwner`: Deployer address (backend hot-wallet)
- `defaultDuration`: 2592000 (30 days in seconds)

#### Step 3: Deploy ArenaCopyTrading

```bash
# Base Sepolia (Testnet)
forge create contracts/ArenaCopyTrading.sol:ArenaCopyTrading \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --constructor-args $USDC_ADDRESS $DEPLOYER_ADDRESS 100000000 100 1000 100 \
  --verify \
  --etherscan-api-key $BASESCAN_API_KEY
```

Constructor args:
- `_collateralToken`: USDC address
- `_initialOwner`: Deployer address
- `_minAllocation`: 100000000 (100 USDC, 6 decimals)
- `_platformFeeBps`: 100 (1%)
- `_traderShareBps`: 1000 (10%)
- `_maxFollowersPerTrader`: 100

### Option 2: Using Remix IDE

1. Go to [Remix IDE](https://remix.ethereum.org)
2. Create new files and paste contract code
3. Compile with Solidity 0.8.20
4. Connect MetaMask to Base Sepolia
5. Deploy with constructor args

## Post-Deployment Setup

### 1. Update Environment Variables

After deployment, update `.env` or Vercel environment:

```bash
# ArenaMembership contract address
NEXT_PUBLIC_MEMBERSHIP_NFT_ADDRESS=0x...

# ArenaCopyTrading contract address (per chain)
NEXT_PUBLIC_COPY_TRADING_BASE=0x...
NEXT_PUBLIC_COPY_TRADING_ARBITRUM=0x...  # Future
NEXT_PUBLIC_COPY_TRADING_OPTIMISM=0x...  # Future
```

### 2. Configure Executors

Set the Arena backend as an authorized executor for the CopyTrading contract:

```bash
cast send $COPY_TRADING_ADDRESS "setExecutor(address,bool)" $BACKEND_ADDRESS true \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY
```

### 3. Verify Contracts

If not verified during deployment:

```bash
forge verify-contract $CONTRACT_ADDRESS contracts/ArenaMembership.sol:ArenaMembership \
  --chain base-sepolia \
  --etherscan-api-key $BASESCAN_API_KEY \
  --constructor-args $(cast abi-encode "constructor(address,uint256)" $DEPLOYER_ADDRESS 2592000)
```

## Update Frontend Configuration

Update `lib/web3/copy-trading.ts`:

```typescript
export const COPY_TRADING_ADDRESSES: Record<number, Address | undefined> = {
  8453: '0x...', // Base mainnet
  84532: '0x...', // Base Sepolia
  42161: undefined, // Arbitrum - not deployed
  10: undefined, // Optimism - not deployed
}
```

Update `lib/web3/multi-chain.ts`:

```typescript
[CHAIN_IDS.BASE]: {
  // ...
  contracts: {
    membershipNFT: process.env.NEXT_PUBLIC_MEMBERSHIP_NFT_ADDRESS,
    copyTrading: process.env.NEXT_PUBLIC_COPY_TRADING_BASE,
  },
},
```

## Multi-Chain Deployment

To deploy on additional chains:

### Arbitrum

```bash
forge create contracts/ArenaCopyTrading.sol:ArenaCopyTrading \
  --rpc-url https://arb1.arbitrum.io/rpc \
  --private-key $DEPLOYER_PRIVATE_KEY \
  --constructor-args $ARBITRUM_USDC $DEPLOYER_ADDRESS 100000000 100 1000 100
```

USDC addresses:
- Arbitrum: `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`
- Optimism: `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85`
- Polygon: `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`

## Testing

### Run Tests

```bash
forge test -vvv
```

### Test on Testnet

```bash
# Mint a test membership
cast send $MEMBERSHIP_ADDRESS "mint(address,uint256)" $TEST_USER 2592000 \
  --rpc-url $BASE_SEPOLIA_RPC_URL \
  --private-key $DEPLOYER_PRIVATE_KEY

# Check membership
cast call $MEMBERSHIP_ADDRESS "hasValidMembership(address)" $TEST_USER \
  --rpc-url $BASE_SEPOLIA_RPC_URL
```

## Security Considerations

1. **Private Keys**: Never commit private keys. Use environment variables.
2. **Ownership**: Consider using a multisig (e.g., Gnosis Safe) for mainnet ownership.
3. **Audits**: Get contracts audited before mainnet deployment with significant funds.
4. **Upgradability**: Current contracts are non-upgradeable. Plan for migration if needed.

## Gas Estimates

| Operation | Estimated Gas | Base Cost (~$0.01/100k gas) |
|-----------|---------------|------------------------------|
| Deploy Membership | ~1,500,000 | ~$0.15 |
| Deploy CopyTrading | ~2,500,000 | ~$0.25 |
| Mint NFT | ~150,000 | ~$0.015 |
| Subscribe | ~200,000 | ~$0.02 |
| Unsubscribe | ~100,000 | ~$0.01 |

## Support

For deployment issues:
- [Foundry Documentation](https://book.getfoundry.sh/)
- [Base Documentation](https://docs.base.org/)
- [OpenZeppelin Contracts](https://docs.openzeppelin.com/contracts/)
