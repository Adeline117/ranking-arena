/**
 * 用户权重系统测试脚本
 * 验证权重计算和排序功能
 */

const readline = require('readline')

// VPS 数据库连接命令
const DB_COMMAND = `sshpass -p '6tU)s4LW7*f)G5i#' ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no root@45.76.152.169 "PGPASSWORD='j0qvCCZDzOHDfBka' psql 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres' -c"`

async function executeSQL(sql) {
  const { exec } = require('child_process')
  return new Promise((resolve, reject) => {
    exec(`${DB_COMMAND} "${sql.replace(/"/g, '\\"')}"`, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}

async function testUserWeights() {
  console.log('🔍 用户权重系统测试\n')
  
  try {
    // 1. 检查权重分布
    console.log('📊 检查权重分布...')
    const weightStats = await executeSQL(`
      SELECT 
        COUNT(*) as total_users,
        AVG(weight) as avg_weight,
        MAX(weight) as max_weight,
        MIN(weight) as min_weight,
        COUNT(CASE WHEN weight >= 50 THEN 1 END) as high_weight_users,
        COUNT(CASE WHEN weight < 20 THEN 1 END) as low_weight_users
      FROM user_profiles WHERE weight IS NOT NULL;
    `)
    console.log(weightStats)
    
    // 2. 显示权重最高的用户
    console.log('🏆 权重最高的用户 (Top 5):')
    const topUsers = await executeSQL(`
      SELECT 
        handle, 
        weight,
        subscription_tier,
        created_at::date as registration_date,
        (SELECT COUNT(*) FROM posts WHERE author_id = user_profiles.id) as post_count,
        (SELECT COUNT(*) FROM comments WHERE author_id = user_profiles.id) as comment_count
      FROM user_profiles 
      WHERE weight > 0 
      ORDER BY weight DESC 
      LIMIT 5;
    `)
    console.log(topUsers)
    
    // 3. 测试权重计算函数
    console.log('🧮 测试权重计算函数...')
    const testUser = await executeSQL(`
      SELECT id FROM user_profiles LIMIT 1;
    `)
    
    if (testUser.includes('|')) {
      const userId = testUser.split('\n')[2].trim().split('|')[0].trim()
      console.log(`测试用户: ${userId}`)
      
      const recalcResult = await executeSQL(`
        SELECT calculate_user_weight('${userId}') as new_weight;
      `)
      console.log('权重重计算结果:', recalcResult)
    }
    
    // 4. 测试搜索函数
    console.log('🔍 测试权重增强搜索...')
    const searchResult = await executeSQL(`
      SELECT 
        title,
        author_handle,
        hot_score,
        author_weight,
        weighted_score
      FROM search_posts_with_weight('BTC', 3, 0, 0.3) 
      LIMIT 3;
    `)
    console.log('搜索结果 (前3条):', searchResult)
    
    console.log('\n✅ 用户权重系统测试完成!')
    console.log('🎯 系统已成功部署并运行')
    
  } catch (error) {
    console.error('❌ 测试失败:', error.message)
  }
}

// 运行测试
testUserWeights()