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
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

// RSS 数据源配置
const RSS_SOURCES = [
  // ─── Major Crypto Media (English) ───
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
    url: 'https://www.theblock.co/rss.xml',
    category: 'crypto',
    language: 'en',
    importance: 'important',
  },
  {
    name: 'Decrypt',
    url: 'https://decrypt.co/feed',
    category: 'crypto',
    language: 'en',
    importance: 'important',
  },
  {
    name: 'DL News',
    url: 'https://www.dlnews.com/arc/outboundfeeds/rss/',
    category: 'crypto',
    language: 'en',
    importance: 'important',
  },
  {
    name: 'CryptoSlate',
    url: 'https://cryptoslate.com/feed/',
    category: 'crypto',
    language: 'en',
    importance: 'normal',
  },
  {
    name: 'CryptoBriefing',
    url: 'https://cryptobriefing.com/feed/',
    category: 'crypto',
    language: 'en',
    importance: 'normal',
  },
  {
    name: 'Bitcoin Magazine',
    url: 'https://bitcoinmagazine.com/.rss/full/',
    category: 'crypto',
    language: 'en',
    importance: 'normal',
  },
  {
    name: 'BeInCrypto',
    url: 'https://beincrypto.com/feed/',
    category: 'crypto',
    language: 'en',
    importance: 'normal',
  },
  // ─── DeFi & Protocol Sources ───
  {
    name: 'DeFi Llama',
    url: 'https://defillama.com/rss',
    category: 'defi',
    language: 'en',
    importance: 'normal',
  },
  {
    name: 'Bankless',
    url: 'https://feeds.banklesshq.com/rss',
    category: 'defi',
    language: 'en',
    importance: 'normal',
  },
  {
    name: 'Ethereum Blog',
    url: 'https://blog.ethereum.org/feed.xml',
    category: 'defi',
    language: 'en',
    importance: 'important',
  },
  {
    name: 'Uniswap Blog',
    url: 'https://blog.uniswap.org/rss.xml',
    category: 'defi',
    language: 'en',
    importance: 'normal',
  },
  {
    name: 'Chainlink Blog',
    url: 'https://blog.chain.link/rss/',
    category: 'defi',
    language: 'en',
    importance: 'normal',
  },
  {
    name: 'Compound Finance',
    url: 'https://medium.com/feed/compound-finance',
    category: 'defi',
    language: 'en',
    importance: 'normal',
  },
  {
    name: 'Aave',
    url: 'https://aave.mirror.xyz/feed/atom',
    category: 'defi',
    language: 'en',
    importance: 'normal',
  },
  {
    name: 'MakerDAO Blog',
    url: 'https://blog.makerdao.com/feed',
    category: 'defi',
    language: 'en',
    importance: 'normal',
  },
  {
    name: 'Arbitrum (Offchain Labs)',
    url: 'https://medium.com/feed/offchainlabs',
    category: 'defi',
    language: 'en',
    importance: 'normal',
  },
  {
    name: 'Celestia Blog',
    url: 'https://blog.celestia.org/rss/',
    category: 'defi',
    language: 'en',
    importance: 'normal',
  },
  // ─── Exchange & Trading Sources ───
  {
    name: 'Kraken Blog',
    url: 'https://blog.kraken.com/feed/',
    category: 'market',
    language: 'en',
    importance: 'normal',
  },
  {
    name: 'BitMEX Blog',
    url: 'https://blog.bitmex.com/feed/',
    category: 'market',
    language: 'en',
    importance: 'normal',
  },
  {
    name: 'Crypto.com Blog',
    url: 'https://blog.crypto.com/rss/',
    category: 'market',
    language: 'en',
    importance: 'normal',
  },
  {
    name: 'Deribit Insights',
    url: 'https://blog.deribit.com/feed/',
    category: 'market',
    language: 'en',
    importance: 'normal',
  },
  // ─── Research & VCs ───
  {
    name: 'a16z Crypto',
    url: 'https://a16zcrypto.com/feed/',
    category: 'crypto',
    language: 'en',
    importance: 'important',
  },
  {
    name: 'Paradigm Research',
    url: 'https://www.paradigm.xyz/feed.xml',
    category: 'crypto',
    language: 'en',
    importance: 'important',
  },
  {
    name: 'Messari',
    url: 'https://messari.io/rss',
    category: 'crypto',
    language: 'en',
    importance: 'important',
  },
  // ─── Macro & Regulation Sources ───
  {
    name: 'Bloomberg Crypto',
    url: 'https://www.bloomberg.com/crypto/feed',
    category: 'macro',
    language: 'en',
    importance: 'important',
  },
  {
    name: 'Reuters Fintech',
    url: 'https://www.reutersagency.com/feed/?best-topics=tech',
    category: 'macro',
    language: 'en',
    importance: 'important',
  },
  {
    name: 'SEC Press Releases',
    url: 'https://www.sec.gov/rss/news/press.xml',
    category: 'regulation',
    language: 'en',
    importance: 'important',
  },
  {
    name: 'CFTC Press Room',
    url: 'https://www.cftc.gov/Newsroom/PressRoom/RSS',
    category: 'regulation',
    language: 'en',
    importance: 'important',
  },
  {
    name: 'Coin Center',
    url: 'https://www.coincenter.org/feed',
    category: 'regulation',
    language: 'en',
    importance: 'normal',
  },
  // ─── Chinese Crypto Media ───
  {
    name: 'Bitfinex Blog (Chinese)',
    url: 'http://blog.bitfinex.com/feed/',
    category: 'crypto',
    language: 'en',
    importance: 'normal',
  },
  {
    name: 'BitMEX Blog (Chinese)',
    url: 'https://blog.bitmex.com/feed/?lang=zh_CN',
    category: 'crypto',
    language: 'zh',
    importance: 'normal',
  },
  {
    name: 'ChainFeeds',
    url: 'http://mirror.xyz/chainfeeds.eth/feed/atom',
    category: 'crypto',
    language: 'zh',
    importance: 'normal',
  },
  {
    name: 'Mask Network (Chinese)',
    url: 'https://news.mask.io/zh-Hans/rss-feed.xml',
    category: 'crypto',
    language: 'zh',
    importance: 'normal',
  },
]

// XML 解析器配置
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: true,
})

/**
 * Decode HTML entities in text
 */
function decodeHtmlEntities(text) {
  if (!text) return text
  const entities = {
    '&#8217;': '\u2019', '&#8216;': '\u2018', '&#8220;': '\u201c', '&#8221;': '\u201d',
    '&#038;': '&', '&#8211;': '\u2013', '&#8212;': '\u2014', '&#160;': ' ',
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
    '&#39;': "'", '&nbsp;': ' ',
  }
  let result = text
  for (const [entity, char] of Object.entries(entities)) {
    result = result.replaceAll(entity, char)
  }
  // Decode remaining numeric entities
  result = result.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
  return result
}

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
 * 使用 OpenAI GPT 翻译标题到中文
 */
async function translateTitleWithGPT(englishTitle) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    console.warn('OPENAI_API_KEY not set, skipping translation')
    return null
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a professional crypto/finance news translator. Translate the English headline to natural, fluent Simplified Chinese. Keep proper nouns, token symbols (BTC, ETH), and abbreviations (SEC, CFTC) as-is. Output ONLY the translated text.'
          },
          { role: 'user', content: englishTitle }
        ],
        temperature: 0.3,
        max_tokens: 200,
      }),
    })

    if (!response.ok) return null
    const data = await response.json()
    return data.choices?.[0]?.message?.content?.trim() || null
  } catch (error) {
    console.error('GPT translation failed:', error.message)
    return null
  }
}

/**
 * 批量翻译标题（减少 API 调用次数）
 */
async function translateTitlesBatch(titles) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey || titles.length === 0) return titles.map(() => null)

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a professional crypto/finance news translator. Translate each English headline to natural, fluent Simplified Chinese. Keep proper nouns, token symbols (BTC, ETH), and abbreviations (SEC, CFTC) as-is. Output ONLY a JSON array of translated strings in the same order.'
          },
          { role: 'user', content: JSON.stringify(titles) }
        ],
        temperature: 0.3,
        max_tokens: 4000,
      }),
    })

    if (!response.ok) return titles.map(() => null)
    const data = await response.json()
    const content = data.choices?.[0]?.message?.content?.trim() || '[]'
    const jsonStr = content.replace(/^```json?\n?/, '').replace(/\n?```$/, '')
    return JSON.parse(jsonStr)
  } catch (error) {
    console.error('Batch GPT translation failed:', error.message)
    return titles.map(() => null)
  }
}

/**
 * 批量翻译内容（减少 API 调用次数）
 */
async function translateContentBatch(contents) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey || contents.length === 0) return contents.map(() => null)

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a professional crypto/finance news translator. Translate each English news content to natural, fluent Simplified Chinese. Keep proper nouns, token symbols (BTC, ETH), and abbreviations (SEC, CFTC) as-is. Output ONLY a JSON array of translated strings in the same order.'
          },
          { role: 'user', content: JSON.stringify(contents) }
        ],
        temperature: 0.3,
        max_tokens: 16000,
      }),
    })

    if (!response.ok) return contents.map(() => null)
    const data = await response.json()
    const content = data.choices?.[0]?.message?.content?.trim() || '[]'
    const jsonStr = content.replace(/^```json?\n?/, '').replace(/\n?```$/, '')
    return JSON.parse(jsonStr)
  } catch (error) {
    console.error('Batch content GPT translation failed:', error.message)
    return contents.map(() => null)
  }
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
    title = decodeHtmlEntities(title.replace(/<[^>]*>/g, '')).trim()
    
    // 提取内容/描述
    let content = item.description || item.summary || item.content || ''
    if (typeof content === 'object' && content['#text']) {
      content = content['#text']
    }
    if (typeof content === 'object' && content['@_type'] === 'html') {
      content = content['#text'] || ''
    }
    
    // 清理 HTML 标签和实体
    content = decodeHtmlEntities(content.replace(/<[^>]*>/g, '')).trim()
    
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
    
    // For Chinese-language sources, set title_zh directly
    const isChineseSource = source.language === 'zh'
    
    return {
      title: title,
      title_zh: isChineseSource ? title : null, // Chinese sources already have Chinese titles
      title_en: isChineseSource ? null : title,  // Will be translated via GPT in batch
      content: content || null,
      content_zh: isChineseSource ? (content || null) : null, // Will be translated via GPT in batch
      source: source.name,
      source_url: link || null,
      category: source.category,
      importance: importance,
      tags: tags,
      published_at: publishedAt
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
      
      // Skip translation for Chinese-language sources (already in Chinese)
      if (source.language !== 'zh') {
        // 批量翻译标题到中文
        try {
          const titles = newsItems.map(item => item.title)
          const translations = await translateTitlesBatch(titles)
          for (let i = 0; i < newsItems.length; i++) {
            if (translations[i]) {
              newsItems[i].title_zh = translations[i]
            }
          }
          console.log(`${source.name}: 翻译了 ${translations.filter(Boolean).length} 条标题`)
        } catch (err) {
          console.error(`${source.name}: 标题批量翻译失败:`, err.message)
        }
        
        // 批量翻译内容到中文
        try {
          const contents = newsItems.map(item => item.content).filter(Boolean)
          if (contents.length > 0) {
            const contentTranslations = await translateContentBatch(contents)
            let ci = 0
            for (let i = 0; i < newsItems.length; i++) {
              if (newsItems[i].content && contentTranslations[ci]) {
                newsItems[i].content_zh = contentTranslations[ci]
              }
              if (newsItems[i].content) ci++
            }
            console.log(`${source.name}: 翻译了 ${contentTranslations.filter(Boolean).length} 条内容`)
          }
        } catch (err) {
          console.error(`${source.name}: 内容批量翻译失败:`, err.message)
        }
      } else {
        console.log(`${source.name}: 中文源，跳过翻译`)
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