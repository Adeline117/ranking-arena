#!/usr/bin/env tsx
/**
 * Final SEO Check - Checks both page.tsx and layout.tsx
 */

import fs from 'fs';
import path from 'path';

interface Issue {
  file: string;
  problems: string[];
}

const corePaths = [
  // 首页
  { page: 'app/page.tsx', layout: null },
  
  // Rankings
  { page: 'app/rankings/page.tsx', layout: 'app/rankings/layout.tsx' },
  { page: 'app/rankings/[exchange]/page.tsx', layout: null },
  { page: 'app/rankings/bots/page.tsx', layout: 'app/rankings/bots/layout.tsx' },
  { page: 'app/rankings/institutions/page.tsx', layout: 'app/rankings/institutions/layout.tsx' },
  { page: 'app/rankings/traders/page.tsx', layout: null },
  { page: 'app/rankings/tools/page.tsx', layout: 'app/rankings/tools/layout.tsx' },
  { page: 'app/rankings/resources/page.tsx', layout: 'app/rankings/resources/layout.tsx' },
  
  // Trader
  { page: 'app/trader/[handle]/page.tsx', layout: 'app/trader/[handle]/layout.tsx' },
  
  // Search
  { page: 'app/search/page.tsx', layout: 'app/search/layout.tsx' },
  
  // Static pages
  { page: 'app/(legal)/about/page.tsx', layout: 'app/(legal)/about/layout.tsx' },
  { page: 'app/pricing/page.tsx', layout: 'app/pricing/layout.tsx' },
  { page: 'app/methodology/page.tsx', layout: 'app/methodology/layout.tsx' },
  { page: 'app/(legal)/privacy/page.tsx', layout: 'app/(legal)/privacy/layout.tsx' },
  { page: 'app/(legal)/terms/page.tsx', layout: 'app/(legal)/terms/layout.tsx' },
  { page: 'app/help/page.tsx', layout: 'app/help/layout.tsx' },
];

const issues: Issue[] = [];
let totalPages = 0;
let pagesWithMetadata = 0;
let pagesWithOG = 0;
let pagesWithTwitter = 0;

for (const { page, layout } of corePaths) {
  totalPages++;
  const checkFile = layout && fs.existsSync(path.join(process.cwd(), layout)) ? layout : page;
  const fullPath = path.join(process.cwd(), checkFile);
  
  if (!fs.existsSync(fullPath)) {
    issues.push({ file: page, problems: ['File not found'] });
    continue;
  }
  
  const content = fs.readFileSync(fullPath, 'utf-8');
  const problems: string[] = [];
  
  // Check for metadata
  const hasMetadata = content.includes('export const metadata') || content.includes('export async function generateMetadata');
  if (!hasMetadata) {
    problems.push('❌ No metadata export');
  } else {
    pagesWithMetadata++;
    
    // Check for openGraph
    if (!content.includes('openGraph')) {
      problems.push('⚠️  Missing openGraph config');
    } else {
      pagesWithOG++;
    }
    
    // Check for twitter
    if (!content.includes('twitter:')) {
      problems.push('⚠️  Missing Twitter card');
    } else {
      pagesWithTwitter++;
    }
    
    // Check for creator
    if (content.includes('twitter:') && !content.includes("creator: '@arenafi'") && !content.includes('creator: "@arenafi"')) {
      problems.push('ℹ️  Twitter card missing creator field');
    }
  }
  
  if (problems.length > 0) {
    issues.push({ file: `${page}${layout ? ` (${layout})` : ''}`, problems });
  }
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Round 7 — 维度9：SEO和Meta最终检查');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`检查页面: ${totalPages}个`);
console.log(`有 metadata: ${pagesWithMetadata}/${totalPages}`);
console.log(`有 openGraph: ${pagesWithOG}/${totalPages}`);
console.log(`有 Twitter card: ${pagesWithTwitter}/${totalPages}`);
console.log('');

if (issues.length > 0) {
  console.log('📋 发现的问题:\n');
  for (const { file, problems } of issues) {
    console.log(`📄 ${file}`);
    for (const problem of problems) {
      console.log(`   ${problem}`);
    }
    console.log('');
  }
} else {
  console.log('✅ 所有核心页面的 SEO metadata 配置完整！');
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

process.exit(issues.length > 0 ? 1 : 0);
