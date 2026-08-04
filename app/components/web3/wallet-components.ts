/**
 * Client entry point for wallet-dependent UI. Keeping the aggregator inside
 * `app/` preserves the shared wallet chunk without making `lib/` depend on UI.
 */

export { WalletSection } from '@/app/components/settings/WalletSection'
export { OneClickWalletButton } from '@/app/components/web3/OneClickWalletButton'
export { Web3Boundary } from '@/lib/web3/withWeb3'
