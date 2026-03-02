# BingX Spot API

**Status**: 🔍 Discovering | ⚠️  Partial | ✅ Complete  
**Priority**: P0 | P1 | P2  
**Data Gap**: XX.X%  
**Last Updated**: 2026-03-02

---

## Trader Detail API

### Endpoint
```
GET https://api-base.bingx.com/api/v1/home-profile/config/base
```

### 请求示例 (cURL)
```bash
curl 'https://api-base.bingx.com/api/v1/home-profile/config/base' \
  -H 'platformid: 30' \
  -H 'appid: 30004' \
  -H 'sec-ch-ua-platform: "Mac OS X"' \
  -H 'mainappid: 10009' \
  -H 'lang: en' \
  -H 'appsiteid: 0' \
  -H 'timestamp: 1772428747470' \
  -H 'timezone: -8' \
  -H 'sec-ch-ua: " Not;A Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"' \
  -H 'sec-ch-ua-mobile: ?0' \
  -H 'accept: application/json, text/plain, */*' \
  -H 'device_id: a6c7637d1e304f8fa2cae2772854226f' \
  -H 'channel: official' \
  -H 'reg_channel: official' \
  -H 'sign: ED1B2E01C48B127221736396E618F0B17215F176395BE99C329078B2E00114F6' \
  -H 'antideviceid: ' \
  -H 'accept-language: en-US,en;q=0.9' \
  -H 'referer: https://bingx.com/' \
  -H 'app_version: 4.79.110' \
  -H 'device_brand: Mac OSX_Chrome_145.0.0.0' \
  -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36' \
  -H 'traceid: 909a362633f84e279923216b4ea16bff'```

### 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `traderId` | string | ✅ | 交易员ID |
| `timeWindow` | string | ❌ | 时间窗口: 7D/30D/ALL |

### 响应示例 (JSON)
```json
{
  "code": 0,
  "timestamp": 1772428747619,
  "data": {
    "configs": {
      "host": {
        "businessHosts": "https://api-app.luck-in.com"
      },
      "hostv2": {
        "probeMaxInterval": "30",
        "testBusinessHosts": "{\"hosts\":[{\"name\":\"灰度1\",\"header\":\"gray-develop\"},{\"name\":\"灰度2\",\"header\":\"gray-merge\"}]}",
        "wsPrivatePushHosts": "{\"hosts\":[{\"host\":\"wss://ws-private.we-api.com\",\"priority\":6},{\"host\":\"wss://ws-private.qq-os.com\",\"priority\":5},{\"host\":\"wss://ws-private.acc-de.com\",\"priority\":4},{\"host\":\"wss://ws-private.tra-eo.com\",\"priority\":3}],\"probeUri\":\"/health\"}",
        "slowTime": "5",
        "wsBusinessHosts": "{\"hosts\":[{\"host\":\"wss://ws-app.we-api.com\",\"priority\":6},{\"host\":\"wss://ws-app.qq-os.com\",\"priority\":5},{\"host\":\"wss://ws-app.acc-de.com\",\"priority\":4},{\"host\":\"wss://ws-app.tra-eo.com\",\"priority\":3}],\"probeUri\":\"/health\"}",
        "cswapBusinessHosts": "{\"hosts\":[{\"host\":\"https://api-cswap-app.qq-os.com\",\"priority\":5},{\"host\":\"https://api-cswap-app.we-api.com\",\"priority\":4}],\"probeUri\":\"/health\"}",
        "businessHosts": "{\"hosts\":[{\"host\":\"https://api-app.we-api.com\",\"priority\":5},{\"host\":\"https://api-app.qq-os.com\",\"priority\":4},{\"host\":\"https://api-app.acc-de.com\",\"priority\":2},{\"host\":\"https://api-app.tra-eo.com\",\"priority\":1}],\"probeUri\":\"/health\"}",
        "cswapWsBusinessHosts": "{\"hosts\":[{\"host\":\"wss://ws-cswap.we-api.com\",\"priority\":5},{\"host\":\"wss://ws-cswap.qq-os.com\",\"priority\":4},{\"host\":\"wss://ws-cswap.acc-de.com\",\"priority\":3},{\"host\":\"wss://ws-cswap.tra-eo.com\",\"priority\":2}],\"probeUri\":\"/health\"}",
        "probeInitInterval": "5",
        "cedefiWsBusinessHosts": "{\"hosts\":[{\"host\":\"wss://prod-cedefi-push-ws.we-api.com\",\"priority\":5},{\"host\":\"wss://prod-cedefi-push-ws.qq-os.com\",\"priority\":4},{\"host\":\"wss://prod-cedefi-push-ws.acc-de.com\",\"priority\":2},{\"host\":\"wss://prod-cedefi-push-ws.tra-eo.com\",\"priority\":1}],\"probeUri\":\"/health\"}",
        "uswapWsBusinessHostsVst": "{\"hosts\":[{\"host\":\"wss://ws-uswap-vst.we-api.com\",\"priority\":5},{\"host\":\"wss://ws-uswap-vst.qq-os.com\",\"priority\":4},{\"host\":\"wss://ws-uswap-vst.acc-de.com\",\"priority\":3},{\"host\":\"wss://ws-uswap-vst.tra-eo.com\",\"priority\":2}],\"probeUri\":\"/health\"}",
        "swapMarketBusinessHosts": "{\"hosts\":[{\"host\":\"https://api-swap.we-api.com\",\"priority\":5},{\"host\":\"https://api-swap.qq-os.com\",\"priority\":4},{\"host\":\"https://api-swap.acc-de.com\",\"priority\":2},{\"host\":\"https://api-swap.tra-eo.com\",\"priority\":1}],\"probeUri\":\"/health\"}",
        "swapBusinessHosts": "{\"hosts\":[{\"host\":\"https://api-swap.we-api.com\",\"priority\":5},{\"host\":\"https://api-swap.qq-os.com\",\"priority\":4},{\"host\":\"https://api-swap.acc-de.com\",\"priority\":2},{\"host\":\"https://api-swap.tra-eo.com\",\"priority\":1}],\"probeUri\":\"/health\"}",
        "spotWsBusinessHosts": "{\"hosts\":[{\"host\":\"wss://ws-spot.we-api.com\",\"priority\":7},{\"host\":\"wss://ws-spot.qq-os.com\",\"priority\":6},{\"host\":\"wss://ws-spot.acc-de.com\",\"priority\":5},{\"host\":\"wss://ws-spot.tra-eo.com\",\"priority\":4}],\"probeUri\":\"/health\"}",
        "swapWsBusinessHosts": "{\"hosts\":[{\"host\":\"wss://ws-market-swap.we-api.com\",\"priority\":5},{\"host\":\"wss://ws-market-swap.qq-os.com\",\"priority\":4},{\"host\":\"wss://ws-market-swap.acc-de.com\",\"priority\":3},{\"host\":\"wss://ws-market-swap.tra-eo.com\",\"priority\":2}],\"probeUri\":\"/health\"}",
        "uswapWsBusinessHosts": "{\"hosts\":[{\"host\":\"wss://ws-uswap.we-api.com\",\"priority\":5},{\"host\":\"wss://ws-uswap.qq-os.com\",\"priority\":4},{\"host\":\"wss://ws-uswap.acc-de.com\",\"priority\":3},{\"host\":\"wss://ws-uswap.tra-eo.com\",\"priority\":2}],\"probeUri\":\"/health\"}"
      }
    },
    "checkPropConfigVo": {
      "netSuccCode": [
        "302",
        "429",
        "200"
      ],
      "appErrCode": [
        "100003",
        "100005"
      ],
      "successRateTimeInterval": "120",
      "successRateThreshold": "80",
      "successRateMin": "10",
      "configInterval": "600000",
      "delayThreshold": "1000",
      "successRateRange": [
        "95",
        "90",
        "85"
      ]
    },
    "trackingConfig": {
      "appId": "10000005",
      "domain": "https://hs-prod-abtest-sdk.bingx.com"
    }
  }
}
```

### 字段映射

| API字段 | DB字段 | 数据类型 | 说明 |
|---------|--------|----------|------|
| `data.userId` | `source_trader_id` | string | 交易员ID |
| `data.nickname` | `handle` | string | 昵称 |
| `data.avatar` | `avatar_url` | string | 头像URL |
| `data.roi` | `roi` | number | 累计ROI% |
| `data.pnl` | `pnl` | number | 累计PnL USDT |
| `data.winRate` | `win_rate` | number | 胜率% (0-100) |
| `data.maxDrawdown` | `max_drawdown` | number | 最大回撤% (负数) |
| `data.tradesCount` | `trades_count` | number | 交易次数 |
| `data.statistics.7d.roi` | `roi_7d` | number | 7天ROI% |
| `data.statistics.30d.roi` | `roi_30d` | number | 30天ROI% |
| `data.statistics.90d.roi` | `roi_90d` | number | 90天ROI% |

---

## Trader List API (可选)

如果交易所也提供排行榜API，可以记录在这里。

### Endpoint
```
GET https://api.example.com/v1/leaderboard
```

### 请求示例
```bash
curl 'https://api.example.com/v1/leaderboard?limit=100&timeWindow=30D'
```

---

## 注意事项

### Rate Limiting
- 限制: XX requests/minute
- 策略: 使用delay，batch请求

### Authentication
- ❌ 不需要API key
- ✅ 需要API key: `X-API-KEY: ...`
- ⚠️  需要签名: 使用crypto.createHmac(...)

### Headers
必须的headers:
```
Content-Type: application/json
User-Agent: Mozilla/5.0...
Referer: https://www.example.com/
```

### 数据转换

**ROI**: 
- API返回: `125.5` (百分比)
- DB存储: `125.5` (保持不变)

**Win Rate**:
- API返回: `0.685` (小数) 或 `68.5` (百分比)
- DB存储: `68.5` (统一为百分比 0-100)

**Max Drawdown**:
- API返回: `-12.3` (负数) 或 `12.3` (正数)
- DB存储: `-12.3` (统一为负数)

---

## 实现状态

- [ ] API endpoint discovered
- [ ] cURL tested
- [ ] Response documented
- [ ] Field mapping defined
- [ ] Connector code written (`lib/exchanges/{exchange}.ts`)
- [ ] Import script created (`scripts/import/import_{exchange}.mjs`)
- [ ] Data validated in DB
- [ ] Added to cron schedule

---

## 相关文件

- Connector: `lib/exchanges/{exchange}.ts`
- Import script: `scripts/import/import_{exchange}.mjs`
- Enrich script: `scripts/enrich-{exchange}-detail.mjs`

---

## 发现日志

**2026-03-02**: 
- 发现detail API endpoint
- 测试返回数据结构
- 字段映射完成
