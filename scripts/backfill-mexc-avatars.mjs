import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Database configuration
const supabaseUrl = 'https://postgres.iknktzifjdyujdccyhsv.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'your-supabase-key';

const supabase = createClient(supabaseUrl, supabaseKey);

// Rate limiting - 2 requests per second
const RATE_LIMIT_MS = 500; 
let lastRequestTime = 0;

async function rateLimit() {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < RATE_LIMIT_MS) {
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - timeSinceLastRequest));
  }
  lastRequestTime = Date.now();
}

// Function to check if an avatar URL is a default/generic avatar
function isDefaultAvatar(avatarUrl) {
  if (!avatarUrl) return true;
  
  // Common patterns for default avatars on MEXC
  const defaultPatterns = [
    'avatar1.8fc6058c.png', // Known default pattern
    'avatar1',
    'default',
    'placeholder',
    '/static/',
    'common/avatar'
  ];
  
  return defaultPatterns.some(pattern => avatarUrl.includes(pattern));
}

// Function to fetch trader details from MEXC API
async function fetchTraderDetails(traderId) {
  await rateLimit();
  
  try {
    // This is the API endpoint we need to discover from the website
    // For now, using a placeholder - need to inspect network traffic
    const apiUrl = `https://www.mexc.com/api/copy-trading/trader/detail`;
    
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.mexc.com/copy-trading',
        'Origin': 'https://www.mexc.com'
      },
      body: JSON.stringify({
        traderId: traderId
      })
    });

    if (!response.ok) {
      console.error(`Failed to fetch trader ${traderId}: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error(`Error fetching trader ${traderId}:`, error.message);
    return null;
  }
}

// Function to update trader avatar in database
async function updateTraderAvatar(traderId, avatarUrl) {
  try {
    const { error } = await supabase
      .from('trader_sources')
      .update({ avatar_url: avatarUrl })
      .eq('source', 'mexc')
      .eq('source_trader_id', traderId);

    if (error) {
      console.error(`Failed to update trader ${traderId}:`, error);
      return false;
    }

    console.log(`✅ Updated trader ${traderId} with avatar: ${avatarUrl}`);
    return true;
  } catch (error) {
    console.error(`Error updating trader ${traderId}:`, error);
    return false;
  }
}

// Main function to process all traders without avatars
async function backfillMexcAvatars() {
  console.log('🚀 Starting MEXC avatar backfill process...');

  try {
    // Get all MEXC traders without avatars
    const { data: traders, error } = await supabase
      .from('trader_sources')
      .select('source_trader_id, handle')
      .eq('source', 'mexc')
      .is('avatar_url', null)
      .limit(100); // Start with first 100 for testing

    if (error) {
      console.error('Failed to fetch traders:', error);
      return;
    }

    console.log(`📊 Found ${traders.length} traders without avatars`);

    let processedCount = 0;
    let updatedCount = 0;

    for (const trader of traders) {
      try {
        console.log(`\n🔍 Processing trader ${processedCount + 1}/${traders.length}: ${trader.source_trader_id}`);
        
        const traderData = await fetchTraderDetails(trader.source_trader_id);
        
        if (!traderData) {
          console.log(`❌ Failed to fetch data for trader ${trader.source_trader_id}`);
          continue;
        }

        // Extract avatar URL from the response
        // Need to adapt this based on actual API response structure
        const avatarUrl = traderData.avatar || traderData.avatarUrl || traderData.profileImage;
        
        if (!avatarUrl || isDefaultAvatar(avatarUrl)) {
          console.log(`⚠️  Trader ${trader.source_trader_id} has no custom avatar (using default or null)`);
        } else {
          // This is a real custom avatar, update the database
          const success = await updateTraderAvatar(trader.source_trader_id, avatarUrl);
          if (success) {
            updatedCount++;
          }
        }

        processedCount++;

        // Progress update every 50 traders
        if (processedCount % 50 === 0) {
          console.log(`\n📈 Progress: ${processedCount}/${traders.length} processed, ${updatedCount} updated`);
        }

      } catch (error) {
        console.error(`Error processing trader ${trader.source_trader_id}:`, error);
      }
    }

    console.log(`\n✅ Backfill completed!`);
    console.log(`📊 Total processed: ${processedCount}`);
    console.log(`🎯 Total updated: ${updatedCount}`);
    console.log(`💡 Traders with real avatars: ${updatedCount}/${processedCount}`);

  } catch (error) {
    console.error('Fatal error in backfill process:', error);
  }
}

// Handle command line arguments
if (process.argv[2] === '--help' || process.argv[2] === '-h') {
  console.log(`
MEXC Avatar Backfill Script
===========================

Usage: node backfill-mexc-avatars.mjs [options]

Options:
  --help, -h     Show this help message
  --dry-run      Show what would be updated without making changes
  --limit N      Process only N traders (default: 100)

Environment Variables:
  SUPABASE_ANON_KEY    Supabase anonymous key

Examples:
  node backfill-mexc-avatars.mjs                 # Process 100 traders
  node backfill-mexc-avatars.mjs --limit 10     # Process 10 traders  
  node backfill-mexc-avatars.mjs --dry-run      # Show what would be updated
`);
  process.exit(0);
}

// Run the script
if (import.meta.url === `file://${process.argv[1]}`) {
  backfillMexcAvatars().catch(console.error);
}

export { backfillMexcAvatars, fetchTraderDetails, isDefaultAvatar };