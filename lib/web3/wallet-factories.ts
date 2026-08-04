import type { WalletList } from '@rainbow-me/rainbowkit'
import { createConnector } from 'wagmi'
import { injected, walletConnect } from 'wagmi/connectors'

type CreateWallet = WalletList[number]['wallets'][number]

const BROWSER_WALLET_ICON =
  'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%3E%3Crect%20width%3D%2232%22%20height%3D%2232%22%20rx%3D%228%22%20fill%3D%22%230f172a%22%2F%3E%3Cpath%20d%3D%22M7%2010h18v12H7z%22%20rx%3D%223%22%20fill%3D%22%23fff%22%2F%3E%3Cpath%20d%3D%22M18%2014h8v5h-8a2.5%202.5%200%200%201%200-5Z%22%20fill%3D%22%233b82f6%22%2F%3E%3Ccircle%20cx%3D%2220.5%22%20cy%3D%2216.5%22%20r%3D%221%22%20fill%3D%22%23fff%22%2F%3E%3C%2Fsvg%3E'

const WALLET_CONNECT_ICON =
  'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%2032%2032%22%3E%3Crect%20width%3D%2232%22%20height%3D%2232%22%20rx%3D%228%22%20fill%3D%22%233b99fc%22%2F%3E%3Cpath%20d%3D%22M8.5%2012.5a10.6%2010.6%200%200%201%2015%200l.5.5-2.2%202.2-.5-.5a7.5%207.5%200%200%200-10.6%200l-.5.5L8%2013l.5-.5Zm3.4%203.4%202.1%202.1%202-2%202%202%202.1-2.1%202.2%202.2-4.3%204.3-2-2-2%202-4.3-4.3%202.2-2.2Z%22%20fill%3D%22%23fff%22%2F%3E%3C%2Fsvg%3E'

/** Generic EIP-1193 browser wallet; covers MetaMask and other injected wallets. */
export const browserWallet: CreateWallet = () => ({
  id: 'injected',
  name: 'Browser Wallet',
  iconUrl: BROWSER_WALLET_ICON,
  iconBackground: '#0f172a',
  createConnector: (walletDetails) =>
    createConnector((config) => ({
      ...injected()(config),
      ...walletDetails,
    })),
})

/** Generic WalletConnect v2 entry without vendor-specific wallet SDKs. */
export const walletConnectWallet: CreateWallet = ({ projectId, walletConnectParameters }) => ({
  id: 'walletConnect',
  name: 'WalletConnect',
  iconUrl: WALLET_CONNECT_ICON,
  iconBackground: '#3b99fc',
  qrCode: { getUri: (uri) => uri },
  createConnector: (walletDetails) => {
    const isModalConnector = walletDetails.rkDetails.isWalletConnectModalConnector === true
    const connector = walletConnect({
      ...walletConnectParameters,
      projectId,
      showQrModal: walletDetails.rkDetails.showQrModal === true,
      customStoragePrefix:
        walletConnectParameters?.customStoragePrefix ??
        (isModalConnector ? 'arena-rainbowkit-modal' : 'arena-rainbowkit-wallet'),
      telemetryEnabled: false,
    })

    return createConnector((config) => ({
      ...connector(config),
      ...walletDetails,
    }))
  },
})
