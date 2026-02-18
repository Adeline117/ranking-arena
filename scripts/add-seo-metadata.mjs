import fs from 'fs'
import path from 'path'

const pages = {
  'app/settings/page.tsx': { title: '设置 - Arena', desc: '管理你的 Arena 账户设置、通知偏好和安全选项。' },
  'app/my-posts/page.tsx': { title: '我的动态 - Arena', desc: '查看和管理你在 Arena 发布的所有动态。' },
  'app/inbox/page.tsx': { title: '消息 - Arena', desc: '查看通知和私信。' },
  'app/favorites/page.tsx': { title: '收藏 - Arena', desc: '你收藏的交易员、帖子和资源。' },
  'app/groups/page.tsx': { title: '小组 - Arena', desc: '浏览和加入 Arena 交易小组，与志同道合的交易者交流策略。' },
  'app/user-center/page.tsx': { title: '会员中心 - Arena', desc: '管理你的 Arena 会员订阅和账户信息。' },
  'app/search/page.tsx': { title: '搜索 - Arena', desc: '搜索交易员、帖子、小组和资源。' },
  'app/rankings/institutions/page.tsx': { title: '机构排行 - Arena', desc: '全球顶级加密机构排行榜，涵盖交易所、VC、DeFi 协议等。' },
  'app/rankings/tools/page.tsx': { title: '工具排行 - Arena', desc: '最佳加密交易工具和服务排行，助你提升交易效率。' },
  'app/rankings/traders/page.tsx': { title: '交易员排行榜 - Arena', desc: '全平台顶级加密交易员排行，实时 ROI、胜率、Arena Score 数据。' },
  'app/rankings/page.tsx': { title: '排行榜 - Arena', desc: '多维度加密交易员排行榜，覆盖20+交易所，实时更新。Enter. Outperform.' },
  'app/flash-news/page.tsx': { title: '快讯 - Arena', desc: '实时加密货币与金融市场快讯，来自全球顶级媒体。' },
  'app/compare/page.tsx': { title: '交易员对比 - Arena', desc: '对比不同交易员的收益率、胜率、回撤等核心指标。' },
  'app/hot/page.tsx': { title: '热榜 - Arena', desc: '最热门的交易讨论、帖子和社区动态。' },
  'app/market/page.tsx': { title: '行情 - Arena', desc: '实时加密货币行情，涵盖BTC、ETH、SOL等主流币种价格。' },
  'app/following/page.tsx': { title: '关注 - Arena', desc: '查看你关注的交易员的最新动态。' },
  'app/login/page.tsx': { title: '登录 - Arena | Enter. Outperform.', desc: '登录 Arena，发现全球顶级交易员。入场，超越。' },
  'app/(legal)/privacy/page.tsx': { title: '隐私政策 - Arena', desc: 'Arena 隐私政策，了解我们如何保护你的个人信息。' },
  'app/(legal)/terms/page.tsx': { title: '服务条款 - Arena', desc: 'Arena 服务条款和使用协议。' },
  'app/(legal)/about/page.tsx': { title: '关于 Arena', desc: 'Arena 是全球领先的加密交易员排名和社交平台。入场，超越。' },
  'app/(legal)/dmca/page.tsx': { title: 'DMCA - Arena', desc: 'Arena DMCA 版权投诉流程。' },
  'app/(legal)/disclaimer/page.tsx': { title: '免责声明 - Arena', desc: 'Arena 平台免责声明和风险提示。' },
  'app/help/page.tsx': { title: '帮助中心 - Arena', desc: 'Arena 帮助中心，常见问题解答。' },
  'app/rankings/bots/page.tsx': { title: '机器人排行 - Arena', desc: '顶级加密交易机器人排行榜。' },
  'app/welcome/page.tsx': { title: '欢迎 - Arena', desc: '欢迎加入 Arena。入场，超越。' },
  'app/portfolio/page.tsx': { title: '资产组合 - Arena', desc: '查看和管理你的加密资产组合。' },
  'app/membership/page.tsx': { title: '会员 - Arena', desc: 'Arena Pro 会员，解锁高级功能。' },
}

let count = 0
for (const [filePath, meta] of Object.entries(pages)) {
  const fullPath = path.resolve(filePath)
  if (!fs.existsSync(fullPath)) {
    console.log(`SKIP (not found): ${filePath}`)
    continue
  }
  
  let content = fs.readFileSync(fullPath, 'utf-8')
  
  // Skip if already has metadata
  if (content.includes('export const metadata') || content.includes('export async function generateMetadata')) {
    console.log(`SKIP (has metadata): ${filePath}`)
    continue
  }
  
  // Check if Metadata is already imported
  const hasMetadataImport = content.includes("import type { Metadata }") || content.includes("import { Metadata")
  
  // Add Metadata import if needed
  if (!hasMetadataImport) {
    // Try to add after existing next imports
    if (content.includes("from 'next'") || content.includes('from "next"')) {
      // Already imports from next - add Metadata type
      // Don't modify imports, just add a separate import
      const metadataImport = "import type { Metadata } from 'next'\n"
      content = metadataImport + content
    } else {
      const metadataImport = "import type { Metadata } from 'next'\n"
      content = metadataImport + content
    }
  }
  
  // Find a good place to insert metadata export (before the default export)
  const metadataExport = `\nexport const metadata: Metadata = {\n  title: '${meta.title}',\n  description: '${meta.desc}',\n}\n`
  
  // Insert before the first 'export default' or 'export async function' that's the page component
  const defaultExportMatch = content.match(/\n(export default )/)
  if (defaultExportMatch) {
    const idx = content.indexOf(defaultExportMatch[0])
    content = content.slice(0, idx) + metadataExport + content.slice(idx)
  } else {
    // Append before last export
    content = content + metadataExport
  }
  
  fs.writeFileSync(fullPath, content)
  console.log(`ADDED: ${filePath}`)
  count++
}
console.log(`\nDone: ${count} pages updated`)
