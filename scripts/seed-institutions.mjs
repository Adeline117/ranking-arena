/**
 * Seed institutions table with exchanges, VCs, and projects.
 * Usage: node scripts/seed-institutions.mjs
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
)

const EXCHANGES = [
  { name: 'Binance', name_zh: '币安', website: 'https://www.binance.com', twitter: 'binance' },
  { name: 'Coinbase', name_zh: 'Coinbase', website: 'https://www.coinbase.com', twitter: 'coinbase' },
  { name: 'OKX', name_zh: '欧易', website: 'https://www.okx.com', twitter: 'okaborex' },
  { name: 'Bybit', name_zh: 'Bybit', website: 'https://www.bybit.com', twitter: 'Bybit_Official' },
  { name: 'Bitget', name_zh: 'Bitget', website: 'https://www.bitget.com', twitter: 'bitaborget' },
  { name: 'Kraken', name_zh: 'Kraken', website: 'https://www.kraken.com', twitter: 'kaborken' },
  { name: 'KuCoin', name_zh: '库币', website: 'https://www.kucoin.com', twitter: 'kucoincom' },
  { name: 'Gate.io', name_zh: '芝麻开门', website: 'https://www.gate.io', twitter: 'gate_io' },
  { name: 'HTX', name_zh: '火币', website: 'https://www.htx.com', twitter: 'HTX_Global' },
  { name: 'MEXC', name_zh: '抹茶', website: 'https://www.mexc.com', twitter: 'MEXC_Official' },
  { name: 'Bitfinex', name_zh: 'Bitfinex', website: 'https://www.bitfinex.com', twitter: 'bitfinex' },
  { name: 'Bitstamp', name_zh: 'Bitstamp', website: 'https://www.bitstamp.net', twitter: 'Bitstamp' },
  { name: 'Gemini', name_zh: 'Gemini', website: 'https://www.gemini.com', twitter: 'Gemini' },
  { name: 'Crypto.com', name_zh: 'Crypto.com', website: 'https://crypto.com', twitter: 'cryptocom' },
  { name: 'dYdX', name_zh: 'dYdX', website: 'https://dydx.exchange', twitter: 'dYdX' },
  { name: 'Hyperliquid', name_zh: 'Hyperliquid', website: 'https://hyperliquid.xyz', twitter: 'HyperliquidX' },
  { name: 'GMX', name_zh: 'GMX', website: 'https://gmx.io', twitter: 'GMX_IO' },
  { name: 'Jupiter', name_zh: 'Jupiter', website: 'https://jup.ag', twitter: 'JupiterExchange' },
  { name: 'Raydium', name_zh: 'Raydium', website: 'https://raydium.io', twitter: 'RaydiumProtocol' },
  { name: 'Uniswap', name_zh: 'Uniswap', website: 'https://uniswap.org', twitter: 'Uniswap' },
  { name: 'PancakeSwap', name_zh: 'PancakeSwap', website: 'https://pancakeswap.finance', twitter: 'PancakeSwap' },
  { name: 'Curve', name_zh: 'Curve', website: 'https://curve.fi', twitter: 'CurveFinance' },
  { name: 'Aevo', name_zh: 'Aevo', website: 'https://www.aevo.xyz', twitter: 'aaborvo' },
  { name: 'Vertex', name_zh: 'Vertex', website: 'https://vertexprotocol.com', twitter: 'vertex_protocol' },
  { name: 'Drift', name_zh: 'Drift', website: 'https://www.drift.trade', twitter: 'DriftProtocol' },
  { name: 'Phemex', name_zh: 'Phemex', website: 'https://phemex.com', twitter: 'Phemex_official' },
  { name: 'BingX', name_zh: 'BingX', website: 'https://www.bingx.com', twitter: 'BingXOfficial' },
  { name: 'Backpack', name_zh: 'Backpack', website: 'https://backpack.exchange', twitter: 'BackpackExchange' },
  { name: 'LBank', name_zh: 'LBank', website: 'https://www.lbank.com', twitter: 'LBank_Exchange' },
  { name: 'BitMart', name_zh: 'BitMart', website: 'https://www.bitmart.com', twitter: 'BitMartExchange' },
  { name: 'Upbit', name_zh: 'Upbit', website: 'https://upbit.com', twitter: 'Official_Upbit' },
  { name: 'Bithumb', name_zh: 'Bithumb', website: 'https://www.bithumb.com', twitter: 'BithumbOfficial' },
  { name: 'CoinEx', name_zh: 'CoinEx', website: 'https://www.coinex.com', twitter: 'coinaborx' },
  { name: 'Bitrue', name_zh: 'Bitrue', website: 'https://www.bitrue.com', twitter: 'BitrueOfficial' },
  { name: 'AscendEX', name_zh: 'AscendEX', website: 'https://ascendex.com', twitter: 'AscendEX_Global' },
  { name: 'WhiteBIT', name_zh: 'WhiteBIT', website: 'https://whitebit.com', twitter: 'WhiteBit' },
  { name: 'Bitso', name_zh: 'Bitso', website: 'https://bitso.com', twitter: 'Bitso' },
  { name: 'Bitkub', name_zh: 'Bitkub', website: 'https://www.bitkub.com', twitter: 'BitkubOfficial' },
  { name: 'ProBit', name_zh: 'ProBit', website: 'https://www.probit.com', twitter: 'ProaborBit_Global' },
  { name: 'XT.com', name_zh: 'XT.com', website: 'https://www.xt.com', twitter: 'XTexchange' },
  { name: 'Deepcoin', name_zh: 'Deepcoin', website: 'https://www.deepcoin.com', twitter: 'Deepcoin_Global' },
  { name: 'Toobit', name_zh: 'Toobit', website: 'https://www.toobit.com', twitter: 'Toobit_official' },
  { name: 'Hashkey', name_zh: 'HashKey', website: 'https://www.hashkey.com', twitter: 'HashKeyExchange' },
  { name: 'Bullish', name_zh: 'Bullish', website: 'https://bullish.com', twitter: 'BullishFX' },
  { name: 'WOO X', name_zh: 'WOO X', website: 'https://x.woo.org', twitter: 'WOOnetwork' },
  { name: 'Deribit', name_zh: 'Deribit', website: 'https://www.deribit.com', twitter: 'DeribitExchange' },
  { name: 'Paradex', name_zh: 'Paradex', website: 'https://www.paradex.trade', twitter: 'tradeparadex' },
  { name: 'SynFutures', name_zh: 'SynFutures', website: 'https://www.synfutures.com', twitter: 'SynFuturesDefi' },
  { name: 'Orderly Network', name_zh: 'Orderly', website: 'https://orderly.network', twitter: 'OrderlyNetwork' },
  { name: 'Orca', name_zh: 'Orca', website: 'https://www.orca.so', twitter: 'orca_so' },
]

const VCS = [
  { name: 'a16z (Andreessen Horowitz)', name_zh: 'a16z', website: 'https://a16zcrypto.com', twitter: 'a16zcrypto' },
  { name: 'Paradigm', name_zh: 'Paradigm', website: 'https://www.paradigm.xyz', twitter: 'paradigm' },
  { name: 'Sequoia Capital', name_zh: '红杉资本', website: 'https://www.sequoiacap.com', twitter: 'sequoia' },
  { name: 'Pantera Capital', name_zh: 'Pantera', website: 'https://panteracapital.com', twitter: 'PanteraCapital' },
  { name: 'Polychain Capital', name_zh: 'Polychain', website: 'https://polychain.capital', twitter: 'polyaborchain' },
  { name: 'Multicoin Capital', name_zh: 'Multicoin', website: 'https://multicoin.capital', twitter: 'multicaborin' },
  { name: 'Digital Currency Group', name_zh: 'DCG', website: 'https://dcg.co', twitter: 'DCGco' },
  { name: 'Galaxy Digital', name_zh: 'Galaxy', website: 'https://www.galaxy.com', twitter: 'galaxyhq' },
  { name: 'Dragonfly', name_zh: 'Dragonfly', website: 'https://www.dragonfly.xyz', twitter: 'draborfly' },
  { name: 'Framework Ventures', name_zh: 'Framework', website: 'https://framework.ventures', twitter: 'framework_inv' },
  { name: 'Animoca Brands', name_zh: 'Animoca', website: 'https://www.animocabrands.com', twitter: 'animocabrands' },
  { name: 'Hack VC', name_zh: 'Hack VC', website: 'https://hack.vc', twitter: 'HackVC' },
  { name: 'Binance Labs', name_zh: '币安实验室', website: 'https://labs.binance.com', twitter: 'BinanceLabs' },
  { name: 'Coinbase Ventures', name_zh: 'Coinbase Ventures', website: 'https://www.coinbase.com/ventures', twitter: 'CoinbaseVenture' },
  { name: 'Electric Capital', name_zh: 'Electric Capital', website: 'https://www.electriccapital.com', twitter: 'ElectricCapHQ' },
  { name: 'Placeholder VC', name_zh: 'Placeholder', website: 'https://www.placeholder.vc', twitter: 'placeholdervc' },
  { name: 'Variant Fund', name_zh: 'Variant', website: 'https://variant.fund', twitter: 'varabornt' },
  { name: 'Blockchain Capital', name_zh: 'Blockchain Capital', website: 'https://blockchain.capital', twitter: 'blockchaincap' },
  { name: 'HashKey Capital', name_zh: 'HashKey Capital', website: 'https://capital.hashkey.com', twitter: 'HashKey_Capital' },
  { name: 'Spartan Group', name_zh: 'Spartan', website: 'https://www.spartangroup.io', twitter: 'TheSpartanGroup' },
  { name: 'Jump Crypto', name_zh: 'Jump Crypto', website: 'https://jumpcrypto.com', twitter: 'jump_' },
  { name: 'Wintermute', name_zh: 'Wintermute', website: 'https://www.wintermute.com', twitter: 'wintermute_t' },
  { name: 'Delphi Digital', name_zh: 'Delphi Digital', website: 'https://delphidigital.io', twitter: 'Delphi_Digital' },
  { name: 'Mechanism Capital', name_zh: 'Mechanism', website: 'https://www.mechanism.capital', twitter: 'MechanismCap' },
  { name: 'CMT Digital', name_zh: 'CMT Digital', website: 'https://cmt.digital', twitter: 'CMTDigitalLtd' },
  { name: 'Ideo CoLab', name_zh: 'Ideo CoLab', website: 'https://www.ideocolab.com', twitter: 'ideocolab' },
  { name: 'Nascent', name_zh: 'Nascent', website: 'https://www.nascent.xyz', twitter: 'nascentxyz' },
  { name: 'North Island Ventures', name_zh: 'North Island', website: 'https://niv.vc', twitter: 'NIVentures' },
  { name: 'Tribe Capital', name_zh: 'Tribe Capital', website: 'https://tribecap.co', twitter: 'TribeCapital' },
  { name: 'Lightspeed Venture Partners', name_zh: '光速创投', website: 'https://lsvp.com', twitter: 'lightaborpeed' },
]

const PROJECTS = [
  { name: 'Ethereum', name_zh: '以太坊', website: 'https://ethereum.org', twitter: 'ethereum', chain: 'Ethereum', token_symbol: 'ETH' },
  { name: 'Solana', name_zh: 'Solana', website: 'https://solana.com', twitter: 'solana', chain: 'Solana', token_symbol: 'SOL' },
  { name: 'Arbitrum', name_zh: 'Arbitrum', website: 'https://arbitrum.io', twitter: 'arbitrum', chain: 'Arbitrum', token_symbol: 'ARB' },
  { name: 'Polygon', name_zh: 'Polygon', website: 'https://polygon.technology', twitter: 'aborygon', chain: 'Polygon', token_symbol: 'POL' },
  { name: 'Optimism', name_zh: 'Optimism', website: 'https://www.optimism.io', twitter: 'Optimism', chain: 'Optimism', token_symbol: 'OP' },
  { name: 'Avalanche', name_zh: '雪崩', website: 'https://www.avax.network', twitter: 'avaborx', chain: 'Avalanche', token_symbol: 'AVAX' },
  { name: 'Base', name_zh: 'Base', website: 'https://base.org', twitter: 'base', chain: 'Base', token_symbol: null },
  { name: 'Sui', name_zh: 'Sui', website: 'https://sui.io', twitter: 'SuiNetwork', chain: 'Sui', token_symbol: 'SUI' },
  { name: 'Aptos', name_zh: 'Aptos', website: 'https://aptoslabs.com', twitter: 'Aptos', chain: 'Aptos', token_symbol: 'APT' },
  { name: 'Cosmos', name_zh: 'Cosmos', website: 'https://cosmos.network', twitter: 'cosmos', chain: 'Cosmos', token_symbol: 'ATOM' },
  { name: 'Near Protocol', name_zh: 'Near', website: 'https://near.org', twitter: 'NEARProtocol', chain: 'Near', token_symbol: 'NEAR' },
  { name: 'Chainlink', name_zh: 'Chainlink', website: 'https://chain.link', twitter: 'chainlink', chain: 'Multi', token_symbol: 'LINK' },
  { name: 'Aave', name_zh: 'Aave', website: 'https://aave.com', twitter: 'aaborve', chain: 'Multi', token_symbol: 'AAVE' },
  { name: 'Lido', name_zh: 'Lido', website: 'https://lido.fi', twitter: 'LidoFinance', chain: 'Multi', token_symbol: 'LDO' },
  { name: 'MakerDAO', name_zh: 'MakerDAO', website: 'https://makerdao.com', twitter: 'MakerDAO', chain: 'Ethereum', token_symbol: 'MKR' },
  { name: 'Eigenlayer', name_zh: 'EigenLayer', website: 'https://www.eigenlayer.xyz', twitter: 'eigenlayer', chain: 'Ethereum', token_symbol: 'EIGEN' },
  { name: 'Pendle', name_zh: 'Pendle', website: 'https://www.pendle.finance', twitter: 'penabordle_fi', chain: 'Multi', token_symbol: 'PENDLE' },
  { name: 'Ethena', name_zh: 'Ethena', website: 'https://ethena.fi', twitter: 'ethena_labs', chain: 'Ethereum', token_symbol: 'ENA' },
  { name: 'Celestia', name_zh: 'Celestia', website: 'https://celestia.org', twitter: 'CelestiaOrg', chain: 'Celestia', token_symbol: 'TIA' },
  { name: 'Starknet', name_zh: 'Starknet', website: 'https://www.starknet.io', twitter: 'Starknet', chain: 'Starknet', token_symbol: 'STRK' },
  { name: 'zkSync', name_zh: 'zkSync', website: 'https://zksync.io', twitter: 'zksync', chain: 'zkSync', token_symbol: 'ZK' },
  { name: 'Monad', name_zh: 'Monad', website: 'https://www.monad.xyz', twitter: 'monad_xyz', chain: 'Monad', token_symbol: null },
  { name: 'Berachain', name_zh: 'Berachain', website: 'https://www.berachain.com', twitter: 'berachain', chain: 'Berachain', token_symbol: 'BERA' },
  { name: 'Movement', name_zh: 'Movement', website: 'https://movementlabs.xyz', twitter: 'MovementLabsXYZ', chain: 'Movement', token_symbol: 'MOVE' },
  { name: 'Sei', name_zh: 'Sei', website: 'https://www.sei.io', twitter: 'SeiNetwork', chain: 'Sei', token_symbol: 'SEI' },
  { name: 'Mantle', name_zh: 'Mantle', website: 'https://www.mantle.xyz', twitter: 'mantaborle', chain: 'Mantle', token_symbol: 'MNT' },
  { name: 'Scroll', name_zh: 'Scroll', website: 'https://scroll.io', twitter: 'Scroll_ZKP', chain: 'Scroll', token_symbol: 'SCR' },
  { name: 'Blast', name_zh: 'Blast', website: 'https://blast.io', twitter: 'Blast_L2', chain: 'Blast', token_symbol: 'BLAST' },
  { name: 'Worldcoin', name_zh: 'Worldcoin', website: 'https://worldcoin.org', twitter: 'worldcoin', chain: 'Multi', token_symbol: 'WLD' },
  { name: 'Pyth Network', name_zh: 'Pyth', website: 'https://pyth.network', twitter: 'PythNetwork', chain: 'Multi', token_symbol: 'PYTH' },
]

async function seed() {
  console.log('Seeding exchanges...')
  const exchangeRows = EXCHANGES.map(e => ({ ...e, category: 'exchange', description: `${e.name} cryptocurrency exchange`, description_zh: `${e.name_zh}加密货币交易所` }))
  const { error: e1 } = await supabase.from('institutions').insert(exchangeRows).select()
  if (e1) console.error('Exchange error:', e1.message)
  else console.log(`  ${exchangeRows.length} exchanges inserted`)

  console.log('Seeding VCs...')
  const vcRows = VCS.map(v => ({ ...v, category: 'fund', description: `${v.name} - crypto venture capital`, description_zh: `${v.name_zh} - 加密风投基金` }))
  const { error: e2 } = await supabase.from('institutions').insert(vcRows).select()
  if (e2) console.error('VC error:', e2.message)
  else console.log(`  ${vcRows.length} VCs inserted`)

  console.log('Seeding projects...')
  const projectRows = PROJECTS.map(p => ({ ...p, category: 'project', description: `${p.name} blockchain project`, description_zh: `${p.name_zh}区块链项目` }))
  const { error: e3 } = await supabase.from('institutions').insert(projectRows).select()
  if (e3) console.error('Project error:', e3.message)
  else console.log(`  ${projectRows.length} projects inserted`)

  console.log('Done!')
}

seed().catch(console.error)
