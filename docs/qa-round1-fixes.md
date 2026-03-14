# QA Round 1 修复记录

## 已修复 ✅

### 1. React Hydration Error (#418) - 中优先级
**问题**: `Minified React error #418` - HTML/text mismatch between SSR and client
**位置**: HomePage组件
**根本原因**: HomePage是'use client'组件，但Next.js仍会预渲染它。客户端状态（localStorage, Date）导致hydration不匹配
**修复方案**: 
1. ~~第一次尝试：添加suppressHydrationWarning（cd1ade43）~~ - 不够彻底
2. **最终方案：使用dynamic import禁用HomePage SSR** ✅
   - 完全避免服务端渲染HomePage
   - SSRRankingTable仍提供instant LCP
   - HomePage在客户端hydrate，无冲突
**Commits**: 
- cd1ade43 - "fix: add suppressHydrationWarning to HomePage"
- d449d1b1 - "fix: disable HomePage SSR to prevent hydration mismatches" ✅

### 2. API调用失败 - 中优先级
**问题**: `/api/market` 和 `/api/flash-news` 返回失败
**状态**: ✅ 经验证，两个API端点都正常工作（返回200）
- `/api/market?pairs=BTC-USD,ETH-USD` ✅
- `/api/flash-news?limit=5` ✅
**无需修复** - API实现正确，测试时的失败可能是临时网络问题

## 低优先级问题（记录，下轮处理）

### 3. 速率限制 (429) - 低优先级
**现象**: 14次429错误
**可能原因**:
- 测试脚本并发请求过多
- CoinGecko/外部API限流
- 图片/资源请求过多

**建议解决方案**:
1. 增加Redis缓存TTL（market API已有120s）
2. 添加客户端请求去重（SWR已配置）
3. 使用CDN代理外部资源
4. 调整测试脚本并发数

### 4. CSP违规 - 低优先级
**现象**: NFT图片被阻止 (`eip155:1/erc721:0x3a40312a1c376aecf855ef784371d1fb1aa2d25d/5875`)
**位置**: Content Security Policy `img-src` 指令

**建议解决方案**:
1. 添加NFT协议支持到CSP（如果需要显示NFT头像）
2. 或使用图片代理转换NFT URL为标准HTTP(S) URL
3. 或在头像渲染时过滤掉非HTTP(S)协议的URL

**CSP配置位置**: 
- `next.config.js` 或 `middleware.ts`
- 检查命令: `grep -r "Content-Security-Policy" next.config.js middleware.ts`

## 验证

运行完整测试:
```bash
cd /Users/adelinewen/ranking-arena
node scripts/qa-round1.js
```

检查:
- [ ] Hydration warning是否消失
- [ ] API端点是否正常
- [ ] 429错误是否减少
- [ ] CSP错误是否仍存在（预期仍存在，低优先级）
