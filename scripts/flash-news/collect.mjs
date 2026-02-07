#!/usr/bin/env node

/**
 * Flash News RSS 收集脚本
 * 从多个免费 RSS 源抓取快讯并存储到数据库
 * 使用方式：
 *   node scripts/flash-news/collect.mjs
 *   或在 VPS 上设置 cron 定时运行
 */

import fetch from 'node-fetch'
import { createClient } from '@supabase/supabase-js'
import { XMLParser } from 'fast-xml-parser'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { config } from 'dotenv'

// 获取当前文件的目录路径
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const projectRoot = join(__dirname, '../..')

// 加载环境变量
config({ path: join(projectRoot, '.env.local') })

// Supabase 配置
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://iknktzifjdyujdccyhsv.supabase.co'
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE'

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

// RSS 数据源配置
const RSS_SOURCES = [
  {
    name: 'CoinDesk',
    url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
    category: 'crypto',
    language: 'en',
    importance: 'important',
  },
  {
    name: 'CoinTelegraph',
    url: 'https://cointelegraph.com/rss',
    category: 'crypto',
    language: 'en',
    importance: 'normal',
  },
  {
    name: 'The Block',
    url: 'https://www.theblock.co/rss/all',
    category: 'crypto',
    language: 'en',
    importance: 'important',
  },
  {
    name: 'DeFiPulse',
    url: 'https://defipulse.com/blog/feed/',
    category: 'defi',
    language: 'en',
    importance: 'normal',
  },
  {
    name: 'BeInCrypto',
    url: 'https://beincrypto.com/feed/',
    category: 'crypto',
    language: 'en',
    importance: 'normal',
  }
]

// XML 解析器配置
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
})

/**
 * 生成文章的唯一哈希ID，避免重复插入
 */
function generateContentHash(title, source, publishedAt) {
  const content = `${title}-${source}-${publishedAt}`
  return crypto.createHash('md5').update(content).digest('hex')
}

/**
 * 提取关键词作为标签
 */
function extractTags(title, content = '') {
  const text = `${title} ${content}`.toLowerCase()
  const keywords = [
    'bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'defi', 'nft', 'dao',
    'regulation', 'sec', 'cftc', 'fed', 'inflation', 'interest rate',
    'market', 'price', 'trading', 'exchange', 'wallet', 'mining',
    'altcoin', 'stablecoin', 'cbdc', 'web3', 'metaverse', 'blockchain'
  ]
  
  return keywords.filter(keyword => text.includes(keyword))
}

/**
 * 判断新闻重要性
 */
function determineImportance(title, content = '') {
  const text = `${title} ${content}`.toLowerCase()
  
  const breakingKeywords = ['breaking', 'urgent', 'alert', 'crash', 'surge', 'hack', 'ban']
  const importantKeywords = ['sec', 'fed', 'regulation', 'launch', 'partnership', 'acquisition']
  
  if (breakingKeywords.some(keyword => text.includes(keyword))) {
    return 'breaking'
  }
  
  if (importantKeywords.some(keyword => text.includes(keyword))) {
    return 'important'
  }
  
  return 'normal'
}

/**
 * 简单的英文到中文标题翻译（关键词映射）
 */
function translateTitle(englishTitle) {
  const translations = {
    'bitcoin': '比特币',
    'ethereum': '以太坊',
    'crypto': '加密货币',
    'defi': 'DeFi',
    'nft': 'NFT',
    'regulation': '监管',
    'sec': 'SEC',
    'fed': '美联储',
    'market': '市场',
    'price': '价格',
    'trading': '交易',
    'exchange': '交易所',
    'breaks': '突破',
    'surge': '飙升',
    'crash': '暴跌',
    'ban': '禁止',
    'launch': '推出',
    'partnership': '合作',
  }
  
  let chineseTitle = englishTitle
  for (const [en, zh] of Object.entries(translations)) {
    const regex = new RegExp(en, 'gi')
    chineseTitle = chineseTitle.replace(regex, zh)
  }
  
  return chineseTitle
}

/**
 * 获取RSS数据
 */
async function fetchRSSFeed(source) {
  try {
    console.log(`正在获取 ${source.name} RSS 数据...`)
    
    const response = await fetch(source.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FlashNews-Collector/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml'
      },
      timeout: 30000
    })
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    
    const xmlText = await response.text()
    const parsed = xmlParser.parse(xmlText)
    
    // 处理不同的 RSS 格式
    let items = []
    if (parsed.rss?.channel?.item) {
      items = Array.isArray(parsed.rss.channel.item) ? parsed.rss.channel.item : [parsed.rss.channel.item]
    } else if (parsed.feed?.entry) {
      items = Array.isArray(parsed.feed.entry) ? parsed.feed.entry : [parsed.feed.entry]
    }
    
    console.log(`${source.name}: 获取到 ${items.length} 条新闻`)
    return items
  } catch (error) {
    console.error(`获取 ${source.name} RSS 失败:`, error.message)
    return []
  }
}

/**
 * 处理单个新闻项
 */
function processNewsItem(item, source) {
  try {
    // 提取标题
    let title = item.title || item.title?.['#text'] || ''
    if (typeof title === 'object' && title['#text']) {
      title = title['#text']
    }
    title = title.trim()
    
    // 提取内容/描述
    let content = item.description || item.summary || item.content || ''
    if (typeof content === 'object' && content['#text']) {
      content = content['#text']
    }
    if (typeof content === 'object' && content['@_type'] === 'html') {
      content = content['#text'] || ''
    }
    
    // 清理 HTML 标签
    content = content.replace(/<[^>]*>/g, '').trim()
    
    // 提取链接
    let link = item.link || item.guid || ''
    if (typeof link === 'object') {
      link = link['@_href'] || link['#text'] || ''
    }
    
    // 提取发布时间
    let publishedAt = item.pubDate || item.published || item['dc:date'] || new Date().toISOString()
    if (publishedAt) {
      try {
        publishedAt = new Date(publishedAt).toISOString()
      } catch {
        publishedAt = new Date().toISOString()
      }
    }
    
    if (!title) {
      return null
    }
    
    // 生成内容哈希，避免重复
    const contentHash = generateContentHash(title, source.name, publishedAt)
    
    // 提取标签
    const tags = extractTags(title, content)
    
    // 判断重要性
    const importance = determineImportance(title, content)
    
    // 生成中文标题（简单映射）
    const titleZh = translateTitle(title)
    
    return {
      title: title,
      title_zh: titleZh !== title ? titleZh : null,
      title_en: title,
      content: content || null,
      source: source.name,
      source_url: link || null,
      category: source.category,
      importance: importance,
      tags: tags,
      published_at: publishedAt,
      content_hash: contentHash
    }
  } catch (error) {
    console.error('处理新闻项失败:', error)
    return null
  }
}

/**
 * 保存新闻到数据库
 */
async function saveNewsItems(newsItems) {
  if (!newsItems || newsItems.length === 0) {
    return { success: 0, duplicates: 0, errors: 0 }
  }
  
  let success = 0
  let duplicates = 0
  let errors = 0
  
  for (const newsItem of newsItems) {
    try {
      // 检查是否已存在（基于内容哈希）
      const { data: existing } = await supabase
        .from('flash_news')
        .select('id')
        .eq('source', newsItem.source)
        .eq('title', newsItem.title)
        .eq('published_at', newsItem.published_at)
        .maybeSingle()
      
      if (existing) {
        duplicates++
        continue
      }
      
      // 插入新记录
      const { data, error } = await supabase
        .from('flash_news')
        .insert(newsItem)
        .select()
      
      if (error) {
        console.error('插入新闻失败:', error)
        errors++
      } else {
        success++
        console.log(`✓ 已保存: ${newsItem.title.substring(0, 50)}...`)
      }
    } catch (error) {
      console.error('保存新闻项失败:', error)
      errors++
    }
  }
  
  return { success, duplicates, errors }
}

/**
 * 主函数
 */
async function main() {
  console.log('🚀 开始收集 Flash News...')
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`数据源数量: ${RSS_SOURCES.length}`)
  
  let totalProcessed = 0
  let totalSuccess = 0
  let totalDuplicates = 0
  let totalErrors = 0
  
  for (const source of RSS_SOURCES) {
    try {
      // 获取RSS数据
      const rssItems = await fetchRSSFeed(source)
      
      if (rssItems.length === 0) {
        console.log(`${source.name}: 无数据`)
        continue
      }
      
      // 处理新闻项
      const newsItems = rssItems
        .map(item => processNewsItem(item, source))
        .filter(item => item !== null)
        .slice(0, 10) // 限制每个源最多10条，避免过载
      
      totalProcessed += newsItems.length
      
      if (newsItems.length === 0) {
        console.log(`${source.name}: 处理后无有效数据`)
        continue
      }
      
      // 保存到数据库
      const result = await saveNewsItems(newsItems)
      totalSuccess += result.success
      totalDuplicates += result.duplicates
      totalErrors += result.errors
      
      console.log(`${source.name}: 成功 ${result.success}, 重复 ${result.duplicates}, 错误 ${result.errors}`)
      
      // 避免请求过于频繁
      await new Promise(resolve => setTimeout(resolve, 2000))
    } catch (error) {
      console.error(`处理 ${source.name} 时出错:`, error)
      totalErrors++
    }
  }
  
  console.log('\n📊 收集完成!')
  console.log(`总处理: ${totalProcessed}`)
  console.log(`成功插入: ${totalSuccess}`)
  console.log(`重复跳过: ${totalDuplicates}`)
  console.log(`错误: ${totalErrors}`)
  console.log(`完成时间: ${new Date().toISOString()}`)
  
  process.exit(0)
}

// 运行主函数
main().catch(error => {
  console.error('脚本执行失败:', error)
  process.exit(1)
})