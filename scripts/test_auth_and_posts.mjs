#!/usr/bin/env node
/**
 * 测试注册和发帖功能
 * 使用方法: node scripts/test_auth_and_posts.mjs
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ 错误: 缺少环境变量')
  console.error('需要设置: NEXT_PUBLIC_SUPABASE_URL 和 NEXT_PUBLIC_SUPABASE_ANON_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// 生成测试邮箱
const testEmail = `test_${Date.now()}@example.com`
const testPassword = 'TestPassword123!'

console.log('=== 测试 Supabase 认证和发帖功能 ===\n')
console.log(`测试邮箱: ${testEmail}`)
console.log(`测试密码: ${testPassword}\n`)

async function testAuth() {
  console.log('1️⃣ 测试注册...')
  
  try {
    // 注册新用户
    const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
      email: testEmail,
      password: testPassword,
    })

    if (signUpError) {
      console.error('❌ 注册失败:', signUpError.message)
      return false
    }

    if (!signUpData.user) {
      console.error('❌ 注册失败: 未返回用户数据')
      return false
    }

    console.log('✅ 注册成功!')
    console.log(`   用户ID: ${signUpData.user.id}`)
    console.log(`   邮箱: ${signUpData.user.email}`)
    console.log(`   邮箱已验证: ${signUpData.user.email_confirmed_at ? '是' : '否'}\n`)

    // 等待一下，确保 profile 被创建
    await new Promise(resolve => setTimeout(resolve, 1000))

    // 检查 profile 是否已创建
    console.log('2️⃣ 检查用户 profile...')
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', signUpData.user.id)
      .maybeSingle()

    if (profileError) {
      console.error('⚠️ 查询 profile 失败:', profileError.message)
      // 尝试 user_profiles 表
      const { data: userProfile } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('id', signUpData.user.id)
        .maybeSingle()
      
      if (userProfile) {
        console.log('✅ 在 user_profiles 表中找到 profile')
        console.log(`   Handle: ${userProfile.handle || '未设置'}`)
      } else {
        console.log('⚠️ 未找到 profile，可能需要手动创建')
      }
    } else if (profile) {
      console.log('✅ Profile 已创建!')
      console.log(`   Handle: ${profile.handle || '未设置'}`)
      console.log(`   Email: ${profile.email || '未设置'}`)
    } else {
      console.log('⚠️ Profile 未创建，但注册成功（这是正常的，profile 可能由触发器创建）')
    }

    console.log('\n3️⃣ 测试登录...')
    
    // 先登出
    await supabase.auth.signOut()

    // 登录
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email: testEmail,
      password: testPassword,
    })

    if (signInError) {
      console.error('❌ 登录失败:', signInError.message)
      return false
    }

    if (!signInData.user) {
      console.error('❌ 登录失败: 未返回用户数据')
      return false
    }

    console.log('✅ 登录成功!')
    console.log(`   用户ID: ${signInData.user.id}\n`)

    return signInData.user
  } catch (error) {
    console.error('❌ 测试失败:', error.message)
    return false
  }
}

async function testOTP() {
  console.log('4️⃣ 测试 OTP（验证码）注册...')
  
  const otpEmail = `otp_test_${Date.now()}@example.com`
  console.log(`   测试邮箱: ${otpEmail}`)

  try {
    // 发送验证码
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: otpEmail,
      options: {
        shouldCreateUser: true,
      },
    })

    if (otpError) {
      console.error('❌ 发送验证码失败:', otpError.message)
      console.log('   ⚠️ 注意: 这可能是正常的，因为需要真实的邮箱地址')
      return false
    }

    console.log('✅ 验证码已发送!')
    console.log('   ⚠️ 注意: 请检查邮箱中的验证码，然后手动验证')
    console.log('   验证码格式: 6位数字')
    console.log('   验证码有效期: 1小时')
    
    return true
  } catch (error) {
    console.error('❌ OTP 测试失败:', error.message)
    return false
  }
}

async function testPostCreation(user) {
  if (!user) {
    console.log('\n⚠️ 跳过发帖测试（用户未登录）')
    return false
  }

  console.log('\n5️⃣ 测试发帖功能...')

  try {
    // 获取用户 handle
    let userHandle = null
    const { data: profile } = await supabase
      .from('profiles')
      .select('handle')
      .eq('id', user.id)
      .maybeSingle()

    if (profile?.handle) {
      userHandle = profile.handle
    } else {
      // 尝试 user_profiles 表
      const { data: userProfile } = await supabase
        .from('user_profiles')
        .select('handle')
        .eq('id', user.id)
        .maybeSingle()
      
      if (userProfile?.handle) {
        userHandle = userProfile.handle
      } else {
        userHandle = user.email?.split('@')[0] || 'anonymous'
      }
    }

    console.log(`   用户 Handle: ${userHandle}`)

    // 查找一个存在的 group_id（如果没有，使用测试 ID）
    const { data: groups } = await supabase
      .from('groups')
      .select('id')
      .limit(1)

    const groupId = groups && groups.length > 0 ? groups[0].id : 'test-group-1'

    console.log(`   使用 Group ID: ${groupId}`)

    // 创建测试帖子
    const { data: post, error: postError } = await supabase
      .from('posts')
      .insert({
        group_id: groupId,
        title: `测试帖子 - ${new Date().toLocaleString()}`,
        content: '这是一个自动生成的测试帖子，用于验证发帖功能是否正常工作。',
        author_id: user.id,
        author_handle: userHandle,
      })
      .select()
      .single()

    if (postError) {
      console.error('❌ 发帖失败:', postError.message)
      console.error('   错误详情:', JSON.stringify(postError, null, 2))
      
      // 检查是否是 RLS 策略问题
      if (postError.message.includes('policy') || postError.message.includes('RLS')) {
        console.log('\n   ⚠️ 提示: 可能是 RLS 策略问题，请检查:')
        console.log('      1. posts 表是否启用了 RLS')
        console.log('      2. 是否有 "Authenticated users can create posts" 策略')
        console.log('      3. 当前用户是否已认证')
      }
      
      return false
    }

    console.log('✅ 发帖成功!')
    console.log(`   帖子ID: ${post.id}`)
    console.log(`   标题: ${post.title}`)
    console.log(`   作者ID: ${post.author_id}`)
    console.log(`   作者Handle: ${post.author_handle}`)

    // 验证帖子数据
    const { data: verifyPost } = await supabase
      .from('posts')
      .select('*')
      .eq('id', post.id)
      .single()

    if (verifyPost) {
      console.log('\n✅ 帖子数据验证成功!')
      console.log(`   可以查询到帖子: ${verifyPost.title}`)
    }

    return true
  } catch (error) {
    console.error('❌ 发帖测试失败:', error.message)
    return false
  }
}

async function testProfileUpdate(user) {
  if (!user) {
    console.log('\n⚠️ 跳过 profile 更新测试（用户未登录）')
    return false
  }

  console.log('\n6️⃣ 测试 profile 更新...')

  try {
    const newHandle = `test_user_${Date.now()}`
    const newBio = '这是一个测试简介'

    // 更新 profile
    const { error: updateError } = await supabase
      .from('profiles')
      .upsert({
        id: user.id,
        handle: newHandle,
        bio: newBio,
      }, { onConflict: 'id' })

    if (updateError) {
      // 尝试 user_profiles 表
      const { error: userProfileError } = await supabase
        .from('user_profiles')
        .upsert({
          id: user.id,
          handle: newHandle,
          bio: newBio,
        }, { onConflict: 'id' })

      if (userProfileError) {
        console.error('❌ Profile 更新失败:', userProfileError.message)
        return false
      }
    }

    console.log('✅ Profile 更新成功!')
    console.log(`   Handle: ${newHandle}`)
    console.log(`   Bio: ${newBio}`)

    return true
  } catch (error) {
    console.error('❌ Profile 更新测试失败:', error.message)
    return false
  }
}

async function main() {
  console.log('开始测试...\n')

  // 测试注册和登录
  const user = await testAuth()

  // 测试 OTP（不会真正完成，因为需要手动输入验证码）
  await testOTP()

  // 测试发帖
  await testPostCreation(user)

  // 测试 profile 更新
  await testProfileUpdate(user)

  console.log('\n=== 测试完成 ===')
  console.log('\n📝 下一步:')
  console.log('   1. 在 Supabase Dashboard 中运行 scripts/setup_supabase_tables.sql')
  console.log('   2. 配置邮箱设置（参考 docs/SUPABASE_SETUP.md）')
  console.log('   3. 在浏览器中测试注册和发帖功能')
  console.log(`   4. 测试邮箱: ${testEmail}`)
  console.log(`   5. 测试密码: ${testPassword}`)
}

main().catch(console.error)



