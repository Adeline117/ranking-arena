/**
 * contract-detector — 链上 bot 合约判定。
 * EOA vs 代理钱包 vs 真 bot 合约的分类阈值(100 字节)决定谁被标 bot。
 */

const mockGetBytecode = jest.fn()
jest.mock('viem', () => ({
  createPublicClient: jest.fn(() => ({ getBytecode: mockGetBytecode })),
  http: jest.fn(),
}))
jest.mock('viem/chains', () => ({
  arbitrum: { id: 42161 },
  optimism: { id: 10 },
  polygon: { id: 137 },
  mainnet: { id: 1 },
  bsc: { id: 56 },
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }),
}))

import {
  getChainForPlatform,
  checkContract,
  isBotContract,
  batchCheckContracts,
  MIN_BOT_BYTECODE_SIZE,
  DEX_CHAIN_MAP,
} from '../contract-detector'

beforeEach(() => mockGetBytecode.mockReset())

describe('getChainForPlatform', () => {
  it('EVM DEX → 链 ID(hyperliquid/gmx/gains 走 Arbitrum)', () => {
    expect(getChainForPlatform('hyperliquid')).toBe(42161)
    expect(getChainForPlatform('gmx')).toBe(42161)
    expect(getChainForPlatform('aevo')).toBe(10)
    expect(getChainForPlatform('binance_web3')).toBe(56)
  })

  it('非 EVM(dydx/drift)不在映射 → null', () => {
    expect(getChainForPlatform('dydx')).toBeNull()
    expect(getChainForPlatform('drift')).toBeNull()
    expect(getChainForPlatform('bybit')).toBeNull()
  })

  it('映射里的链 ID 全部受支持(42161/10/137/1/56)', () => {
    const supported = new Set([42161, 10, 137, 1, 56])
    for (const chainId of Object.values(DEX_CHAIN_MAP)) {
      expect(supported.has(chainId)).toBe(true)
    }
  })
})

describe('checkContract', () => {
  it('无 bytecode(0x)→ EOA', async () => {
    mockGetBytecode.mockResolvedValue('0x')
    const r = await checkContract('0xabc', 42161)
    expect(r).toEqual({ isContract: false, bytecodeSize: 0 })
  })

  it('undefined bytecode → EOA', async () => {
    mockGetBytecode.mockResolvedValue(undefined)
    expect(await checkContract('0xabc', 42161)).toEqual({ isContract: false, bytecodeSize: 0 })
  })

  it('有 bytecode → isContract + 正确的字节数(hex 长度换算)', async () => {
    mockGetBytecode.mockResolvedValue('0x' + 'ab'.repeat(150)) // 150 字节
    const r = await checkContract('0xabc', 42161)
    expect(r).toEqual({ isContract: true, bytecodeSize: 150 })
  })

  it('RPC 抛错 → null(不炸批次)', async () => {
    mockGetBytecode.mockRejectedValue(new Error('rpc down'))
    expect(await checkContract('0xabc', 42161)).toBeNull()
  })
})

describe('isBotContract — 100 字节阈值', () => {
  it('EOA → 非 bot', () => {
    expect(isBotContract({ isContract: false, bytecodeSize: 0 })).toBe(false)
  })

  it('小合约(GMX/Gains 23 字节代理、Safe 钱包 <100)→ 非 bot(人操作)', () => {
    expect(isBotContract({ isContract: true, bytecodeSize: 23 })).toBe(false)
    expect(isBotContract({ isContract: true, bytecodeSize: 99 })).toBe(false)
  })

  it('>=100 字节真逻辑合约 → bot', () => {
    expect(isBotContract({ isContract: true, bytecodeSize: MIN_BOT_BYTECODE_SIZE })).toBe(true)
    expect(isBotContract({ isContract: true, bytecodeSize: 5000 })).toBe(true)
  })
})

describe('batchCheckContracts', () => {
  it('空地址 → 空 map,不调 RPC', async () => {
    const r = await batchCheckContracts([], 42161)
    expect(r.size).toBe(0)
    expect(mockGetBytecode).not.toHaveBeenCalled()
  })

  it('批量返回逐地址结果,单个失败为 null 不影响其他', async () => {
    mockGetBytecode
      .mockResolvedValueOnce('0x' + 'ab'.repeat(200)) // bot
      .mockRejectedValueOnce(new Error('rpc'))
      .mockResolvedValueOnce('0x') // EOA
    const r = await batchCheckContracts(['0x1', '0x2', '0x3'], 42161)
    expect(r.get('0x1')).toEqual({ isContract: true, bytecodeSize: 200 })
    expect(r.get('0x2')).toBeNull()
    expect(r.get('0x3')).toEqual({ isContract: false, bytecodeSize: 0 })
  })
})
