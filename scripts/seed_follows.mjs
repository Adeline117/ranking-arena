import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
import { resolve } from 'path'

dotenv.config({ path: resolve(process.cwd(), '.env.local') })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

async function main() {
  // Get all user profiles
  const { data: users, error } = await supabase
    .from('user_profiles')
    .select('id, handle')
    .order('created_at', { ascending: true })

  if (error) { console.error('Error fetching users:', error); return }
  console.log(`Found ${users.length} users`)

  if (users.length < 2) {
    console.log('Need at least 2 users to create follows')
    return
  }

  // Create follow relationships - each user follows 2-5 random others
  let insertCount = 0
  const follows = []
  for (let i = 0; i < users.length; i++) {
    const numFollows = 2 + Math.floor(Math.random() * 4) // 2-5
    const others = users.filter((_, j) => j !== i)
    const shuffled = others.sort(() => Math.random() - 0.5).slice(0, numFollows)
    for (const target of shuffled) {
      follows.push({ follower_id: users[i].id, following_id: target.id })
    }
  }

  // Insert follows (ignore duplicates)
  const { data: inserted, error: insertError } = await supabase
    .from('user_follows')
    .upsert(follows, { onConflict: 'follower_id,following_id', ignoreDuplicates: true })

  if (insertError) console.error('Insert error:', insertError)
  else console.log(`Inserted ${follows.length} follow relationships`)

  // Update follower/following counts
  for (const user of users) {
    const { count: followerCount } = await supabase
      .from('user_follows')
      .select('*', { count: 'exact', head: true })
      .eq('following_id', user.id)

    const { count: followingCount } = await supabase
      .from('user_follows')
      .select('*', { count: 'exact', head: true })
      .eq('follower_id', user.id)

    await supabase
      .from('user_profiles')
      .update({ follower_count: followerCount, following_count: followingCount })
      .eq('id', user.id)

    console.log(`${user.handle}: ${followerCount} followers, ${followingCount} following`)
  }

  // Half users: hide followers/following (privacy on)
  const halfIdx = Math.floor(users.length / 2)
  const privateUsers = users.slice(0, halfIdx)
  const publicUsers = users.slice(halfIdx)

  for (const u of privateUsers) {
    await supabase.from('user_profiles')
      .update({ show_followers: false, show_following: false })
      .eq('id', u.id)
  }
  for (const u of publicUsers) {
    await supabase.from('user_profiles')
      .update({ show_followers: true, show_following: true })
      .eq('id', u.id)
  }

  console.log(`\nPrivacy ON (hidden): ${privateUsers.map(u => u.handle).join(', ')}`)
  console.log(`Privacy OFF (visible): ${publicUsers.map(u => u.handle).join(', ')}`)
  console.log('Done!')
}

main()
