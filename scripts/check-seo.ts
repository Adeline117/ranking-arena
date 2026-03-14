#!/usr/bin/env tsx
/**
 * SEO Metadata Checker
 * 检查所有核心页面的 SEO 元数据配置
 */

import fs from 'fs';
import path from 'path';

interface MetadataIssue {
  page: string;
  issues: string[];
}

const pages = [
  // 首页
  'app/page.tsx',
  
  // 排行榜
  'app/rankings/page.tsx',
  'app/rankings/[exchange]/page.tsx',
  'app/rankings/bots/page.tsx',
  'app/rankings/institutions/page.tsx',
  'app/rankings/traders/page.tsx',
  'app/rankings/tools/page.tsx',
  'app/rankings/resources/page.tsx',
  
  // Trader详情
  'app/trader/[handle]/page.tsx',
  
  // 搜索
  'app/search/page.tsx',
  
  // 静态页面
  'app/(legal)/about/page.tsx',
  'app/pricing/page.tsx',
  'app/methodology/page.tsx',
  'app/(legal)/privacy/page.tsx',
  'app/(legal)/terms/page.tsx',
  'app/help/page.tsx',
];

const results: MetadataIssue[] = [];
const titles = new Set<string>();
const duplicateTitles: string[] = [];

for (const pagePath of pages) {
  const fullPath = path.join(process.cwd(), pagePath);
  
  if (!fs.existsSync(fullPath)) {
    results.push({ page: pagePath, issues: ['文件不存在'] });
    continue;
  }
  
  const content = fs.readFileSync(fullPath, 'utf-8');
  const issues: string[] = [];
  
  // 检查是否有 metadata export
  const hasMetadata = content.includes('export const metadata') || 
                      content.includes('export async function generateMetadata');
  
  if (!hasMetadata) {
    issues.push('❌ 缺失 metadata export');
  } else {
    // 提取 title
    const titleMatch = content.match(/title:\s*['"`]([^'"`]+)['"`]/);
    if (!titleMatch) {
      issues.push('❌ 缺失 title');
    } else {
      const title = titleMatch[1];
      if (title.length === 0) {
        issues.push('❌ title 为空');
      } else if (title.length >= 60) {
        issues.push(`⚠️  title 过长 (${title.length} 字符): ${title.substring(0, 50)}...`);
      }
      
      // 检查重复
      if (titles.has(title)) {
        issues.push(`❌ title 重复: "${title}"`);
        duplicateTitles.push(title);
      } else {
        titles.add(title);
      }
    }
    
    // 检查 description
    const descMatch = content.match(/description:\s*['"`]([^'"`]+)['"`]/);
    if (!descMatch) {
      issues.push('❌ 缺失 description');
    } else {
      const desc = descMatch[1];
      if (desc.length === 0) {
        issues.push('❌ description 为空');
      } else if (desc.length < 120) {
        issues.push(`⚠️  description 过短 (${desc.length} 字符)`);
      } else if (desc.length > 160) {
        issues.push(`⚠️  description 过长 (${desc.length} 字符)`);
      }
    }
    
    // 检查 openGraph
    if (!content.includes('openGraph:')) {
      issues.push('❌ 缺失 openGraph 配置');
    } else {
      // 检查 og:title
      const ogTitleMatch = content.match(/openGraph:\s*{[^}]*title:\s*['"`]([^'"`]+)['"`]/s);
      if (!ogTitleMatch) {
        issues.push('⚠️  openGraph 缺失 title');
      }
      
      // 检查 og:description
      const ogDescMatch = content.match(/openGraph:\s*{[^}]*description:\s*['"`]([^'"`]+)['"`]/s);
      if (!ogDescMatch) {
        issues.push('⚠️  openGraph 缺失 description');
      }
      
      // 检查 og:image
      if (!content.includes('images:') && !content.includes('image:')) {
        issues.push('❌ openGraph 缺失 images');
      } else {
        // 检查是否是绝对 URL
        const ogImageMatch = content.match(/images?:\s*\[?['"`]([^'"`]+)['"`]/);
        if (ogImageMatch && !ogImageMatch[1].startsWith('http')) {
          issues.push('❌ og:image 不是绝对URL');
        }
      }
      
      // 检查 og:url
      if (!content.includes('url:')) {
        issues.push('⚠️  openGraph 缺失 url');
      }
    }
  }
  
  if (issues.length > 0) {
    results.push({ page: pagePath, issues });
  }
}

// 输出报告
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Round 7 — 维度9：SEO和Meta检查');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`检查页面: ${pages.length}个`);
console.log(`有问题页面: ${results.length}个`);
console.log('');

if (results.length > 0) {
  console.log('📋 问题清单:\n');
  for (const { page, issues } of results) {
    console.log(`📄 ${page}`);
    for (const issue of issues) {
      console.log(`   ${issue}`);
    }
    console.log('');
  }
}

// 统计
let missingTitle = 0;
let missingDescription = 0;
let missingOgImage = 0;
let missingOpenGraph = 0;

for (const { issues } of results) {
  for (const issue of issues) {
    if (issue.includes('缺失 title')) missingTitle++;
    if (issue.includes('缺失 description')) missingDescription++;
    if (issue.includes('缺失 images')) missingOgImage++;
    if (issue.includes('缺失 openGraph')) missingOpenGraph++;
  }
}

console.log('📊 统计:');
console.log(`   缺失 title: ${missingTitle}个`);
console.log(`   缺失 description: ${missingDescription}个`);
console.log(`   缺失 og:image: ${missingOgImage}个`);
console.log(`   缺失 openGraph: ${missingOpenGraph}个`);
console.log(`   重复 title: ${new Set(duplicateTitles).size}个`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

process.exit(results.length > 0 ? 1 : 0);
