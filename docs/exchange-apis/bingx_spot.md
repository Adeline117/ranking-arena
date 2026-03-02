# BingX Spot API

**Status**: 🔍 Auto-discovered  
**Priority**: P0  
**Data Gap**: 78.9%  
**Last Updated**: 2026-03-02

---

## 🔍 Auto-Discovery Results

Found 5 potential API endpoints.


### API 1: GET https://api-base.bingx.com/api/v1/home-profile/config/base

**Request Headers**:
```json
{
  "platformid": "30",
  "appid": "30004",
  "sec-ch-ua-platform": "\"Mac OS X\"",
  "mainappid": "10009",
  "lang": "en",
  "appsiteid": "0",
  "timestamp": "1772467658362",
  "timezone": "-8",
  "sec-ch-ua": "\" Not;A Brand\";v=\"99\", \"Google Chrome\";v=\"145\", \"Chromium\";v=\"145\"",
  "sec-ch-ua-mobile": "?0",
  "accept": "application/json, text/plain, */*",
  "device_id": "bf61d8a8b6cc4f9c88b64d661e11bd9c",
  "channel": "official",
  "reg_channel": "official",
  "sign": "FC3B8CBEEE7B485162CA8EEE184173F2EFFE54AD464FC604FCD822A44359AE10",
  "antideviceid": "",
  "accept-language": "en-US,en;q=0.9",
  "referer": "https://bingx.com/",
  "app_version": "4.79.110",
  "device_brand": "Mac OSX_Chrome_145.0.0.0",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "traceid": "0b591c35564644aea8af8650ee810c9d"
}
```




**Response** (200):
```json
{
  "code": 0,
  "timestamp": 1772467659516,
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
        "businessHosts": "{\"hosts\":[{\"host\":\"https://bingx.com\",\"priority\":6},{\"host\":\"https://api-app.we-api.com\",\"priority\":5},{\"host\":\"https://api-app.qq-os.com\",\"priority\":4},{\"host\":\"https://api-app.luck-in.com\",\"priority\":3}],\"probeUri\":\"/health\"}",
        "cswapWsBusinessHosts": "{\"hosts\":[{\"host\":\"wss://ws-cswap.we-api.com\",\"priority\":5},{\"host\":\"wss://ws-cswap.qq-os.com\",\"priority\":4},{\"host\":\"wss://ws-cswap.acc-de.com\",\"priority\":3},{\"host\":\"wss://ws-cswap.tra-eo.com\",\"priority\":2}],\"probeUri\":\"/health\"}",
        "probeInitInterval": "5",
        "cedefiWsBusinessHosts": "{\"hosts\":[{\"host\":\"wss://prod-cedefi-push-ws.we-api.com\",\"priority\":5},{\"host\":\"wss://prod-cedefi-push-ws.qq-os.com\",\"priority\":4},{\"host\":\"wss://prod-cedefi-push-ws.acc-de.com\",

... (truncated)
```


---

### API 2: GET https://api-app.qq-os.com/api/v1/home-profile/platform/config?platformId=30

**Request Headers**:
```json
{
  "platformid": "30",
  "appid": "30004",
  "sec-ch-ua-platform": "\"Mac OS X\"",
  "mainappid": "10009",
  "lang": "en",
  "appsiteid": "0",
  "timestamp": "1772467658207",
  "timezone": "-8",
  "sec-ch-ua": "\" Not;A Brand\";v=\"99\", \"Google Chrome\";v=\"145\", \"Chromium\";v=\"145\"",
  "visitorid": "-1",
  "sec-ch-ua-mobile": "?0",
  "accept": "application/json, text/plain, */*",
  "device_id": "bf61d8a8b6cc4f9c88b64d661e11bd9c",
  "channel": "official",
  "reg_channel": "official",
  "sign": "2C044BAB25844AD26164655DD9B17C6AA1FBC61C868C9D2CF720D1D1B1DF8DE0",
  "antideviceid": "",
  "accept-language": "en-US,en;q=0.9",
  "referer": "https://bingx.com/",
  "app_version": "4.79.110",
  "device_brand": "Mac OSX_Chrome_145.0.0.0",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "traceid": "81615f4378a44f458772e92c0b1df6fe"
}
```




**Response** (200):
```json
{
  "code": 0,
  "timestamp": 1772467658965,
  "data": {
    "configs": {
      "shareConfig": {
        "UpdatePolicy": "0",
        "currentActivity": "test"
      },
      "tradequick": {
        "UpdatePolicy": "0",
        "enable": "0",
        "positionDetailUrl": "https://h5.bingx.com/module/positiondetail.html",
        "downloadurl": "",
        "positionUrl": "https://h5.bingx.com/module/position.html",
        "url": "https://h5.bingx.com/module/trade.html"
      },
      "common": {
        "speedyKlineConfig": "{\"dbSwitchOn\":0,\"memorySwitchOn\":0,\"scrollSwitchOn\":1,\"depthSwitchOn\":1,\"memoryKlineTypes\":[\"0\",\"1\",\"2\"],\"speedyKlineList\":[\"1_1_BTC_USDT\",\"15_1_BTC_USDT\",\"120_1_BTC_USDT\"],\"perPageSize\":400,\"perGroupPageSize\":1000,\"scrollPreLoadPageSize\":350,\"scrollPreLoadPageScale\":0.5}",
        "UpdatePolicy": "0",
        "weaknetCheckInfo": "{\"switchOn\":1,\"apiWeight\":500,\"hostWeight\":800,\"detectWeight\":800,\"weightBaseLine\":8,\"checkHost\":\"www.google.com\",\"recentApiTimes\":5,\"switchOn_iOS\":1,\"recentApiTimes_iOS\":5,\"apiWeight_iOS\":800,\"hostWeight_iOS\":800,\"weightBaseLine_iOS\":12,\"maxCostDuration\":15000,\"isPerformanceFPSSwitchOn\":1,\"kycUploadV2Switch\":1,\"geeV4Protocol\":\"https\"}",
        "swapOrderGuideConfig": "{\"switchOn\":0,\"maxRegisteTime\":0,\"countDownTime\":0,\"stopLossRate\":\"-0.2\",\"stopProfitRate\":\"0.2\",\"firstTaskMoney\":\"10\",\"dialogBgColor\":\"V4ColorBg2\",\"adr_dialogBgColor\":\"bg_2_F4F5F6\",\"guideImgUrl\":\"https://static-app.bb-os.com/education/spot/img/swap_guide_dialog_top_bg.png\"}",
        "trLanguagePluginDisable": "0",
        "historyContractMaxDay": "31",
        "fullScreenUrl": "referral-program/hc,referral-program/mi,referral-program/fp",
        "emailDomains": "gmail.com,hotmail.com,outlook.com,yahoo.com,icloud.com",
        "assetDetailMaxDay": "90",
        "zendeskNewVersion": "1"
      },
      "host": {
        "contractTradeInfoUrl": "https://bingx

... (truncated)
```


---

### API 3: GET https://api-app.qq-os.com/api/v1/home-profile/user/config

**Request Headers**:
```json
{
  "platformid": "30",
  "appid": "30004",
  "sec-ch-ua-platform": "\"Mac OS X\"",
  "mainappid": "10009",
  "lang": "en",
  "appsiteid": "0",
  "timestamp": "1772467658208",
  "timezone": "-8",
  "sec-ch-ua": "\" Not;A Brand\";v=\"99\", \"Google Chrome\";v=\"145\", \"Chromium\";v=\"145\"",
  "visitorid": "-1",
  "sec-ch-ua-mobile": "?0",
  "accept": "application/json, text/plain, */*",
  "device_id": "bf61d8a8b6cc4f9c88b64d661e11bd9c",
  "channel": "official",
  "reg_channel": "official",
  "sign": "6FB261B646D4E9169952803256EB63B0BC870073C1F262D4E37346162698FA80",
  "antideviceid": "",
  "accept-language": "en-US,en;q=0.9",
  "referer": "https://bingx.com/",
  "app_version": "4.79.110",
  "device_brand": "Mac OSX_Chrome_145.0.0.0",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "traceid": "983341342a514035bb40e6051891c406"
}
```




**Response** (200):
```json
{
  "code": 0,
  "timestamp": 1772467658789,
  "data": {
    "availableVerifyChannels": [
      4,
      5
    ],
    "showBuy": 0,
    "defaultFiatCurrency": "USD",
    "defaultFiatSymbol": "$",
    "rate": 0.99992412,
    "noDisturbConfig": {
      "pushConfigs": [
        {
          "key": "2",
          "disable": false,
          "title": "Event Push",
          "content": "",
          "detail": ""
        },
        {
          "key": "4",
          "disable": false,
          "title": "Copy Trading",
          "content": "",
          "detail": ""
        },
        {
          "key": "16",
          "disable": false,
          "title": "Spot Listing",
          "content": "",
          "detail": ""
        },
        {
          "key": "17",
          "disable": false,
          "title": "Futures Listing",
          "content": "",
          "detail": ""
        },
        {
          "key": "market",
          "disable": false,
          "title": "Market Updates",
          "content": "",
          "detail": ""
        },
        {
          "key": "19",
          "disable": false,
          "title": "Market Swings",
          "content": "",
          "detail": ""
        },
        {
          "key": "20",
          "disable": false,
          "title": "Whale trades",
          "content": "",
          "detail": ""
        },
        {
          "key": "22",
          "disable": false,
          "title": "On-Chain Anomaly",
          "content": "",
          "detail": ""
        }
      ],
      "dialogConfigs": [
        {
          "key": "2",
          "disable": false,
          "title": "Event Popup",
          "content": "",
          "detail": ""
        }
      ],
      "notifyOrderDeal": true,
      "notifyOrderDealWithSound": true
    },
    "vipLevel": 0,
    "notShowLangList": [
      "ko-KR",
      "nl-NL"
    ],
    "userSavedPayPwd": false,
    "kycBlindBoxText": "500USDT",
    "googleAuthCode": false,
    "nickName": "",
    "contractAccou

```


---

### API 4: GET https://api-app.qq-os.com/api/v1/home-profile/platform/config?platformId=30

**Request Headers**:
```json
{
  "platformid": "30",
  "appid": "30004",
  "sec-ch-ua-platform": "\"Mac OS X\"",
  "mainappid": "10009",
  "lang": "en",
  "appsiteid": "0",
  "timestamp": "1772467658213",
  "timezone": "-8",
  "sec-ch-ua": "\" Not;A Brand\";v=\"99\", \"Google Chrome\";v=\"145\", \"Chromium\";v=\"145\"",
  "visitorid": "-1",
  "sec-ch-ua-mobile": "?0",
  "accept": "application/json, text/plain, */*",
  "device_id": "bf61d8a8b6cc4f9c88b64d661e11bd9c",
  "channel": "official",
  "reg_channel": "official",
  "sign": "1474D751695F0E6DAE5BF6D2486ADBAC89BBB3B842771A9362C51D1A56449B85",
  "antideviceid": "",
  "accept-language": "en-US,en;q=0.9",
  "referer": "https://bingx.com/",
  "app_version": "4.79.110",
  "device_brand": "Mac OSX_Chrome_145.0.0.0",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "traceid": "846d5448c0974c67ae70e37c7a4b8a00"
}
```




**Response** (200):
```json
{
  "code": 0,
  "timestamp": 1772467658965,
  "data": {
    "configs": {
      "shareConfig": {
        "UpdatePolicy": "0",
        "currentActivity": "test"
      },
      "tradequick": {
        "UpdatePolicy": "0",
        "enable": "0",
        "positionDetailUrl": "https://h5.bingx.com/module/positiondetail.html",
        "downloadurl": "",
        "positionUrl": "https://h5.bingx.com/module/position.html",
        "url": "https://h5.bingx.com/module/trade.html"
      },
      "common": {
        "speedyKlineConfig": "{\"dbSwitchOn\":0,\"memorySwitchOn\":0,\"scrollSwitchOn\":1,\"depthSwitchOn\":1,\"memoryKlineTypes\":[\"0\",\"1\",\"2\"],\"speedyKlineList\":[\"1_1_BTC_USDT\",\"15_1_BTC_USDT\",\"120_1_BTC_USDT\"],\"perPageSize\":400,\"perGroupPageSize\":1000,\"scrollPreLoadPageSize\":350,\"scrollPreLoadPageScale\":0.5}",
        "UpdatePolicy": "0",
        "weaknetCheckInfo": "{\"switchOn\":1,\"apiWeight\":500,\"hostWeight\":800,\"detectWeight\":800,\"weightBaseLine\":8,\"checkHost\":\"www.google.com\",\"recentApiTimes\":5,\"switchOn_iOS\":1,\"recentApiTimes_iOS\":5,\"apiWeight_iOS\":800,\"hostWeight_iOS\":800,\"weightBaseLine_iOS\":12,\"maxCostDuration\":15000,\"isPerformanceFPSSwitchOn\":1,\"kycUploadV2Switch\":1,\"geeV4Protocol\":\"https\"}",
        "swapOrderGuideConfig": "{\"switchOn\":0,\"maxRegisteTime\":0,\"countDownTime\":0,\"stopLossRate\":\"-0.2\",\"stopProfitRate\":\"0.2\",\"firstTaskMoney\":\"10\",\"dialogBgColor\":\"V4ColorBg2\",\"adr_dialogBgColor\":\"bg_2_F4F5F6\",\"guideImgUrl\":\"https://static-app.bb-os.com/education/spot/img/swap_guide_dialog_top_bg.png\"}",
        "trLanguagePluginDisable": "0",
        "historyContractMaxDay": "31",
        "fullScreenUrl": "referral-program/hc,referral-program/mi,referral-program/fp",
        "emailDomains": "gmail.com,hotmail.com,outlook.com,yahoo.com,icloud.com",
        "assetDetailMaxDay": "90",
        "zendeskNewVersion": "1"
      },
      "host": {
        "contractTradeInfoUrl": "https://bingx

... (truncated)
```


---

### API 5: GET https://api-app.qq-os.com/api/v1/home-profile/config/base

**Request Headers**:
```json
{
  "platformid": "30",
  "appid": "30004",
  "sec-ch-ua-platform": "\"Mac OS X\"",
  "mainappid": "10009",
  "lang": "en",
  "appsiteid": "0",
  "timestamp": "1772467658522",
  "timezone": "-8",
  "sec-ch-ua": "\" Not;A Brand\";v=\"99\", \"Google Chrome\";v=\"145\", \"Chromium\";v=\"145\"",
  "visitorid": "-1",
  "sec-ch-ua-mobile": "?0",
  "accept": "application/json, text/plain, */*",
  "device_id": "bf61d8a8b6cc4f9c88b64d661e11bd9c",
  "channel": "official",
  "reg_channel": "official",
  "sign": "EC6C3D9147FC09078A74333B6A0342804AEBD4BCA489569F8391640DFD50D2A4",
  "antideviceid": "",
  "accept-language": "en-US,en;q=0.9",
  "referer": "https://bingx.com/",
  "app_version": "4.79.110",
  "device_brand": "Mac OSX_Chrome_145.0.0.0",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "traceid": "bad1f054ae7b41be863bb0981ccb7f02"
}
```




**Response** (200):
```json
{
  "code": 0,
  "timestamp": 1772467658864,
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
        "businessHosts": "{\"hosts\":[{\"host\":\"https://bingx.com\",\"priority\":6},{\"host\":\"https://api-app.we-api.com\",\"priority\":5},{\"host\":\"https://api-app.qq-os.com\",\"priority\":4},{\"host\":\"https://api-app.luck-in.com\",\"priority\":3}],\"probeUri\":\"/health\"}",
        "cswapWsBusinessHosts": "{\"hosts\":[{\"host\":\"wss://ws-cswap.we-api.com\",\"priority\":5},{\"host\":\"wss://ws-cswap.qq-os.com\",\"priority\":4},{\"host\":\"wss://ws-cswap.acc-de.com\",\"priority\":3},{\"host\":\"wss://ws-cswap.tra-eo.com\",\"priority\":2}],\"probeUri\":\"/health\"}",
        "probeInitInterval": "5",
        "cedefiWsBusinessHosts": "{\"hosts\":[{\"host\":\"wss://prod-cedefi-push-ws.we-api.com\",\"priority\":5},{\"host\":\"wss://prod-cedefi-push-ws.qq-os.com\",\"priority\":4},{\"host\":\"wss://prod-cedefi-push-ws.acc-de.com\",

... (truncated)
```


---

## 📝 Next Steps

1. Review the APIs above
2. Identify which one contains trader detail data (roi, pnl, win_rate, max_drawdown)
3. Map fields to our DB schema
4. Implement connector in `lib/exchanges/bingx_spot.ts`
5. Test with real trader IDs

## 🔗 Related Files

- Import script: `scripts/import/import_bingx_spot.mjs`
- Enrich script: `scripts/enrich-bingx-spot-detail.mjs`
