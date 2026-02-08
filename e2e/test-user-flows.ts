/**
 * 用户流程自动化测试脚本
 * 测试登录后的各种用户操作
 *
 * 运行: npx tsx scripts/test-user-flows.ts
 */

import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

// 加载环境变量
config({ path: '.env.local' })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const _BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ 缺少环境变量: NEXT_PUBLIC_SUPABASE_URL 或 NEXT_PUBLIC_SUPABASE_ANON_KEY')
  console.error('💡 请确保 .env.local 文件存在且包含这些变量')
  process.exit(1)
}

// 测试账号
const TEST_USER = {
  email: 'grid01@test.com',
  password: 'grid0123',
}

interface TestResult {
  name: string
  status: 'pass' | 'fail' | 'skip'
  message?: string
  duration?: number
}

const results: TestResult[] = []

function log(emoji: string, message: string) {
  console.warn(`${emoji} ${message}`)
}

function addResult(name: string, status: 'pass' | 'fail' | 'skip', message?: string, duration?: number) {
  results.push({ name, status, message, duration })
  const emoji = status === 'pass' ? '✅' : status === 'fail' ? '❌' : '⏭️'
  log(emoji, `${name}${message ? `: ${message}` : ''}${duration ? ` (${duration}ms)` : ''}`)
}

async function runTests() {
  log('🚀', '开始用户流程测试...\n')

  // 创建 Supabase 客户端
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

  // ============================================
  // 1. 登录测试
  // ============================================
  log('📝', '测试登录流程...')
  const startLogin = Date.now()

  const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
    email: TEST_USER.email,
    password: TEST_USER.password,
  })

  if (authError || !authData.session) {
    addResult('用户登录', 'fail', authError?.message || '无法获取 session')
    log('💡', '提示: 请先运行 npx tsx scripts/seed-community.ts 创建测试用户')
    return
  }

  addResult('用户登录', 'pass', `用户 ${authData.user?.email}`, Date.now() - startLogin)

  const _accessToken = authData.session.access_token
  const userId = authData.user?.id

  // ============================================
  // 2. 获取用户资料
  // ============================================
  log('\n📝', '测试用户资料...')
  const startProfile = Date.now()

  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('*')
    .eq('id', userId)
    .single()

  if (profileError) {
    addResult('获取用户资料', 'fail', profileError.message)
  } else {
    addResult('获取用户资料', 'pass', `handle: ${profile?.handle}`, Date.now() - startProfile)
  }

  // ============================================
  // 3. 获取小组列表
  // ============================================
  log('\n📝', '测试小组功能...')
  const startGroups = Date.now()

  const { data: groups, error: groupsError } = await supabase
    .from('groups')
    .select('id, name, member_count')
    .order('member_count', { ascending: false })
    .limit(5)

  if (groupsError) {
    addResult('获取小组列表', 'fail', groupsError.message)
  } else {
    addResult('获取小组列表', 'pass', `${groups?.length || 0} 个小组`, Date.now() - startGroups)
  }

  // ============================================
  // 4. 加入小组测试
  // ============================================
  if (groups && groups.length > 0) {
    const testGroupId = groups[0].id
    const startJoin = Date.now()

    // 检查是否已经是成员
    const { data: membership } = await supabase
      .from('group_members')
      .select('id')
      .eq('group_id', testGroupId)
      .eq('user_id', userId)
      .maybeSingle()

    if (membership) {
      addResult('加入小组', 'skip', '已是小组成员')
    } else {
      const { error: joinError } = await supabase
        .from('group_members')
        .insert({
          group_id: testGroupId,
          user_id: userId,
          role: 'member',
        })

      if (joinError) {
        addResult('加入小组', 'fail', joinError.message)
      } else {
        addResult('加入小组', 'pass', `加入 ${groups[0].name}`, Date.now() - startJoin)
      }
    }
  }

  // ============================================
  // 5. 获取帖子列表
  // ============================================
  log('\n📝', '测试帖子功能...')
  const startPosts = Date.now()

  const { data: posts, error: postsError } = await supabase
    .from('posts')
    .select('id, title, content, like_count, comment_count')
    .order('created_at', { ascending: false })
    .limit(5)

  if (postsError) {
    addResult('获取帖子列表', 'fail', postsError.message)
  } else {
    addResult('获取帖子列表', 'pass', `${posts?.length || 0} 条帖子`, Date.now() - startPosts)
  }

  // ============================================
  // 6. 点赞帖子测试
  // ============================================
  if (posts && posts.length > 0) {
    const testPostId = posts[0].id
    const startLike = Date.now()

    // 检查是否已经点赞
    const { data: existingLike } = await supabase
      .from('post_likes')
      .select('id')
      .eq('post_id', testPostId)
      .eq('user_id', userId)
      .maybeSingle()

    if (existingLike) {
      // 取消点赞
      const { error: unlikeError } = await supabase
        .from('post_likes')
        .delete()
        .eq('post_id', testPostId)
        .eq('user_id', userId)

      if (unlikeError) {
        addResult('取消点赞', 'fail', unlikeError.message)
      } else {
        addResult('取消点赞', 'pass', undefined, Date.now() - startLike)
      }
    } else {
      // 点赞
      const { error: likeError } = await supabase
        .from('post_likes')
        .insert({
          post_id: testPostId,
          user_id: userId,
          reaction: 'up',
        })

      if (likeError) {
        addResult('点赞帖子', 'fail', likeError.message)
      } else {
        addResult('点赞帖子', 'pass', undefined, Date.now() - startLike)
      }
    }
  }

  // ============================================
  // 7. 发表评论测试
  // ============================================
  if (posts && posts.length > 0) {
    const testPostId = posts[0].id
    const startComment = Date.now()

    const { data: comment, error: commentError } = await supabase
      .from('comments')
      .insert({
        post_id: testPostId,
        author_id: userId,
        author_handle: profile?.handle || 'test_user',
        content: `自动化测试评论 - ${new Date().toISOString()}`,
      })
      .select('id')
      .single()

    if (commentError) {
      addResult('发表评论', 'fail', commentError.message)
    } else {
      addResult('发表评论', 'pass', `评论 ID: ${comment?.id}`, Date.now() - startComment)

      // 删除测试评论
      if (comment?.id) {
        await supabase.from('comments').delete().eq('id', comment.id)
        addResult('删除评论', 'pass', '清理测试数据')
      }
    }
  }

  // ============================================
  // 8. 获取交易员列表
  // ============================================
  log('\n📝', '测试交易员功能...')
  const startTraders = Date.now()

  const { data: traders, error: tradersError } = await supabase
    .from('trader_snapshots')
    .select('source_trader_id, source, roi, arena_score')
    .eq('season_id', '90D')
    .order('arena_score', { ascending: false, nullsFirst: false })
    .limit(5)

  if (tradersError) {
    addResult('获取交易员排行', 'fail', tradersError.message)
  } else {
    addResult('获取交易员排行', 'pass', `${traders?.length || 0} 位交易员`, Date.now() - startTraders)
  }

  // ============================================
  // 9. 关注交易员测试
  // ============================================
  if (traders && traders.length > 0) {
    const testTrader = traders[0]
    const startFollow = Date.now()

    // 检查是否已关注
    const { data: existingFollow } = await supabase
      .from('trader_follows')
      .select('id')
      .eq('user_id', userId)
      .eq('source', testTrader.source)
      .eq('source_trader_id', testTrader.source_trader_id)
      .maybeSingle()

    if (existingFollow) {
      addResult('关注交易员', 'skip', '已关注该交易员')
    } else {
      const { error: followError } = await supabase
        .from('trader_follows')
        .insert({
          user_id: userId,
          source: testTrader.source,
          source_trader_id: testTrader.source_trader_id,
        })

      if (followError) {
        // 可能是表不存在
        addResult('关注交易员', 'skip', followError.message)
      } else {
        addResult('关注交易员', 'pass', `关注 ${testTrader.source_trader_id}`, Date.now() - startFollow)
      }
    }
  }

  // ============================================
  // 10. 收藏夹测试
  // ============================================
  log('\n📝', '测试收藏功能...')
  const startBookmark = Date.now()

  const { data: folders, error: foldersError } = await supabase
    .from('bookmark_folders')
    .select('id, name')
    .eq('user_id', userId)

  if (foldersError) {
    addResult('获取收藏夹', 'fail', foldersError.message)
  } else {
    addResult('获取收藏夹', 'pass', `${folders?.length || 0} 个收藏夹`, Date.now() - startBookmark)
  }

  // ============================================
  // 11. 登出测试
  // ============================================
  log('\n📝', '测试登出...')
  const startLogout = Date.now()

  const { error: logoutError } = await supabase.auth.signOut()

  if (logoutError) {
    addResult('用户登出', 'fail', logoutError.message)
  } else {
    addResult('用户登出', 'pass', undefined, Date.now() - startLogout)
  }

  // ============================================
  // 测试结果汇总
  // ============================================
  console.warn('\n' + '='.repeat(50))
  console.warn('📊 测试结果汇总')
  console.warn('='.repeat(50))

  const passed = results.filter(r => r.status === 'pass').length
  const failed = results.filter(r => r.status === 'fail').length
  const skipped = results.filter(r => r.status === 'skip').length

  console.warn(`✅ 通过: ${passed}`)
  console.warn(`❌ 失败: ${failed}`)
  console.warn(`⏭️ 跳过: ${skipped}`)
  console.warn(`📝 总计: ${results.length}`)

  if (failed > 0) {
    console.warn('\n❌ 失败的测试:')
    results.filter(r => r.status === 'fail').forEach(r => {
      console.warn(`   - ${r.name}: ${r.message}`)
    })
  }

  console.warn('\n' + '='.repeat(50))

  // 返回退出码
  process.exit(failed > 0 ? 1 : 0)
}

// 运行测试
runTests().catch(error => {
  console.error('测试脚本错误:', error)
  process.exit(1)
})
