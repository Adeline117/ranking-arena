#!/usr/bin/env node
// Bulk seed library with known crypto whitepapers, books, and research
import pg from 'pg'

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'

const whitepapers = [
  { title: 'Bitcoin: A Peer-to-Peer Electronic Cash System', author: 'Satoshi Nakamoto', pdf_url: 'https://bitcoin.org/bitcoin.pdf', crypto_symbols: ['BTC'], publish_date: '2008-10-31', subcategory: 'blockchain' },
  { title: 'Ethereum Whitepaper', author: 'Vitalik Buterin', source_url: 'https://ethereum.org/en/whitepaper/', crypto_symbols: ['ETH'], publish_date: '2013-12-01', subcategory: 'blockchain' },
  { title: 'Solana: A new architecture for a high performance blockchain', author: 'Anatoly Yakovenko', pdf_url: 'https://solana.com/solana-whitepaper.pdf', crypto_symbols: ['SOL'], subcategory: 'blockchain' },
  { title: 'Polkadot: Vision for a Heterogeneous Multi-Chain Framework', author: 'Gavin Wood', pdf_url: 'https://polkadot.network/PolkaDotPaper.pdf', crypto_symbols: ['DOT'], subcategory: 'blockchain' },
  { title: 'Cardano: A Decentralized Public Blockchain and Cryptocurrency', author: 'Charles Hoskinson', source_url: 'https://docs.cardano.org/about-cardano/introduction', crypto_symbols: ['ADA'], subcategory: 'blockchain' },
  { title: 'Chainlink 2.0: Next Steps in the Evolution of Decentralized Oracle Networks', author: 'Sergey Nazarov et al.', pdf_url: 'https://chain.link/whitepaper', crypto_symbols: ['LINK'], subcategory: 'oracle' },
  { title: 'Avalanche Platform Whitepaper', author: 'Team Rocket', pdf_url: 'https://assets.website-files.com/5d80307810123f5ffbb34d6e/6008d7bbf8b10d1eb01e7e16_Avalanche%20Platform%20Whitepaper.pdf', crypto_symbols: ['AVAX'], subcategory: 'blockchain' },
  { title: 'Cosmos: A Network of Distributed Ledgers', author: 'Jae Kwon, Ethan Buchman', pdf_url: 'https://v1.cosmos.network/resources/whitepaper', crypto_symbols: ['ATOM'], subcategory: 'blockchain' },
  { title: 'Uniswap v2 Core', author: 'Hayden Adams et al.', pdf_url: 'https://uniswap.org/whitepaper.pdf', crypto_symbols: ['UNI'], subcategory: 'defi' },
  { title: 'Uniswap v3 Core', author: 'Hayden Adams et al.', pdf_url: 'https://uniswap.org/whitepaper-v3.pdf', crypto_symbols: ['UNI'], subcategory: 'defi' },
  { title: 'Aave Protocol Whitepaper v1', author: 'Aave Team', source_url: 'https://github.com/aave/aave-protocol', crypto_symbols: ['AAVE'], subcategory: 'defi' },
  { title: 'Compound: The Money Market Protocol', author: 'Robert Leshner, Geoffrey Hayes', pdf_url: 'https://compound.finance/documents/Compound.Whitepaper.pdf', crypto_symbols: ['COMP'], subcategory: 'defi' },
  { title: 'MakerDAO Multi-Collateral Dai (MCD) System', author: 'MakerDAO', source_url: 'https://makerdao.com/en/whitepaper/', crypto_symbols: ['MKR', 'DAI'], subcategory: 'defi' },
  { title: 'Curve Finance Whitepaper', author: 'Michael Egorov', pdf_url: 'https://curve.fi/whitepaper', crypto_symbols: ['CRV'], subcategory: 'defi' },
  { title: 'Lido: Liquid Staking Protocol', author: 'Lido Team', source_url: 'https://lido.fi/static/Lido:Ethereum-Liquid-Staking.pdf', crypto_symbols: ['LDO'], subcategory: 'defi' },
  { title: 'Filecoin: A Decentralized Storage Network', author: 'Protocol Labs', pdf_url: 'https://filecoin.io/filecoin.pdf', crypto_symbols: ['FIL'], subcategory: 'storage' },
  { title: 'IPFS - Content Addressed, Versioned, P2P File System', author: 'Juan Benet', pdf_url: 'https://ipfs.io/ipfs/QmR7GSQM93Cx5eAg6a6yRzNde1FQv7uL6X1o4k7zrJa3LX/ipfs.draft3.pdf', subcategory: 'storage' },
  { title: 'Tether: Fiat currencies on the Bitcoin blockchain', author: 'Tether', source_url: 'https://tether.to/en/transparency', crypto_symbols: ['USDT'], subcategory: 'stablecoin' },
  { title: 'Litecoin: A Peer-to-Peer Cryptocurrency', author: 'Charlie Lee', source_url: 'https://litecoin.org/litecoin.pdf', crypto_symbols: ['LTC'], subcategory: 'blockchain' },
  { title: 'Monero: CryptoNote v2', author: 'Nicolas van Saberhagen', source_url: 'https://www.getmonero.org/resources/research-lab/', crypto_symbols: ['XMR'], subcategory: 'privacy' },
  { title: 'Zcash Protocol Specification', author: 'Daira Hopwood et al.', source_url: 'https://zips.z.cash/protocol/protocol.pdf', crypto_symbols: ['ZEC'], subcategory: 'privacy' },
  { title: 'Ripple Protocol Consensus Algorithm', author: 'David Schwartz et al.', source_url: 'https://ripple.com/files/ripple_consensus_whitepaper.pdf', crypto_symbols: ['XRP'], subcategory: 'blockchain' },
  { title: 'Stellar Consensus Protocol', author: 'David Mazières', pdf_url: 'https://www.stellar.org/papers/stellar-consensus-protocol.pdf', crypto_symbols: ['XLM'], subcategory: 'blockchain' },
  { title: 'Algorand: Scaling Byzantine Agreements for Cryptocurrencies', author: 'Yossi Gilad et al.', source_url: 'https://algorandcom.cdn.prismic.io/algorandcom/ece77f38-75b3-44de-bc7f-805f0e53a8d9_theoretical.pdf', crypto_symbols: ['ALGO'], subcategory: 'blockchain' },
  { title: 'Near Protocol Whitepaper', author: 'Alexander Skidanov, Illia Polosukhin', source_url: 'https://near.org/papers/the-official-near-white-paper/', crypto_symbols: ['NEAR'], subcategory: 'blockchain' },
  { title: 'Arbitrum Rollup Protocol', author: 'Harry Kalodner et al.', source_url: 'https://github.com/OffchainLabs/nitro/blob/master/docs/Nitro-whitepaper.pdf', crypto_symbols: ['ARB'], subcategory: 'layer2' },
  { title: 'Optimism: A Layer 2 Scaling Solution', author: 'Optimism Team', source_url: 'https://community.optimism.io/docs/protocol/', crypto_symbols: ['OP'], subcategory: 'layer2' },
  { title: 'Polygon (Matic) Whitepaper', author: 'Jaynti Kanani et al.', source_url: 'https://polygon.technology/lightpaper-polygon.pdf', crypto_symbols: ['MATIC', 'POL'], subcategory: 'layer2' },
  { title: 'The Graph: An Indexing Protocol for Querying Networks', author: 'Yaniv Tal et al.', source_url: 'https://thegraph.com/docs/', crypto_symbols: ['GRT'], subcategory: 'infrastructure' },
  { title: 'SushiSwap: A Decentralized Exchange', author: 'Chef Nomi', source_url: 'https://docs.sushi.com/', crypto_symbols: ['SUSHI'], subcategory: 'defi' },
  { title: 'PancakeSwap: Decentralized Exchange on BSC', author: 'PancakeSwap Team', source_url: 'https://docs.pancakeswap.finance/', crypto_symbols: ['CAKE'], subcategory: 'defi' },
  { title: 'Yearn Finance: Yield Optimization Protocol', author: 'Andre Cronje', source_url: 'https://docs.yearn.finance/', crypto_symbols: ['YFI'], subcategory: 'defi' },
  { title: 'Synthetix: Decentralized Synthetic Assets', author: 'Kain Warwick', source_url: 'https://docs.synthetix.io/litepaper/', crypto_symbols: ['SNX'], subcategory: 'defi' },
  { title: 'dYdX: Decentralized Perpetuals Exchange', author: 'dYdX Team', source_url: 'https://docs.dydx.exchange/', crypto_symbols: ['DYDX'], subcategory: 'defi' },
  { title: 'Aptos: The Aptos Blockchain', author: 'Aptos Labs', pdf_url: 'https://aptos.dev/aptos-white-paper/aptos-white-paper-in-korean/', crypto_symbols: ['APT'], subcategory: 'blockchain' },
  { title: 'Sui: A Next-Generation Smart Contract Platform', author: 'Mysten Labs', source_url: 'https://docs.sui.io/paper/sui.pdf', crypto_symbols: ['SUI'], subcategory: 'blockchain' },
  { title: 'Toncoin: The Open Network', author: 'Nikolai Durov', source_url: 'https://ton.org/whitepaper.pdf', crypto_symbols: ['TON'], subcategory: 'blockchain' },
  { title: 'Dogecoin Reference Implementation', author: 'Billy Markus, Jackson Palmer', source_url: 'https://github.com/dogecoin/dogecoin', crypto_symbols: ['DOGE'], subcategory: 'blockchain' },
  { title: 'Shiba Inu: An Experiment in Decentralized Community Building', author: 'Ryoshi', source_url: 'https://shibatoken.com/', crypto_symbols: ['SHIB'], subcategory: 'meme' },
  { title: 'Pepe: A Deflationary Memecoin', author: 'Pepe Team', source_url: 'https://www.pepe.vip/', crypto_symbols: ['PEPE'], subcategory: 'meme' },
]

const books = [
  { title: 'Mastering Bitcoin: Programming the Open Blockchain', author: 'Andreas M. Antonopoulos', isbn: '9781491954386', publish_date: '2017-06-01', tags: ['bitcoin', 'development'] },
  { title: 'Mastering Ethereum: Building Smart Contracts and DApps', author: 'Andreas M. Antonopoulos, Gavin Wood', isbn: '9781491971949', publish_date: '2018-11-01', tags: ['ethereum', 'development'] },
  { title: 'The Bitcoin Standard: The Decentralized Alternative to Central Banking', author: 'Saifedean Ammous', isbn: '9781119473862', publish_date: '2018-03-23', tags: ['bitcoin', 'economics'] },
  { title: 'Cryptoassets: The Innovative Investor\'s Guide', author: 'Chris Burniske, Jack Tatar', isbn: '9781260026672', publish_date: '2018-01-01', tags: ['investing', 'crypto'] },
  { title: 'Digital Gold: Bitcoin and the Inside Story of the Misfits and Millionaires', author: 'Nathaniel Popper', isbn: '9780062362490', publish_date: '2015-05-19', tags: ['bitcoin', 'history'] },
  { title: 'The Age of Cryptocurrency', author: 'Paul Vigna, Michael J. Casey', isbn: '9781250065636', publish_date: '2015-01-27', tags: ['bitcoin', 'history'] },
  { title: 'Blockchain Revolution', author: 'Don Tapscott, Alex Tapscott', isbn: '9781101980132', publish_date: '2016-05-10', tags: ['blockchain', 'business'] },
  { title: 'The Infinite Machine: How an Army of Crypto-hackers Is Building the Next Internet with Ethereum', author: 'Camila Russo', isbn: '9780062886149', publish_date: '2020-07-14', tags: ['ethereum', 'history'] },
  { title: 'Out of the Ether: The Amazing Story of Ethereum and the $55 Million Heist', author: 'Matthew Leising', isbn: '9781119602934', publish_date: '2020-09-29', tags: ['ethereum', 'history'] },
  { title: 'DeFi and the Future of Finance', author: 'Campbell R. Harvey, Ashwin Ramachandran, Joey Santoro', isbn: '9781119836018', publish_date: '2021-08-24', tags: ['defi', 'finance'] },
  { title: 'How to DeFi: Beginner', author: 'CoinGecko', publish_date: '2021-06-01', tags: ['defi', 'beginner'] },
  { title: 'How to DeFi: Advanced', author: 'CoinGecko', publish_date: '2021-07-01', tags: ['defi', 'advanced'] },
  { title: 'Token Economy: How the Web3 reinvents the Internet', author: 'Shermin Voshmgir', isbn: '9783982103815', publish_date: '2020-06-01', tags: ['tokenomics', 'web3'] },
  { title: 'The Basics of Bitcoins and Blockchains', author: 'Antony Lewis', isbn: '9781633538009', publish_date: '2018-08-15', tags: ['bitcoin', 'beginner'] },
  { title: 'Bubble or Revolution: The Present and Future of Blockchain', author: 'Neel Mehta, Aditya Agashe, Parth Detroja', isbn: '9780578528151', publish_date: '2019-10-01', tags: ['blockchain', 'analysis'] },
  { title: 'Programming Bitcoin: Learn How to Program Bitcoin from Scratch', author: 'Jimmy Song', isbn: '9781492031499', publish_date: '2019-02-01', tags: ['bitcoin', 'development'] },
  { title: 'Hands-On Smart Contract Development with Solidity and Ethereum', author: 'Kevin Solorio et al.', isbn: '9781492045267', publish_date: '2019-12-01', tags: ['ethereum', 'solidity'] },
  { title: 'Bitcoin Billionaires', author: 'Ben Mezrich', isbn: '9781250217745', publish_date: '2019-05-21', tags: ['bitcoin', 'history'] },
  { title: 'The Truth Machine: The Blockchain and the Future of Everything', author: 'Paul Vigna, Michael J. Casey', isbn: '9781250114570', publish_date: '2018-02-27', tags: ['blockchain', 'future'] },
  { title: 'Kings of Crypto: One Startup\'s Quest to Take Cryptocurrency Out of Silicon Valley', author: 'Jeff John Roberts', isbn: '9781647820152', publish_date: '2020-12-15', tags: ['coinbase', 'history'] },
  { title: 'Layered Money: From Gold and Dollars to Bitcoin and Central Bank Digital Currencies', author: 'Nik Bhatia', isbn: '9781736110522', publish_date: '2021-01-18', tags: ['bitcoin', 'money'] },
  { title: 'The Blocksize War: The battle over who controls Bitcoin\'s protocol rules', author: 'Jonathan Bier', isbn: '9798752469816', publish_date: '2021-03-28', tags: ['bitcoin', 'governance'] },
  { title: 'Quantitative Trading: How to Build Your Own Algorithmic Trading Business', author: 'Ernest P. Chan', isbn: '9781119800064', publish_date: '2021-07-06', tags: ['trading', 'quantitative'] },
  { title: 'Advances in Financial Machine Learning', author: 'Marcos López de Prado', isbn: '9781119482086', publish_date: '2018-01-23', tags: ['machine-learning', 'trading'] },
  { title: 'Machine Learning for Algorithmic Trading', author: 'Stefan Jansen', isbn: '9781839217715', publish_date: '2020-07-31', tags: ['machine-learning', 'trading'] },
  { title: 'Technical Analysis of the Financial Markets', author: 'John J. Murphy', isbn: '9780735200661', publish_date: '1999-01-01', tags: ['technical-analysis', 'trading'] },
  { title: 'Market Wizards: Interviews with Top Traders', author: 'Jack D. Schwager', isbn: '9781118273050', publish_date: '2012-02-01', tags: ['trading', 'interviews'] },
  { title: 'A Random Walk Down Wall Street', author: 'Burton G. Malkiel', isbn: '9781324002185', publish_date: '2019-01-01', tags: ['investing', 'markets'] },
  { title: 'Flash Boys: A Wall Street Revolt', author: 'Michael Lewis', isbn: '9780393351590', publish_date: '2014-03-31', tags: ['trading', 'hft'] },
  { title: 'The Man Who Solved the Market', author: 'Gregory Zuckerman', isbn: '9780735217980', publish_date: '2019-11-05', tags: ['quantitative', 'trading'] },
]

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()

  let count = 0

  for (const wp of whitepapers) {
    try {
      await client.query(`
        INSERT INTO library_items (title, author, description, category, subcategory, source, source_url, pdf_url, language, tags, crypto_symbols, publish_date, is_free)
        VALUES ($1,$2,$3,'whitepaper',$4,'manual',$5,$6,'en',$7,$8,$9,true)
        ON CONFLICT DO NOTHING
      `, [
        wp.title, wp.author, `Official whitepaper for ${wp.title}`,
        wp.subcategory || 'blockchain', wp.source_url || null, wp.pdf_url || null,
        wp.tags || [], wp.crypto_symbols || [], wp.publish_date || null
      ])
      count++
    } catch (e) { /* skip */ }
  }

  for (const book of books) {
    try {
      await client.query(`
        INSERT INTO library_items (title, author, description, category, subcategory, source, language, tags, isbn, publish_date, is_free, buy_url)
        VALUES ($1,$2,$3,'book','trading','manual','en',$4,$5,$6,false,$7)
        ON CONFLICT DO NOTHING
      `, [
        book.title, book.author, `${book.title} by ${book.author}`,
        book.tags || [], book.isbn || null, book.publish_date || null,
        book.isbn ? `https://www.google.com/books/edition/_/${book.isbn}` : null
      ])
      count++
    } catch (e) { /* skip */ }
  }

  const { rows } = await client.query('SELECT count(*) FROM library_items')
  console.log(`Inserted ${count} items. Total: ${rows[0].count}`)
  await client.end()
}

main().catch(e => { console.error(e); process.exit(1) })
