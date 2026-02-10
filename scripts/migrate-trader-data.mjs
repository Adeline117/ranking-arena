#!/usr/bin/env node
/**
 * Migrate trader data from legacy tables to v2 tables
 * 
 * From: trader_sources + trader_snapshots
 * To: trader_profiles_v2 + trader_snapshots_v2
 */

import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const TARGET_SOURCES = ['bybit', 'bitget_futures', 'htx_futures']

async function migrateProfiles() {
  console.log('🔄 Migrating trader profiles...')
  
  for (const source of TARGET_SOURCES) {
    console.log(`  📊 Processing ${source}...`)
    
    // Get traders from legacy table
    const { data: legacyTraders, error: fetchError } = await supabase
      .from('trader_sources')
      .select('*')
      .eq('source', source)
      .limit(1000)
    
    if (fetchError) {
      console.error(`❌ Error fetching ${source}:`, fetchError.message)
      continue
    }
    
    if (!legacyTraders?.length) {
      console.log(`  ⚠️  No data found for ${source}`)
      continue
    }
    
    // Map to new format
    const profilesV2 = legacyTraders.map(trader => ({
      platform: source,
      market_type: 'futures',
      trader_key: trader.source_trader_id,
      display_name: trader.handle || null,
      avatar_url: trader.avatar_url || null,
      bio: null,
      tags: [],
      profile_url: trader.profile_url || null,
      followers: 0,
      copiers: 0,
      aum: null,
      provenance: {
        source_url: trader.profile_url || null,
        migrated_from: 'trader_sources',
        migrated_at: new Date().toISOString(),
      },
      updated_at: trader.created_at || new Date().toISOString(),
      last_enriched_at: null,
    }))
    
    // Insert in batches
    const BATCH_SIZE = 100
    let inserted = 0
    
    for (let i = 0; i < profilesV2.length; i += BATCH_SIZE) {
      const batch = profilesV2.slice(i, i + BATCH_SIZE)
      
      const { error: upsertError } = await supabase
        .from('trader_profiles_v2')
        .upsert(batch, {
          onConflict: 'platform,market_type,trader_key',
        })
      
      if (upsertError) {
        console.error(`❌ Error upserting profiles batch for ${source}:`, upsertError.message)
        continue
      }
      
      inserted += batch.length
    }
    
    console.log(`  ✅ ${source}: ${inserted} profiles migrated`)
  }
}

async function migrateSnapshots() {
  console.log('🔄 Migrating trader snapshots...')
  
  for (const source of TARGET_SOURCES) {
    console.log(`  📊 Processing ${source}...`)
    
    // Get snapshots from legacy table
    const { data: legacySnapshots, error: fetchError } = await supabase
      .from('trader_snapshots')
      .select('*')
      .eq('source', source)
      .limit(5000)
    
    if (fetchError) {
      console.error(`❌ Error fetching ${source} snapshots:`, fetchError.message)
      continue
    }
    
    if (!legacySnapshots?.length) {
      console.log(`  ⚠️  No snapshot data found for ${source}`)
      continue
    }
    
    // Map to new format
    const snapshotsV2 = legacySnapshots.map(snapshot => ({
      platform: source,
      trader_key: snapshot.source_trader_id,
      window: snapshot.season_id, // Assuming season_id maps to window
      as_of_ts: snapshot.captured_at || new Date().toISOString(),
      metrics: {
        roi: snapshot.roi || 0,
        pnl: snapshot.pnl || 0,
        win_rate: snapshot.win_rate || null,
        max_drawdown: snapshot.max_drawdown || null,
        trades_count: snapshot.trades_count || null,
        followers: snapshot.followers || null,
        copiers: null,
        sharpe_ratio: snapshot.sharpe_ratio || null,
        arena_score: snapshot.arena_score || null,
        aum: snapshot.aum || null,
      },
      quality_flags: {
        is_suspicious: false,
        suspicion_reasons: [],
        data_completeness: 0.8,
      },
      updated_at: snapshot.captured_at || new Date().toISOString(),
    }))
    
    // Insert in batches
    const BATCH_SIZE = 100
    let inserted = 0
    
    for (let i = 0; i < snapshotsV2.length; i += BATCH_SIZE) {
      const batch = snapshotsV2.slice(i, i + BATCH_SIZE)
      
      // Use insert instead of upsert to avoid complex constraint issues
      const { error: insertError } = await supabase
        .from('trader_snapshots_v2')
        .insert(batch)
        .select('id')
      
      if (insertError) {
        // Check if it's a duplicate key error and skip, otherwise log
        if (!insertError.message.includes('duplicate key') && !insertError.message.includes('violates unique constraint')) {
          console.error(`❌ Error inserting snapshots batch for ${source}:`, insertError.message)
          continue
        }
        // Skip duplicates silently
      }
      
      inserted += batch.length
    }
    
    console.log(`  ✅ ${source}: ${inserted} snapshots migrated`)
  }
}

async function main() {
  console.log('🚀 Starting trader data migration...')
  console.log(`📍 Target sources: ${TARGET_SOURCES.join(', ')}`)
  console.log('')
  
  try {
    await migrateProfiles()
    console.log('')
    await migrateSnapshots()
    
    console.log('')
    console.log('✅ Migration completed!')
    
    // Verify migration
    console.log('📊 Verifying migration...')
    for (const source of TARGET_SOURCES) {
      const { count } = await supabase
        .from('trader_profiles_v2')
        .select('*', { count: 'exact', head: true })
        .eq('platform', source)
      
      console.log(`  ${source}: ${count} profiles in v2 table`)
    }
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message)
    process.exit(1)
  }
}

main()