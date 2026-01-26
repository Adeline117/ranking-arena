/**
 * 全面功能测试脚本
 * 测试所有用户操作：登录、发帖、编辑、删除、点赞、评论、加入退出小组、收藏等
 *
 * 运行: npx tsx scripts/test-all-features.ts
 */

import { config } from 'dotenv'
import { createClient, SupabaseClient, User } from '@supabase/supabase-js'

// 加载环境变量
config({ path: '.env.local' })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ 缺少环境变量')
  process.exit(1)
}

// 测试账号
const TEST_USER = {
  email: 'grid01@test.com',
  password: 'grid0123',
}

interface TestResult {
  category: string
  name: string
  status: 'pass' | 'fail' | 'skip'
  message?: string
  duration?: number
}

const results: TestResult[] = []
let supabase: SupabaseClient
let adminSupabase: SupabaseClient
let currentUser: User | null = null
let userProfile: { id: string; handle: string } | null = null

function log(emoji: string, message: string) {
  console.log(`${emoji} ${message}`)
}

function addResult(category: string, name: string, status: 'pass' | 'fail' | 'skip', message?: string, duration?: number) {
  results.push({ category, name, status, message, duration })
  const emoji = status === 'pass' ? '✅' : status === 'fail' ? '❌' : '⏭️'
  const durationStr = duration ? ` (${duration}ms)` : ''
  log(emoji, `[${category}] ${name}${message ? `: ${message}` : ''}${durationStr}`)
}

// ============================================
// 辅助函数
// ============================================

async function measure<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = Date.now()
  const result = await fn()
  return [result, Date.now() - start]
}

// ============================================
// 测试函数
// ============================================

async function testAuth() {
  log('\n🔐', '========== 认证测试 ==========')

  // 登录测试
  const [authResult, loginTime] = await measure(async () => {
    return supabase.auth.signInWithPassword({
      email: TEST_USER.email,
      password: TEST_USER.password,
    })
  })

  if (authResult.error || !authResult.data.session) {
    addResult('认证', '用户登录', 'fail', authResult.error?.message || '无法获取 session')
    return false
  }

  currentUser = authResult.data.user
  addResult('认证', '用户登录', 'pass', `用户 ${currentUser?.email}`, loginTime)

  // 获取用户资料
  const [profileResult, profileTime] = await measure(async () => {
    return adminSupabase
      .from('user_profiles')
      .select('id, handle, bio, avatar_url')
      .eq('id', currentUser!.id)
      .single()
  })

  if (profileResult.error) {
    addResult('认证', '获取用户资料', 'fail', profileResult.error.message)
  } else {
    userProfile = { id: profileResult.data.id, handle: profileResult.data.handle }
    addResult('认证', '获取用户资料', 'pass', `handle: ${userProfile.handle}`, profileTime)
  }

  return true
}

async function testGroups() {
  log('\n👥', '========== 小组测试 ==========')

  if (!currentUser) {
    addResult('小组', '所有测试', 'skip', '用户未登录')
    return
  }

  // 1. 获取小组列表
  const [groupsResult, groupsTime] = await measure(async () => {
    return adminSupabase
      .from('groups')
      .select('id, name, member_count, description')
      .order('member_count', { ascending: false })
      .limit(10)
  })

  if (groupsResult.error) {
    addResult('小组', '获取小组列表', 'fail', groupsResult.error.message)
    return
  }

  const groups = groupsResult.data || []
  addResult('小组', '获取小组列表', 'pass', `${groups.length} 个小组`, groupsTime)

  if (groups.length === 0) return

  const testGroup = groups[0]

  // 2. 检查成员状态
  const { data: membership } = await adminSupabase
    .from('group_members')
    .select('id, role')
    .eq('group_id', testGroup.id)
    .eq('user_id', currentUser.id)
    .maybeSingle()

  // 3. 测试加入/退出小组
  if (membership) {
    // 已是成员，先退出再加入
    const [leaveResult, leaveTime] = await measure(async () => {
      return adminSupabase
        .from('group_members')
        .delete()
        .eq('group_id', testGroup.id)
        .eq('user_id', currentUser!.id)
    })

    if (leaveResult.error) {
      addResult('小组', '退出小组', 'fail', leaveResult.error.message)
    } else {
      addResult('小组', '退出小组', 'pass', `退出 ${testGroup.name}`, leaveTime)
    }

    // 重新加入
    const [joinResult, joinTime] = await measure(async () => {
      return adminSupabase
        .from('group_members')
        .insert({
          group_id: testGroup.id,
          user_id: currentUser!.id,
          role: membership.role || 'member',
        })
    })

    if (joinResult.error) {
      addResult('小组', '加入小组', 'fail', joinResult.error.message)
    } else {
      addResult('小组', '加入小组', 'pass', `加入 ${testGroup.name}`, joinTime)
    }
  } else {
    // 不是成员，先加入再退出
    const [joinResult, joinTime] = await measure(async () => {
      return adminSupabase
        .from('group_members')
        .insert({
          group_id: testGroup.id,
          user_id: currentUser!.id,
          role: 'member',
        })
    })

    if (joinResult.error) {
      addResult('小组', '加入小组', 'fail', joinResult.error.message)
    } else {
      addResult('小组', '加入小组', 'pass', `加入 ${testGroup.name}`, joinTime)
    }

    // 退出（清理）
    const [leaveResult, leaveTime] = await measure(async () => {
      return adminSupabase
        .from('group_members')
        .delete()
        .eq('group_id', testGroup.id)
        .eq('user_id', currentUser!.id)
    })

    if (leaveResult.error) {
      addResult('小组', '退出小组', 'fail', leaveResult.error.message)
    } else {
      addResult('小组', '退出小组', 'pass', `退出 ${testGroup.name}`, leaveTime)
    }
  }
}

async function testPosts() {
  log('\n📝', '========== 帖子测试 ==========')

  if (!currentUser || !userProfile) {
    addResult('帖子', '所有测试', 'skip', '用户未登录')
    return
  }

  // 1. 获取小组（用于发帖）
  const { data: groups } = await adminSupabase
    .from('groups')
    .select('id, name')
    .limit(1)

  const testGroupId = groups?.[0]?.id

  // 2. 创建帖子
  const testTitle = `测试帖子 ${Date.now()}`
  const testContent = '这是一条自动化测试帖子，将在测试完成后删除。'

  const [createResult, createTime] = await measure(async () => {
    return adminSupabase
      .from('posts')
      .insert({
        title: testTitle,
        content: testContent,
        author_id: currentUser!.id,
        author_handle: userProfile!.handle,
        group_id: testGroupId,
      })
      .select('id, title')
      .single()
  })

  if (createResult.error) {
    addResult('帖子', '创建帖子', 'fail', createResult.error.message)
    return
  }

  const testPostId = createResult.data.id
  addResult('帖子', '创建帖子', 'pass', `ID: ${testPostId.slice(0, 8)}...`, createTime)

  // 3. 读取帖子
  const [readResult, readTime] = await measure(async () => {
    return adminSupabase
      .from('posts')
      .select('*')
      .eq('id', testPostId)
      .single()
  })

  if (readResult.error) {
    addResult('帖子', '读取帖子', 'fail', readResult.error.message)
  } else {
    addResult('帖子', '读取帖子', 'pass', `标题: ${readResult.data.title}`, readTime)
  }

  // 4. 编辑帖子
  const newContent = '这是编辑后的内容 - ' + new Date().toISOString()
  const [editResult, editTime] = await measure(async () => {
    return adminSupabase
      .from('posts')
      .update({ content: newContent, updated_at: new Date().toISOString() })
      .eq('id', testPostId)
      .eq('author_id', currentUser!.id) // 确保只能编辑自己的帖子
      .select('id, content')
      .single()
  })

  if (editResult.error) {
    addResult('帖子', '编辑帖子', 'fail', editResult.error.message)
  } else {
    addResult('帖子', '编辑帖子', 'pass', '内容已更新', editTime)
  }

  // 5. 删除帖子
  const [deleteResult, deleteTime] = await measure(async () => {
    return adminSupabase
      .from('posts')
      .delete()
      .eq('id', testPostId)
      .eq('author_id', currentUser!.id)
  })

  if (deleteResult.error) {
    addResult('帖子', '删除帖子', 'fail', deleteResult.error.message)
  } else {
    addResult('帖子', '删除帖子', 'pass', '帖子已删除', deleteTime)
  }

  // 6. 验证删除
  const { data: deletedPost } = await adminSupabase
    .from('posts')
    .select('id')
    .eq('id', testPostId)
    .maybeSingle()

  if (deletedPost) {
    addResult('帖子', '验证删除', 'fail', '帖子仍然存在')
  } else {
    addResult('帖子', '验证删除', 'pass', '确认已删除')
  }
}

async function testComments() {
  log('\n💬', '========== 评论测试 ==========')

  if (!currentUser || !userProfile) {
    addResult('评论', '所有测试', 'skip', '用户未登录')
    return
  }

  // 1. 获取一条帖子
  const { data: posts } = await adminSupabase
    .from('posts')
    .select('id, title')
    .limit(1)

  if (!posts || posts.length === 0) {
    addResult('评论', '所有测试', 'skip', '没有可用的帖子')
    return
  }

  const testPostId = posts[0].id

  // 2. 创建评论
  const testCommentContent = `自动化测试评论 - ${Date.now()}`

  const [createResult, createTime] = await measure(async () => {
    return adminSupabase
      .from('comments')
      .insert({
        post_id: testPostId,
        user_id: currentUser!.id,
        content: testCommentContent,
      })
      .select('id, content')
      .single()
  })

  if (createResult.error) {
    addResult('评论', '创建评论', 'fail', createResult.error.message)
    return
  }

  const testCommentId = createResult.data.id
  addResult('评论', '创建评论', 'pass', `ID: ${testCommentId.slice(0, 8)}...`, createTime)

  // 3. 读取评论
  const [readResult, readTime] = await measure(async () => {
    return adminSupabase
      .from('comments')
      .select('*')
      .eq('id', testCommentId)
      .single()
  })

  if (readResult.error) {
    addResult('评论', '读取评论', 'fail', readResult.error.message)
  } else {
    addResult('评论', '读取评论', 'pass', undefined, readTime)
  }

  // 4. 编辑评论
  const newCommentContent = '编辑后的评论内容 - ' + new Date().toISOString()
  const [editResult, editTime] = await measure(async () => {
    return adminSupabase
      .from('comments')
      .update({ content: newCommentContent, updated_at: new Date().toISOString() })
      .eq('id', testCommentId)
      .eq('user_id', currentUser!.id)
      .select('id')
      .single()
  })

  if (editResult.error) {
    addResult('评论', '编辑评论', 'fail', editResult.error.message)
  } else {
    addResult('评论', '编辑评论', 'pass', '内容已更新', editTime)
  }

  // 5. 删除评论
  const [deleteResult, deleteTime] = await measure(async () => {
    return adminSupabase
      .from('comments')
      .delete()
      .eq('id', testCommentId)
      .eq('user_id', currentUser!.id)
  })

  if (deleteResult.error) {
    addResult('评论', '删除评论', 'fail', deleteResult.error.message)
  } else {
    addResult('评论', '删除评论', 'pass', '评论已删除', deleteTime)
  }
}

async function testLikes() {
  log('\n👍', '========== 点赞测试 ==========')

  if (!currentUser) {
    addResult('点赞', '所有测试', 'skip', '用户未登录')
    return
  }

  // 1. 获取一条帖子
  const { data: posts } = await adminSupabase
    .from('posts')
    .select('id, title, like_count')
    .limit(1)

  if (!posts || posts.length === 0) {
    addResult('点赞', '所有测试', 'skip', '没有可用的帖子')
    return
  }

  const testPost = posts[0]

  // 2. 检查是否已点赞
  const { data: existingLike } = await adminSupabase
    .from('post_likes')
    .select('id')
    .eq('post_id', testPost.id)
    .eq('user_id', currentUser.id)
    .maybeSingle()

  // 3. 点赞
  if (!existingLike) {
    const [likeResult, likeTime] = await measure(async () => {
      return adminSupabase
        .from('post_likes')
        .insert({
          post_id: testPost.id,
          user_id: currentUser!.id,
        })
    })

    if (likeResult.error) {
      addResult('点赞', '点赞帖子', 'fail', likeResult.error.message)
    } else {
      addResult('点赞', '点赞帖子', 'pass', undefined, likeTime)
    }
  } else {
    addResult('点赞', '点赞帖子', 'skip', '已经点过赞')
  }

  // 4. 取消点赞
  const [unlikeResult, unlikeTime] = await measure(async () => {
    return adminSupabase
      .from('post_likes')
      .delete()
      .eq('post_id', testPost.id)
      .eq('user_id', currentUser!.id)
  })

  if (unlikeResult.error) {
    addResult('点赞', '取消点赞', 'fail', unlikeResult.error.message)
  } else {
    addResult('点赞', '取消点赞', 'pass', undefined, unlikeTime)
  }

  // 5. 验证取消
  const { data: checkLike } = await adminSupabase
    .from('post_likes')
    .select('id')
    .eq('post_id', testPost.id)
    .eq('user_id', currentUser.id)
    .maybeSingle()

  if (checkLike) {
    addResult('点赞', '验证取消点赞', 'fail', '点赞记录仍存在')
  } else {
    addResult('点赞', '验证取消点赞', 'pass')
  }

  // 6. 恢复原状（如果之前有点赞）
  if (existingLike) {
    await adminSupabase
      .from('post_likes')
      .insert({
        post_id: testPost.id,
        user_id: currentUser.id,
      })
    addResult('点赞', '恢复点赞状态', 'pass')
  }
}

async function testBookmarks() {
  log('\n📚', '========== 收藏夹测试 ==========')

  if (!currentUser) {
    addResult('收藏夹', '所有测试', 'skip', '用户未登录')
    return
  }

  // 1. 获取收藏夹列表
  const [foldersResult, foldersTime] = await measure(async () => {
    return adminSupabase
      .from('bookmark_folders')
      .select('*')
      .eq('user_id', currentUser!.id)
  })

  if (foldersResult.error) {
    addResult('收藏夹', '获取收藏夹列表', 'fail', foldersResult.error.message)
    return
  }

  addResult('收藏夹', '获取收藏夹列表', 'pass', `${foldersResult.data?.length || 0} 个收藏夹`, foldersTime)

  // 2. 创建收藏夹
  const testFolderName = `测试收藏夹 ${Date.now()}`
  const [createResult, createTime] = await measure(async () => {
    return adminSupabase
      .from('bookmark_folders')
      .insert({
        user_id: currentUser!.id,
        name: testFolderName,
        description: '自动化测试创建的收藏夹',
        is_public: false,
        is_default: false,
      })
      .select('id, name')
      .single()
  })

  if (createResult.error) {
    addResult('收藏夹', '创建收藏夹', 'fail', createResult.error.message)
    return
  }

  const testFolderId = createResult.data.id
  addResult('收藏夹', '创建收藏夹', 'pass', `名称: ${testFolderName}`, createTime)

  // 3. 编辑收藏夹
  const newFolderName = '编辑后的收藏夹名称'
  const [editResult, editTime] = await measure(async () => {
    return adminSupabase
      .from('bookmark_folders')
      .update({ name: newFolderName })
      .eq('id', testFolderId)
      .eq('user_id', currentUser!.id)
      .select('id, name')
      .single()
  })

  if (editResult.error) {
    addResult('收藏夹', '编辑收藏夹', 'fail', editResult.error.message)
  } else {
    addResult('收藏夹', '编辑收藏夹', 'pass', `新名称: ${newFolderName}`, editTime)
  }

  // 4. 删除收藏夹
  const [deleteResult, deleteTime] = await measure(async () => {
    return adminSupabase
      .from('bookmark_folders')
      .delete()
      .eq('id', testFolderId)
      .eq('user_id', currentUser!.id)
  })

  if (deleteResult.error) {
    addResult('收藏夹', '删除收藏夹', 'fail', deleteResult.error.message)
  } else {
    addResult('收藏夹', '删除收藏夹', 'pass', '收藏夹已删除', deleteTime)
  }
}

async function testTraderFollow() {
  log('\n⭐', '========== 关注交易员测试 ==========')

  if (!currentUser) {
    addResult('关注', '所有测试', 'skip', '用户未登录')
    return
  }

  // 1. 获取交易员列表
  const { data: traders } = await adminSupabase
    .from('trader_snapshots')
    .select('source_trader_id, source')
    .eq('season_id', '90D')
    .limit(1)

  if (!traders || traders.length === 0) {
    addResult('关注', '所有测试', 'skip', '没有可用的交易员')
    return
  }

  const testTrader = traders[0]

  // 2. 检查 trader_follows 表是否存在
  const { error: checkError } = await adminSupabase
    .from('trader_follows')
    .select('id')
    .limit(1)

  if (checkError?.message?.includes('does not exist') || checkError?.message?.includes('Could not find')) {
    addResult('关注', '所有测试', 'skip', 'trader_follows 表不存在')
    return
  }

  // 3. 关注交易员
  const [followResult, followTime] = await measure(async () => {
    return adminSupabase
      .from('trader_follows')
      .upsert({
        user_id: currentUser!.id,
        trader_id: `${testTrader.source}:${testTrader.source_trader_id}`,
      }, { onConflict: 'user_id,trader_id' })
  })

  if (followResult.error) {
    addResult('关注', '关注交易员', 'fail', followResult.error.message)
  } else {
    addResult('关注', '关注交易员', 'pass', `${testTrader.source_trader_id}`, followTime)
  }

  // 4. 取消关注
  const [unfollowResult, unfollowTime] = await measure(async () => {
    return adminSupabase
      .from('trader_follows')
      .delete()
      .eq('user_id', currentUser!.id)
      .eq('trader_id', `${testTrader.source}:${testTrader.source_trader_id}`)
  })

  if (unfollowResult.error) {
    addResult('关注', '取消关注', 'fail', unfollowResult.error.message)
  } else {
    addResult('关注', '取消关注', 'pass', undefined, unfollowTime)
  }
}

async function testUserFollow() {
  log('\n👤', '========== 用户关注测试 ==========')

  if (!currentUser) {
    addResult('用户关注', '所有测试', 'skip', '用户未登录')
    return
  }

  // 1. 获取其他用户
  const { data: users } = await adminSupabase
    .from('user_profiles')
    .select('id, handle')
    .neq('id', currentUser.id)
    .limit(1)

  if (!users || users.length === 0) {
    addResult('用户关注', '所有测试', 'skip', '没有可用的其他用户')
    return
  }

  const testUser = users[0]

  // 2. 关注用户
  const [followResult, followTime] = await measure(async () => {
    return adminSupabase
      .from('user_follows')
      .upsert({
        follower_id: currentUser!.id,
        following_id: testUser.id,
      }, { onConflict: 'follower_id,following_id' })
  })

  if (followResult.error) {
    addResult('用户关注', '关注用户', 'fail', followResult.error.message)
  } else {
    addResult('用户关注', '关注用户', 'pass', `@${testUser.handle}`, followTime)
  }

  // 3. 取消关注
  const [unfollowResult, unfollowTime] = await measure(async () => {
    return adminSupabase
      .from('user_follows')
      .delete()
      .eq('follower_id', currentUser!.id)
      .eq('following_id', testUser.id)
  })

  if (unfollowResult.error) {
    addResult('用户关注', '取消关注', 'fail', unfollowResult.error.message)
  } else {
    addResult('用户关注', '取消关注', 'pass', undefined, unfollowTime)
  }
}

async function testProfileUpdate() {
  log('\n🎨', '========== 个人资料测试 ==========')

  if (!currentUser) {
    addResult('个人资料', '所有测试', 'skip', '用户未登录')
    return
  }

  // 1. 获取当前资料
  const { data: currentProfile } = await adminSupabase
    .from('user_profiles')
    .select('*')
    .eq('id', currentUser.id)
    .single()

  if (!currentProfile) {
    addResult('个人资料', '所有测试', 'fail', '无法获取当前资料')
    return
  }

  // 2. 修改昵称
  const originalBio = currentProfile.bio
  const testBio = `测试简介 - ${Date.now()}`

  const [updateResult, updateTime] = await measure(async () => {
    return adminSupabase
      .from('user_profiles')
      .update({ bio: testBio })
      .eq('id', currentUser!.id)
      .select('bio')
      .single()
  })

  if (updateResult.error) {
    addResult('个人资料', '修改简介', 'fail', updateResult.error.message)
  } else {
    addResult('个人资料', '修改简介', 'pass', '简介已更新', updateTime)
  }

  // 3. 验证修改
  const { data: verifyProfile } = await adminSupabase
    .from('user_profiles')
    .select('bio')
    .eq('id', currentUser.id)
    .single()

  if (verifyProfile?.bio === testBio) {
    addResult('个人资料', '验证修改', 'pass')
  } else {
    addResult('个人资料', '验证修改', 'fail', '修改未生效')
  }

  // 4. 恢复原状
  const [restoreResult, restoreTime] = await measure(async () => {
    return adminSupabase
      .from('user_profiles')
      .update({ bio: originalBio })
      .eq('id', currentUser!.id)
  })

  if (restoreResult.error) {
    addResult('个人资料', '恢复原状', 'fail', restoreResult.error.message)
  } else {
    addResult('个人资料', '恢复原状', 'pass', undefined, restoreTime)
  }
}

async function testLogout() {
  log('\n🚪', '========== 登出测试 ==========')

  const [logoutResult, logoutTime] = await measure(async () => {
    return supabase.auth.signOut()
  })

  if (logoutResult.error) {
    addResult('认证', '用户登出', 'fail', logoutResult.error.message)
  } else {
    addResult('认证', '用户登出', 'pass', 'Session 已清除', logoutTime)
  }
}

// ============================================
// 主函数
// ============================================

async function main() {
  console.log('🚀 全面功能测试开始...')
  console.log('=' .repeat(50))

  // 初始化客户端
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  adminSupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  // 运行测试
  const loggedIn = await testAuth()

  if (loggedIn) {
    await testGroups()
    await testPosts()
    await testComments()
    await testLikes()
    await testBookmarks()
    await testTraderFollow()
    await testUserFollow()
    await testProfileUpdate()
    await testLogout()
  }

  // 输出汇总
  console.log('\n' + '='.repeat(50))
  console.log('📊 测试结果汇总')
  console.log('='.repeat(50))

  const categories = [...new Set(results.map(r => r.category))]

  for (const category of categories) {
    const categoryResults = results.filter(r => r.category === category)
    const passed = categoryResults.filter(r => r.status === 'pass').length
    const failed = categoryResults.filter(r => r.status === 'fail').length
    const skipped = categoryResults.filter(r => r.status === 'skip').length

    const status = failed > 0 ? '❌' : '✅'
    console.log(`${status} ${category}: ${passed} 通过, ${failed} 失败, ${skipped} 跳过`)
  }

  console.log('\n' + '-'.repeat(50))

  const totalPassed = results.filter(r => r.status === 'pass').length
  const totalFailed = results.filter(r => r.status === 'fail').length
  const totalSkipped = results.filter(r => r.status === 'skip').length

  console.log(`✅ 总通过: ${totalPassed}`)
  console.log(`❌ 总失败: ${totalFailed}`)
  console.log(`⏭️ 总跳过: ${totalSkipped}`)
  console.log(`📝 总计: ${results.length}`)

  if (totalFailed > 0) {
    console.log('\n❌ 失败的测试:')
    results.filter(r => r.status === 'fail').forEach(r => {
      console.log(`   - [${r.category}] ${r.name}: ${r.message}`)
    })
  }

  console.log('\n' + '='.repeat(50))

  process.exit(totalFailed > 0 ? 1 : 0)
}

main().catch(error => {
  console.error('测试脚本错误:', error)
  process.exit(1)
})
