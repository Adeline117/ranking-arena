#!/usr/bin/env node
// Phase 1: Fill known crypto whitepaper/regulatory document PDF URLs
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE';
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// Map title patterns to known PDF/content URLs
const WHITEPAPER_URLS = {
  'Ethereum Whitepaper': 'https://ethereum.org/en/whitepaper/',
  'MakerDAO Whitepaper': 'https://makerdao.com/en/whitepaper/',
  'MakerDAO Multi-Collateral Dai (MCD) System': 'https://docs.makerdao.com/',
  'MakerDAO Multi-Collateral Dai (MCD) Technical': 'https://docs.makerdao.com/',
  'MakerDAO Endgame': 'https://forum.makerdao.com/t/the-endgame-plan-parts-1-2/20461',
  'Aave Protocol Whitepaper': 'https://docs.aave.com/developers/v/1.0',
  'Tether: Fiat currencies': 'https://assets.ctfassets.net/vyse88cgwfbl/5UWgHMvz071t2Cq5jKw5gk/3f0cdd7e4c4e07cebcf85e05e054dab3/TetherWhitePaper.pdf',
  'Monero: CryptoNote': 'https://www.getmonero.org/resources/research-lab/pubs/cryptonote-whitepaper.pdf',
  'Near Protocol Whitepaper': 'https://near.org/papers/the-official-near-white-paper',
  'Cardano: A Decentralized': 'https://docs.cardano.org/about-cardano/introduction/',
  'Dogecoin Reference': 'https://github.com/dogecoin/dogecoin',
  'Compound III (Comet)': 'https://docs.compound.finance/',
  'Lido Finance: Liquid Staking': 'https://lido.fi/static/Lido:Ethereum-Liquid-Staking.pdf',
  'Lido V2: Staking Router': 'https://docs.lido.fi/contracts/staking-router',
  'Rocket Pool: Decentralized': 'https://docs.rocketpool.net/overview/explainer',
  'Uniswap V4 Core': 'https://docs.uniswap.org/',
  'SushiSwap: A Decentralized': 'https://docs.sushi.com/',
  'PancakeSwap: Decentralized': 'https://docs.pancakeswap.finance/',
  'Synthetix: Decentralized Synthetic': 'https://docs.synthetix.io/',
  'Synthetix Litepaper': 'https://docs.synthetix.io/synthetix-protocol/the-synthetix-protocol/synthetix-litepaper',
  'Synthetix V3': 'https://docs.synthetix.io/',
  'Yearn Finance: Yield Optimization': 'https://docs.yearn.fi/',
  'Yearn Finance Blue Paper': 'https://docs.yearn.fi/',
  'dYdX: Decentralized Perpetuals': 'https://docs.dydx.exchange/',
  'dYdX V4: Standalone': 'https://docs.dydx.exchange/',
  'Balancer V2 Whitepaper': 'https://docs.balancer.fi/concepts/overview/basics.html',
  'The Graph: A Decentralized': 'https://thegraph.com/docs/',
  'The Graph: An Indexing': 'https://thegraph.com/docs/',
  'Optimism: A Layer 2': 'https://docs.optimism.io/',
  'Optimism Bedrock': 'https://docs.optimism.io/',
  'StarkNet: A Permissionless': 'https://docs.starknet.io/',
  'Polygon zkEVM': 'https://docs.polygon.technology/zkEVM/',
  'zkSync Era': 'https://docs.zksync.io/',
  'Celestia: Modular Data': 'https://docs.celestia.org/',
  'Injective Protocol': 'https://docs.injective.network/',
  'THORChain: Cross-Chain': 'https://docs.thorchain.org/',
  'Frax Finance': 'https://docs.frax.finance/',
  'Pendle Finance': 'https://docs.pendle.finance/',
  'GMX V2': 'https://docs.gmx.io/',
  'Hyperliquid': 'https://hyperliquid.gitbook.io/hyperliquid-docs',
  'Jupiter: Solana DEX': 'https://docs.jup.ag/',
  'Raydium: Hybrid AMM': 'https://docs.raydium.io/',
  'Orca: Concentrated Liquidity': 'https://docs.orca.so/',
  'Osmosis: The AMM': 'https://docs.osmosis.zone/',
  'Jito: MEV-Optimized': 'https://docs.jito.network/',
  'Marinade Finance': 'https://docs.marinade.finance/',
  'Drift Protocol': 'https://docs.drift.trade/',
  'Stargate Finance': 'https://docs.stargate.finance/',
  'Ethena: Internet Bond': 'https://docs.ethena.fi/',
  'Morpho: Peer-to-Peer': 'https://docs.morpho.org/',
  'Sei Network': 'https://docs.sei.io/',
  'Monad: Parallel EVM': 'https://docs.monad.xyz/',
  'Berachain: Proof of Liquidity': 'https://docs.berachain.com/',
  'Centrifuge: Real World': 'https://docs.centrifuge.io/',
  'Goldfinch: Real-World': 'https://docs.goldfinch.finance/',
  'Maple Finance': 'https://docs.maple.finance/',
  'Radiant Capital': 'https://docs.radiant.capital/',
  'Convex Finance': 'https://docs.convexfinance.com/',
  'Aura Finance': 'https://docs.aura.finance/',
  'Prisma Finance': 'https://docs.prismafinance.com/',
  'Velodrome Finance': 'https://docs.velodrome.finance/',
  'Trader Joe: Liquidity': 'https://docs.traderjoexyz.com/',
  'Camelot DEX': 'https://docs.camelot.exchange/',
  'Vertex Protocol': 'https://docs.vertexprotocol.com/',
  'Kamino Finance': 'https://docs.kamino.finance/',
  'Tensor: Solana NFT': 'https://docs.tensor.trade/',
  'Blur: NFT Marketplace': 'https://docs.blur.foundation/',
  'Safe (Gnosis Safe)': 'https://docs.safe.global/',
  'Spark Protocol': 'https://docs.spark.fi/',
  '1inch Aggregation': 'https://docs.1inch.io/',
  'Shiba Inu: An Experiment': 'https://shibatoken.com/',
  'Pepe: A Deflationary': 'https://www.pepe.vip/',
  'Across Protocol': 'https://docs.across.to/',
  // Regulatory/SEC documents
  'EU MiCA Regulation': 'https://eur-lex.europa.eu/legal-content/EN/TXT/PDF/?uri=CELEX:32023R1114',
  'SEC Framework for Investment': 'https://www.sec.gov/corpfin/framework-investment-contract-analysis-digital-assets',
  'FATF Updated Guidance': 'https://www.fatf-gafi.org/content/dam/fatf-gafi/guidance/Updated-Guidance-VA-VASP.pdf',
  'SEC v. Ripple Labs': 'https://www.sec.gov/litigation/complaints/2020/comp-pr2020-338.pdf',
  'SEC Staff Accounting Bulletin SAB 121': 'https://www.sec.gov/oca/staff-accounting-bulletin-121',
  'US Treasury: Illicit Finance': 'https://home.treasury.gov/system/files/136/DeFi-Risk-Full-Review.pdf',
  'IRS Crypto Tax Reporting': 'https://www.irs.gov/pub/irs-drop/reg-122793-19.pdf',
};

async function main() {
  const { data: items, error } = await sb
    .from('library_items')
    .select('id, title')
    .eq('category', 'whitepaper')
    .is('pdf_url', null);

  if (error) { console.error(error); return; }
  console.log(`Found ${items.length} whitepapers without pdf_url`);

  let updated = 0;
  for (const item of items) {
    // Find matching URL by title prefix
    const match = Object.entries(WHITEPAPER_URLS).find(([prefix]) => 
      item.title.startsWith(prefix)
    );
    if (match) {
      const { error: ue } = await sb
        .from('library_items')
        .update({ pdf_url: match[1] })
        .eq('id', item.id);
      if (!ue) {
        updated++;
        console.log(`✓ ${item.title}`);
      }
    } else {
      console.log(`✗ No URL for: ${item.title}`);
    }
  }
  console.log(`\nUpdated ${updated}/${items.length} whitepapers`);
}

main();
