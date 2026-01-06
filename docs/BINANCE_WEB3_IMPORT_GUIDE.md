# Binance Web3 Leaderboard 数据导入指南

本指南说明如何将 [Binance Web3 Leaderboard](https://web3.binance.com/en/leaderboard?chain=bsc) 的数据导入到你的网站。

## 📋 方法概述

我们提供了多种获取 Binance Web3 Leaderboard 数据的方法：

1. **批量获取所有页面**（推荐，自动化）⭐
2. **手动导出 JSON**（可靠，但需要手动操作）
3. **使用 Puppeteer 自动爬取**（需要安装依赖）
4. **尝试 API 端点**（可能不工作）

---

## 🚀 方法1: 批量获取所有页面（推荐）

### 快速开始

#### 步骤 1: 自动发现 API 端点（推荐）

运行端点发现工具，自动找到可用的 API：

```bash
node scripts/find_binance_web3_api.mjs
```

这个脚本会：
- 自动测试多个可能的 API 端点
- 显示找到的可用端点
- 提供使用说明

#### 步骤 2: 设置 API 端点（如果自动发现失败）

如果自动发现失败，可以手动设置：

1. **从浏览器找到 API 端点**
   - 打开 https://web3.binance.com/en/leaderboard?chain=bsc
   - 按 `F12` 打开开发者工具
   - 切换到 **Network** 标签
   - 刷新页面，查找包含 `leaderboard` 的 API 请求
   - 复制完整的 URL

2. **设置环境变量**
   ```bash
   # 将 URL 中的 page=1 替换为 {page}，size=25 替换为 {size}
   export BINANCE_WEB3_API_URL="https://www.binance.com/bapi/web3/v1/public/leaderboard?chain=bsc&page={page}&size={size}"
   ```

#### 步骤 3: 运行批量获取脚本

```bash
# 获取所有页面（脚本会自动发现端点）
node scripts/fetch_binance_web3_all_pages.mjs

# 只获取前 5 页（用于测试）
node scripts/fetch_binance_web3_all_pages.mjs bsc 5

# 只保存数据，不导入数据库
node scripts/fetch_binance_web3_all_pages.mjs --save-only
```

**注意**：脚本会自动尝试多个可能的端点，如果找到可用的端点，会缓存起来供后续使用。

### 功能特点

- ✅ **自动获取所有页面**：脚本会自动检测总页数并获取所有数据
- ✅ **批量处理**：分批获取页面，避免触发限流
- ✅ **自动导入**：获取完成后自动导入到 Supabase
- ✅ **数据保存**：自动保存 JSON 文件备份
- ✅ **错误处理**：单页失败不影响其他页面

### 脚本参数

```bash
node scripts/fetch_binance_web3_all_pages.mjs [chain] [maxPages] [--save-only]
```

- `chain`: 链名称，默认 `bsc`
- `maxPages`: 最大页数（可选，用于测试）
- `--save-only`: 只保存数据，不导入数据库

### 输出

脚本会：
1. 显示获取进度（每页的数据量）
2. 保存完整数据到 JSON 文件（`binance_web3_all_pages_<timestamp>.json`）
3. 自动导入到 Supabase（除非使用 `--save-only`）

### 注意事项

- ⚠️ **API 端点**：需要从浏览器开发者工具中找到正确的 API URL
- ⚠️ **限流**：脚本已内置延迟机制，但如果遇到限流，可以增加 `DELAY_MS` 的值
- ⚠️ **数据量**：36 页 × 25 条 = 约 900 条数据，获取可能需要几分钟

---

## 🎯 方法1: 手动导出 JSON（推荐）

### 步骤

1. **打开 Binance Web3 Leaderboard 页面**
   ```
   https://web3.binance.com/en/leaderboard?chain=bsc
   ```

2. **打开浏览器开发者工具**
   - 按 `F12` 或右键选择"检查"
   - 切换到 **Network（网络）** 标签

3. **刷新页面**
   - 按 `F5` 刷新页面
   - 在 Network 标签中查找 API 请求

4. **查找数据请求**
   - 在 Network 标签的筛选器中输入 `leaderboard` 或 `api` 或 `bapi`
   - 查找返回 JSON 数据的请求（通常是 XHR 或 Fetch 类型）
   - 常见的 API 端点可能类似：`/bapi/web3/v1/public/leaderboard` 或类似路径
   - 点击请求，查看 **Response（响应）** 标签

5. **识别数据格式**
   - Binance Web3 API 响应格式通常是：
     ```json
     {
       "code": "000000",
       "data": {
         "data": [...],  // 交易员数组
         "pages": 36,    // 总页数
         "size": 25,     // 每页大小
         "current": 1    // 当前页
       }
     }
     ```
   - 每个交易员对象包含：
     - `address`: 钱包地址
     - `addressLabel`: 名称/标签
     - `addressLogo`: 头像 URL
     - `realizedPnlPercent`: ROI（小数形式，如 0.22 = 22%）
     - `realizedPnl`: 已实现盈亏
     - `winRate`: 胜率
     - `totalVolume`: 总交易量
     - `avgBuyVolume`: 平均买入量
     - 等等

6. **复制响应数据**
   - 右键点击响应数据
   - 选择 "Copy" → "Copy response"
   - 或者直接复制 JSON 文本

7. **保存为 JSON 文件**
   - 将复制的数据保存为 `binance_web3_data.json`
   - 确保文件格式正确（有效的 JSON）
   - **注意**：如果 API 返回的是分页数据，你可能需要获取多页数据并合并

8. **运行导入脚本**
   ```bash
   node scripts/import_binance_web3_leaderboard.mjs binance_web3_data.json
   ```

### 获取多页数据（如果需要）

如果 API 支持分页，你可能需要获取所有页面的数据：

1. 修改 API 请求的 `current` 参数（或类似的分页参数）
2. 获取每一页的数据
3. 将所有页面的 `data.data` 数组合并
4. 保存为单个 JSON 文件

或者，你可以编写一个简单的脚本来循环获取所有页面。

---

## 🤖 方法2: 使用 Puppeteer 自动爬取

### 安装依赖

```bash
npm install puppeteer
```

### 运行脚本

```bash
node scripts/import_binance_web3_leaderboard.mjs
```

脚本会自动：
1. 启动浏览器
2. 访问 Binance Web3 Leaderboard 页面
3. 等待数据加载
4. 提取数据
5. 导入到 Supabase

### 注意事项

- 首次运行会下载 Chromium 浏览器（约 100MB）
- 如果页面结构变化，可能需要更新脚本中的选择器
- 某些网站可能检测爬虫，导致失败

---

## 🔍 方法3: 查找 API 端点

如果 Binance Web3 有公开的 API，你可以：

1. **在浏览器开发者工具中查找**
   - 打开 Network 标签
   - 刷新页面
   - 查找包含数据的 API 请求
   - 记录请求 URL 和参数

2. **更新脚本中的 API 端点**
   - 编辑 `scripts/import_binance_web3_leaderboard.mjs`
   - 在 `fetchFromBinanceWeb3API` 函数中添加实际的 API 端点

---

## 📊 数据格式

脚本支持多种 JSON 格式，会自动识别：

```json
// 格式1: 数组
[
  {
    "encryptedUid": "xxx",
    "nickName": "Trader1",
    "roi": 150.5,
    "pnl": 10000,
    "followerCount": 500
  }
]

// 格式2: 嵌套对象
{
  "data": [...],
  "result": [...],
  "list": [...],
  "leaderboard": [...]
}
```

---

## 🔧 环境变量

确保设置了以下环境变量：

```bash
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

或者在 `.env` 文件中：

```
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJxxx...
```

---

## 📝 使用示例

### 从 JSON 文件导入

```bash
# 导入 BSC 链数据
node scripts/import_binance_web3_leaderboard.mjs binance_web3_data.json

# 导入其他链（如果支持）
node scripts/import_binance_web3_leaderboard.mjs binance_web3_data.json eth
```

### 自动爬取（需要 Puppeteer）

```bash
node scripts/import_binance_web3_leaderboard.mjs
```

---

## 🐛 故障排除

### 问题1: "无法识别 JSON 格式"

**解决方案：**
- 检查 JSON 文件是否有效
- 查看文件内容，确认数据结构
- 可能需要调整 `parseManualJSON` 函数

### 问题2: Puppeteer 安装失败

**解决方案：**
- 使用国内镜像：`npm install puppeteer --registry=https://registry.npmmirror.com`
- 或者使用手动导出方法

### 问题3: 网页爬取失败

**解决方案：**
- 检查网络连接
- 确认页面 URL 是否正确
- 页面结构可能已变化，需要更新选择器
- 使用手动导出方法

### 问题4: 数据库导入失败

**解决方案：**
- 检查环境变量是否正确
- 确认 Supabase 表结构是否正确
- 查看错误信息，可能是字段不匹配

---

## 📚 相关文件

- `scripts/import_binance_web3_leaderboard.mjs` - 导入脚本
- `scripts/import_binance_leaderboard.mjs` - Binance Futures 导入脚本（参考）
- `scripts/import_bybit_leaderboard.mjs` - Bybit 导入脚本（参考）

---

## 💡 提示

1. **定期更新数据**：建议设置定时任务（cron job）定期导入最新数据
2. **数据验证**：导入前检查数据质量，确保 ROI、PnL 等字段有效
3. **备份数据**：导入前备份数据库，以防出错
4. **监控日志**：关注导入日志，及时发现问题

---

## 🔗 相关链接

- [Binance Web3 Leaderboard](https://web3.binance.com/en/leaderboard?chain=bsc)
- [Supabase 文档](https://supabase.com/docs)
- [Puppeteer 文档](https://pptr.dev/)

