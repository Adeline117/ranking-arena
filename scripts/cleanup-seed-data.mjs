/**
 * Cleanup Script: Remove ALL seed/mock/fake data from production database
 * 
 * This script removes:
 * 1. Seed posts (from seed-sample-posts.mjs)
 * 2. Test users (from seed-community.ts) and their associated data
 * 3. Fake view_count data in library_items
 * 4. Seed leaderboard data (fake trader entries)
 * 5. Seed follows
 * 
 * Run: node scripts/cleanup-seed-data.mjs
 * 
 * REQUIRES: .env.local with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { resolve } from 'path'
import { config } from 'dotenv'

config({ path: resolve(process.cwd(), '.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing env: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const DRY_RUN = !process.argv.includes('--execute')

async function log(msg) {
  console.log(DRY_RUN ? `[DRY RUN] ${msg}` : msg)
}

// ─── 1. Remove seed posts ─────────────────────────────────────────────

// Author handles from seed-sample-posts.mjs
const SEED_POST_AUTHORS = [
  'crypto_analyst', 'defi_whale', 'swing_master', 'risk_analyst',
  'dex_trader', 'funding_watcher', 'copy_guru', 'macro_trader',
  'consistent_trader', 'gmx_fan', 'ta_mentor', 'perp_trader',
  'onchain_analyst', 'reformed_trader', 'arena_veteran',
]

async function cleanupSeedPosts() {
  log('\n=== Cleaning up seed posts ===')
  
  const { data, error } = await supabase
    .from('posts')
    .select('id, author_handle, title, content')
    .in('author_handle', SEED_POST_AUTHORS)

  if (error) { console.error('Error querying seed posts:', error.message); return }
  
  log(`Found ${data?.length || 0} seed posts`)
  
  if (data && data.length > 0) {
    for (const post of data) {
      log(`  - Post by @${post.author_handle}: "${(post.title || post.content || '').slice(0, 50)}..."`)
    }
    
    if (!DRY_RUN) {
      const postIds = data.map(p => p.id)
      
      // Delete associated comments first
      const { error: commErr } = await supabase
        .from('post_comments')
        .delete()
        .in('post_id', postIds)
      if (commErr) console.warn('  Warning deleting comments:', commErr.message)
      
      // Delete associated likes
      const { error: likeErr } = await supabase
        .from('post_likes')
        .delete()
        .in('post_id', postIds)
      if (likeErr) console.warn('  Warning deleting likes:', likeErr.message)
      
      // Delete associated bookmarks
      const { error: bmErr } = await supabase
        .from('post_bookmarks')
        .delete()
        .in('post_id', postIds)
      if (bmErr) console.warn('  Warning deleting bookmarks:', bmErr.message)

      // Delete the posts
      const { error: delErr } = await supabase
        .from('posts')
        .delete()
        .in('id', postIds)
      
      if (delErr) console.error('Error deleting seed posts:', delErr.message)
      else console.log(`  Deleted ${postIds.length} seed posts`)
    }
  }
}

// ─── 2. Remove test users from seed-community.ts ──────────────────────

const TEST_USER_EMAILS = [
  'grid01@test.com', 'futures02@test.com', 'swing03@test.com',
  'chain04@test.com', 'bag05@test.com', 'noob06@test.com',
  'allin07@test.com', 'dip08@test.com', 'slacker09@test.com',
  'health10@test.com', 'btcmax11@test.com', 'defi12@test.com',
  'nft13@test.com', 'quant14@test.com', 'whale15@test.com',
]

const TEST_USER_HANDLES = [
  '网格大师', '合约老手', '波段猎人', '链上侦探', '被套小王子',
  '韭菜日记', '梭哈勇士', '抄底达人', '摸鱼队长', '养生交易员',
  'BTCMaxi', 'DeFiFarmer', 'NFTDegen', 'QuantBot', 'WhaleWatcher',
]

async function cleanupTestUsers() {
  log('\n=== Cleaning up test users ===')
  
  // Find test users by handle in user_profiles
  const { data: profiles } = await supabase
    .from('user_profiles')
    .select('id, handle')
    .in('handle', TEST_USER_HANDLES)
  
  const testUserIds = (profiles || []).map(p => p.id)
  log(`Found ${testUserIds.length} test user profiles`)
  
  if (testUserIds.length > 0) {
    for (const p of profiles) {
      log(`  - @${p.handle} (${p.id})`)
    }
    
    if (!DRY_RUN) {
      // Delete their posts
      const { error: postErr } = await supabase
        .from('posts')
        .delete()
        .in('author_id', testUserIds)
      if (postErr) console.warn('  Warning deleting user posts:', postErr.message)
      
      // Delete their comments
      const { error: commErr } = await supabase
        .from('post_comments')
        .delete()
        .in('user_id', testUserIds)
      if (commErr) console.warn('  Warning deleting user comments:', commErr.message)
      
      // Delete their follows
      const { error: followErr1 } = await supabase
        .from('user_follows')
        .delete()
        .in('follower_id', testUserIds)
      if (followErr1) console.warn('  Warning deleting follows (follower):', followErr1.message)
      
      const { error: followErr2 } = await supabase
        .from('user_follows')
        .delete()
        .in('following_id', testUserIds)
      if (followErr2) console.warn('  Warning deleting follows (following):', followErr2.message)
      
      // Delete their group memberships
      const { error: gmErr } = await supabase
        .from('group_members')
        .delete()
        .in('user_id', testUserIds)
      if (gmErr) console.warn('  Warning deleting group memberships:', gmErr.message)
      
      // Delete their likes
      const { error: likeErr } = await supabase
        .from('post_likes')
        .delete()
        .in('user_id', testUserIds)
      if (likeErr) console.warn('  Warning deleting likes:', likeErr.message)
      
      // Delete their notifications
      const { error: notifErr } = await supabase
        .from('notifications')
        .delete()
        .in('user_id', testUserIds)
      if (notifErr) console.warn('  Warning deleting notifications:', notifErr.message)
      
      // Delete user profiles
      const { error: profErr } = await supabase
        .from('user_profiles')
        .delete()
        .in('id', testUserIds)
      if (profErr) console.warn('  Warning deleting profiles:', profErr.message)
      
      // Delete auth users (requires admin API)
      for (const uid of testUserIds) {
        const { error: authErr } = await supabase.auth.admin.deleteUser(uid)
        if (authErr) console.warn(`  Warning deleting auth user ${uid}:`, authErr.message)
      }
      
      console.log(`  Deleted ${testUserIds.length} test users and their data`)
    }
  }
}

// ─── 3. Reset fake view_count in library_items ────────────────────────

async function cleanupLibraryViewCounts() {
  log('\n=== Resetting library view_count to 0 ===')
  
  const { data, error } = await supabase
    .from('library_items')
    .select('id, title, view_count')
    .gt('view_count', 0)

  if (error) { console.error('Error querying library:', error.message); return }
  
  log(`Found ${data?.length || 0} items with view_count > 0`)
  
  if (data && data.length > 0 && !DRY_RUN) {
    const { error: updateErr } = await supabase
      .from('library_items')
      .update({ view_count: 0 })
      .gt('view_count', 0)
    
    if (updateErr) console.error('Error resetting view_count:', updateErr.message)
    else console.log(`  Reset view_count to 0 for ${data.length} items`)
  }
}

// ─── 4. Clean up seed leaderboard data ────────────────────────────────

// Fake trader keys from seed-leaderboard.ts
const FAKE_TRADER_KEYS = [
  '3A70E0F76B0C3E8AF18A99D3D2F53264',
  'B8D4E2A1C5F6789012345678ABCDEF01',
  'C9E5F3B2D6A7890123456789BCDEF012',
  'D0F6A4C3E7B8901234567890CDEF0123',
  'E1A7B5D4F8C9012345678901DEF01234',
  'F2B8C6E5A9D0123456789012EF012345',
  'A3C9D7F6B0E1234567890123F0123456',
  'B4D0E8A7C1F2345678901234A1234567',
]

async function cleanupSeedTraders() {
  log('\n=== Cleaning up seed leaderboard traders ===')
  
  // Check trader_sources
  const { data: sources } = await supabase
    .from('trader_sources')
    .select('id, source_trader_id, handle')
    .in('source_trader_id', FAKE_TRADER_KEYS)

  log(`Found ${sources?.length || 0} fake trader sources`)
  
  if (sources && sources.length > 0 && !DRY_RUN) {
    const { error } = await supabase
      .from('trader_sources')
      .delete()
      .in('source_trader_id', FAKE_TRADER_KEYS)
    if (error) console.warn('  Warning deleting fake traders:', error.message)
    else console.log(`  Deleted ${sources.length} fake trader sources`)
  }
  
  // Check trader_snapshots
  const { data: snapshots } = await supabase
    .from('trader_snapshots')
    .select('id, source_trader_id')
    .in('source_trader_id', FAKE_TRADER_KEYS)

  log(`Found ${snapshots?.length || 0} fake trader snapshots`)
  
  if (snapshots && snapshots.length > 0 && !DRY_RUN) {
    const { error } = await supabase
      .from('trader_snapshots')
      .delete()
      .in('source_trader_id', FAKE_TRADER_KEYS)
    if (error) console.warn('  Warning deleting fake snapshots:', error.message)
    else console.log(`  Deleted ${snapshots.length} fake trader snapshots`)
  }
}

// ─── 5. Find orphaned posts without real author_id ────────────────────

async function findOrphanedPosts() {
  log('\n=== Checking for orphaned posts (no author_id) ===')
  
  const { data, error } = await supabase
    .from('posts')
    .select('id, author_handle, title, content, created_at, author_id')
    .is('author_id', null)
    .limit(50)

  if (error) { console.error('Error:', error.message); return }
  
  log(`Found ${data?.length || 0} posts without author_id (likely seed data)`)
  
  if (data && data.length > 0) {
    for (const post of data) {
      log(`  - @${post.author_handle || '(none)'}: "${(post.title || post.content || '').slice(0, 60)}..." [${post.created_at}]`)
    }
    
    if (!DRY_RUN) {
      const postIds = data.map(p => p.id)
      
      // Delete associated data
      await supabase.from('post_comments').delete().in('post_id', postIds)
      await supabase.from('post_likes').delete().in('post_id', postIds)
      await supabase.from('post_bookmarks').delete().in('post_id', postIds)
      
      const { error: delErr } = await supabase
        .from('posts')
        .delete()
        .in('id', postIds)
      
      if (delErr) console.error('Error deleting orphaned posts:', delErr.message)
      else console.log(`  Deleted ${postIds.length} orphaned posts`)
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60))
  console.log('  SEED DATA CLEANUP SCRIPT')
  console.log('='.repeat(60))
  
  if (DRY_RUN) {
    console.log('\n  MODE: DRY RUN (no changes will be made)')
    console.log('  To execute, run: node scripts/cleanup-seed-data.mjs --execute\n')
  } else {
    console.log('\n  MODE: EXECUTE (changes WILL be made to the database)')
    console.log('  Press Ctrl+C within 5 seconds to cancel...\n')
    await new Promise(r => setTimeout(r, 5000))
  }
  
  await cleanupSeedPosts()
  await cleanupTestUsers()
  await cleanupLibraryViewCounts()
  await cleanupSeedTraders()
  await findOrphanedPosts()
  
  console.log('\n' + '='.repeat(60))
  if (DRY_RUN) {
    console.log('  DRY RUN COMPLETE. Run with --execute to apply changes.')
  } else {
    console.log('  CLEANUP COMPLETE.')
  }
  console.log('='.repeat(60))
}

main().catch(console.error)
