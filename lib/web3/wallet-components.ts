/**
 * Wallet Components — Single entry point for all wallet-dependent components.
 *
 * By re-exporting all wallet components from one module, we ensure
 * Turbopack creates a single shared chunk for the wallet SDK
 * (wagmi/viem/rainbowkit/walletconnect) instead of duplicating
 * it per-page.
 *
 * Usage in pages:
 *   const { WalletSection } = dynamic(() => import('@/lib/web3/wallet-components'), { ssr: false })
 *   OR use the pre-made lazy components from '@/lib/web3/LazyWalletComponents'
 */

export { WalletSection } from '@/app/components/settings/WalletSection'
export { OneClickWalletButton } from '@/app/components/web3/OneClickWalletButton'
export { Web3Boundary } from './withWeb3'
