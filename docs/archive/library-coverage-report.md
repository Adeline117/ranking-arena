# Library EPUB 覆盖率检查报告

## 执行时间
2026-02-23 19:11 PST

## 当前覆盖率统计

### 数据库统计
- **总条目数**: 56,382
- **书籍总数**: 29,695
- **已有PDF的书籍**: 1,847
- **已有EPUB的书籍**: 1,410
- **无文件的书籍**: 26,459
- **当前覆盖率**: **10.90%**

### 存储桶统计
- **library-files bucket**: 3,055 个文件

## 下载源可用性测试

### Anna's Archive
- **状态**: ❌ 不可用
- **响应**: 403 Forbidden
- **原因**: DDoS-Guard 保护，Mac Mini 也被阻止
- **影响**: 无法通过 Anna's Archive 搜索书籍

### LibGen
- **状态**: ✅ 可用
- **响应**: 200 OK
- **限制**: 需要先通过 Anna's Archive 获取 MD5

### Project Gutenberg
- **状态**: ✅ 可用（通过 gutendex API）
- **限制**: 仅限公共领域书籍（约 70K 本）
- **适用性**: 可用于补充部分书籍

### Internet Archive
- **状态**: ❓ 未测试
- **限制**: 需要预先获取的目录文件
- **适用性**: 需要额外准备工作

## 下载尝试结果

运行 `download-books-concurrent.mjs` (20本书):
- **成功下载**: 0/20
- **失败原因**: Anna's Archive 返回 403，无法搜索到书籍

## 可用脚本

### 主要下载脚本
1. `download-books-concurrent.mjs` - 使用 Anna's Archive (当前不可用)
2. `download-books-turbo.mjs` - 使用 Anna's Archive (当前不可用)

### 替代脚本
1. `backfill-books-gutenberg.mjs` - Project Gutenberg 源 (可用)
2. `backfill-books-ia-*.mjs` - Internet Archive 源 (需要准备)
3. `backfill-books-openlibrary.mjs` - OpenLibrary 源 (未测试)

## 问题分析

### 主要障碍
1. **Anna's Archive 被 DDoS-Guard 保护阻止**，即使在 Mac Mini 上也无法访问
2. **LibGen 虽然可访问**，但需要 MD5 才能下载，而 MD5 通常通过 Anna's Archive 搜索获取
3. **现有下载脚本都依赖 Anna's Archive** 作为搜索入口

### 次要问题
1. VPS 已被 Anna's Archive 封锁（规则已确认）
2. 即使在 Mac Mini 上也被阻止（测试已确认）

## 建议

### 短期方案
1. **运行 Gutenberg 脚本** - 可补充公共领域书籍
   ```bash
   node backfill-books-gutenberg.mjs 1000
   ```

2. **准备 Internet Archive 数据** - 需要先获取目录
   - 可能需要单独的脚本从 IA 获取书籍列表

### 长期方案
1. **修改下载脚本** - 使用其他搜索源（OpenLibrary, Google Books API）
2. **直接使用 LibGen API** - 研究是否有直接的搜索接口
3. **用户上传功能** - 允许用户贡献 EPUB 文件

## 数据总结

- **已有文件**: 3,236 本 (10.90%)
- **还需下载**: 26,459 本 (89.10%)
- **可行下载**: 取决于替代源的可用性

## 下一步行动

1. ✅ 测试 Gutenberg 脚本的可用性
2. ⏭️ 研究 OpenLibrary 和 Google Books API 作为搜索源
3. ⏭️ 考虑用户上传或社区贡献模式
