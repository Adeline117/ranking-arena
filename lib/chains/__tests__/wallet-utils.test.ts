jest.mock('../config', () => ({
  EVM_CHAINS: {
    1: {
      chainId: 1,
      name: 'Ethereum',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrl: 'https://eth.rpc',
      explorerUrl: 'https://etherscan.io',
    },
    137: {
      chainId: 137,
      name: 'Polygon',
      nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
      rpcUrl: 'https://polygon.rpc',
      explorerUrl: 'https://polygonscan.com',
    },
  },
}))

import {
  buildAddChainParams,
  shortenAddress,
  getExplorerLink,
  switchChain,
  getCurrentChainId,
  isOnSupportedChain,
} from '../wallet-utils'

const cfg = {
  chainId: 137,
  name: 'Polygon',
  nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
  rpcUrl: 'https://polygon.rpc',
  explorerUrl: 'https://polygonscan.com',
}

describe('buildAddChainParams', () => {
  it('chainId 转 0x 十六进制', () => {
    expect(buildAddChainParams(cfg).chainId).toBe('0x89') // 137 = 0x89
    expect(buildAddChainParams({ ...cfg, chainId: 1 }).chainId).toBe('0x1')
  })

  it('rpcUrls/blockExplorerUrls 包成数组', () => {
    const p = buildAddChainParams(cfg)
    expect(p.rpcUrls).toEqual(['https://polygon.rpc'])
    expect(p.blockExplorerUrls).toEqual(['https://polygonscan.com'])
    expect(p.chainName).toBe('Polygon')
  })
})

describe('shortenAddress', () => {
  it('长地址 → 0x1234...abcd', () => {
    expect(shortenAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234...5678')
  })

  it('自定义 chars', () => {
    expect(shortenAddress('0x1234567890abcdef1234567890abcdef12345678', 6)).toBe(
      '0x123456...345678'
    )
  })

  it('太短的地址 → 原样', () => {
    expect(shortenAddress('0x12')).toBe('0x12')
    expect(shortenAddress('')).toBe('')
  })
})

describe('getExplorerLink', () => {
  it('已知链 → address/tx 链接', () => {
    expect(getExplorerLink(1, '0xabc')).toBe('https://etherscan.io/address/0xabc')
    expect(getExplorerLink(137, '0xdef', 'tx')).toBe('https://polygonscan.com/tx/0xdef')
  })

  it('未知链 → null', () => {
    expect(getExplorerLink(999, '0xabc')).toBeNull()
  })
})

describe('switchChain（provider mock）', () => {
  it('切换成功 → true', async () => {
    const provider = { request: jest.fn().mockResolvedValue(null) }
    expect(await switchChain(provider, 1)).toBe(true)
    expect(provider.request).toHaveBeenCalledWith({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x1' }],
    })
  })

  it('4902(链未添加)→ 回退到 addChain', async () => {
    const provider = {
      request: jest
        .fn()
        .mockRejectedValueOnce({ code: 4902 }) // switch 失败
        .mockResolvedValueOnce(null), // add 成功
    }
    expect(await switchChain(provider, 137)).toBe(true)
    expect(provider.request).toHaveBeenCalledTimes(2)
  })

  it('其他错误 → false（不回退）', async () => {
    const provider = { request: jest.fn().mockRejectedValue({ code: 4001 }) }
    expect(await switchChain(provider, 1)).toBe(false)
  })
})

describe('getCurrentChainId / isOnSupportedChain', () => {
  it('eth_chainId 十六进制 → 数字', async () => {
    const provider = { request: jest.fn().mockResolvedValue('0x89') }
    expect(await getCurrentChainId(provider)).toBe(137)
  })

  it('provider 报错 → null', async () => {
    const provider = { request: jest.fn().mockRejectedValue(new Error('no wallet')) }
    expect(await getCurrentChainId(provider)).toBeNull()
  })

  it('支持的链 → true，不支持 → false', async () => {
    expect(await isOnSupportedChain({ request: jest.fn().mockResolvedValue('0x1') })).toBe(true)
    expect(await isOnSupportedChain({ request: jest.fn().mockResolvedValue('0x270f') })).toBe(false) // 9999
  })
})
