# Binance Web3 API

**Status**: 🔍 Auto-discovered  
**Priority**: P0  
**Data Gap**: 54.4%  
**Last Updated**: 2026-03-02

---

## 🔍 Auto-Discovery Results

Found 4 potential API endpoints.


### API 1: GET https://www.binance.com/bapi/apex/v1/friendly/apex/marketing/complianceActionCheck?requestLink=www.binance.com%2Fen%2Fcopy-trading%2Flead-details

**Request Headers**:
```json
{
  "sec-ch-ua-platform": "\"Mac OS X\"",
  "csrftoken": "d41d8cd98f00b204e9800998ecf8427e",
  "lang": "en",
  "sec-ch-ua": "\" Not;A Brand\";v=\"99\", \"Google Chrome\";v=\"145\", \"Chromium\";v=\"145\"",
  "sec-ch-ua-mobile": "?0",
  "fvideo-id": "",
  "bnc-uuid": "eaaf3544-2573-49be-a1ab-82cd357b0a6b",
  "x-passthrough-token": "",
  "content-type": "application/json",
  "fvideo-token": "",
  "referer": "https://www.binance.com/en/copy-trading/lead-details",
  "accept-language": "en-US,en;q=0.9",
  "x-trace-id": "449f1686-a496-4c0a-bfc9-2c91e797d08b",
  "x-ui-request-trace": "449f1686-a496-4c0a-bfc9-2c91e797d08b",
  "bnc-time-zone": "America/Los_Angeles",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "clienttype": "web",
  "device-info": "eyJzY3JlZW5fcmVzb2x1dGlvbiI6IjE5MjAsMTA4MCIsImF2YWlsYWJsZV9zY3JlZW5fcmVzb2x1dGlvbiI6IjE5MjAsMTA4MCIsInN5c3RlbV92ZXJzaW9uIjoiTWFjIE9TIDEwLjE1LjciLCJicmFuZF9tb2RlbCI6InVua25vd24iLCJzeXN0ZW1fbGFuZyI6ImVuLVVTIiwidGltZXpvbmUiOiJHTVQtMDg6MDAiLCJ0aW1lem9uZU9mZnNldCI6NDgwLCJ1c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKE1hY2ludG9zaDsgSW50ZWwgTWFjIE9TIFggMTBfMTVfNykgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzE0NS4wLjAuMCBTYWZhcmkvNTM3LjM2IiwibGlzdF9wbHVnaW4iOiJQREYgVmlld2VyLENocm9tZSBQREYgVmlld2VyLENocm9taXVtIFBERiBWaWV3ZXIsTWljcm9zb2Z0IEVkZ2UgUERGIFZpZXdlcixXZWJLaXQgYnVpbHQtaW4gUERGIiwiY2FudmFzX2NvZGUiOiI1NWQ1MTA4YyIsIndlYmdsX3ZlbmRvciI6IkludGVsIEluYy4iLCJ3ZWJnbF9yZW5kZXJlciI6IkludGVsIElyaXMgT3BlbkdMIEVuZ2luZSIsImF1ZGlvIjoiMTI0LjA0MzQ3NzQ1NTEyNDk2IiwicGxhdGZvcm0iOiJNYWNJbnRlbCIsIndlYl90aW1lem9uZSI6IkFtZXJpY2EvTG9zX0FuZ2VsZXMiLCJkZXZpY2VfbmFtZSI6IkNocm9tZSBWMTQ1LjAuMC4wIChNYWMgT1MpIiwiZmluZ2VycHJpbnQiOiI2ZjVmOTI2YWIxMDc2NTZjNjU3NTM3NTg2NzI0MmQ0MSIsImRldmljZV9pZCI6IiIsInJlbGF0ZWRfZGV2aWNlX2lkcyI6IiJ9",
  "bnc-location": "",
  ":authority": "www.binance.com",
  ":method": "GET",
  ":path": "/bapi/apex/v1/friendly/apex/marketing/complianceActionCheck?requestLink=www.binance.com%2Fen%2Fcopy-trading%2Flead-details",
  ":scheme": "https",
  "accept": "*/*",
  "accept-encoding": "gzip, deflate, br, zstd",
  "cookie": "aws-waf-token=0dc0f488-b893-45c9-826b-3eb2ec80b1d1:FAoAp2VwVWQuAAAA:PGXImGVhEbaJYWz/xUIeG+wba4MBXmzMAjZUFs1B/DMtR9uz5CIAEvac24MMoOaZozGlnkH4eBFeEIXg+liPTJ+LQHKhw34126TDj+aWAj0zq1OwZEojohsqZdnIidEuS3hY5fVqv1qbqmLxDmm9Zz8Raw64SrZAPwWXBMl13jun3qiYfZ3Me0Csz4VUtUYkwUYyoTII3wWa+HTCu6og+0N923s=; theme=dark; bnc-uuid=eaaf3544-2573-49be-a1ab-82cd357b0a6b; OptanonConsent=isGpcEnabled=0&datestamp=Mon+Mar+02+2026+08%3A07%3A44+GMT-0800+(%E5%8C%97%E7%BE%8E%E5%A4%AA%E5%B9%B3%E6%B4%8B%E6%A0%87%E5%87%86%E6%97%B6%E9%97%B4)&version=202506.1.0&browserGpcFlag=0&isIABGlobal=false&hosts=&consentId=1bcf0410-cfe3-4cc1-a996-400e9b41ac8a&interactionCount=0&isAnonUser=1&landingPath=https%3A%2F%2Fwww.binance.com%2Fen%2Fcopy-trading%2Flead-details; sajssdk_2015_cross_new_user=1; sensorsdata2015jssdkcross=%7B%22distinct_id%22%3A%2219caf4e366ee30-0e3effca0f977e-1a525631-2073600-19caf4e366fefa%22%2C%22first_id%22%3A%22%22%2C%22props%22%3A%7B%22%24latest_traffic_source_type%22%3A%22%E7%9B%B4%E6%8E%A5%E6%B5%81%E9%87%8F%22%2C%22%24latest_search_keyword%22%3A%22%E6%9C%AA%E5%8F%96%E5%88%B0%E5%80%BC_%E7%9B%B4%E6%8E%A5%E6%89%93%E5%BC%80%22%2C%22%24latest_referrer%22%3A%22%22%7D%2C%22identities%22%3A%22eyIkaWRlbnRpdHlfY29va2llX2lkIjoiMTljYWY0ZTM2NmVlMzAtMGUzZWZmY2EwZjk3N2UtMWE1MjU2MzEtMjA3MzYwMC0xOWNhZjRlMzY2ZmVmYSJ9%22%2C%22history_login_id%22%3A%7B%22name%22%3A%22%22%2C%22value%22%3A%22%22%7D%7D",
  "priority": "u=1, i",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin"
}
```




**Response** (200):
```json
{
  "code": "000000",
  "message": null,
  "messageDetail": null,
  "data": {
    "pass": true,
    "actionType": null,
    "clientType": null,
    "actionInfo": null,
    "extInfo": null,
    "userCheckResult": null
  },
  "success": true
}

```


---

### API 2: POST https://www.google-analytics.com/g/collect?v=2&tid=G-3WP50LGEEC&gtm=45je62p1v889234695z8832196322za20gzb832196322zd832196322&_p=1772467662742&gcs=G100&gcd=13q3q3q3q5l1&npa=1&dma_cps=-&dma=0&cid=957607842.1772467665&ul=en-us&sr=1920x1080&uaa=x86&uab=64&uafvl=Chromium%3B145.0.7632.77%7CNot%253AA-Brand%3B99.0.0.0&uamb=0&uam=&uap=Mac%20OS%20X&uapv=10_15_7&uaw=0&are=1&frm=0&pscdl=denied&_eu=AAAAAGA&_s=1&tag_exp=103116026~103200004~104527907~104528501~104684208~104684211~115938466~115938469&sid=1772467664&sct=1&seg=0&dl=https%3A%2F%2Fwww.binance.com%2Fen%2Fcopy-trading%2Flead-details&dt=Copy%20Trading%20%7C%20Copy%20Expert%20Traders%20Effortlessly%20and%20Maximize%20Crypto%20Profits%20%7C%20Binance&_tu=CA&en=page_view&_fv=1&_nsi=1&_ss=1&ep.containerID=GTM-M86QHGF&tfd=2714

**Request Headers**:
```json
{
  "sec-ch-ua-platform": "\"Mac OS X\"",
  "referer": "https://www.binance.com/",
  "accept-language": "en-US,en;q=0.9",
  "sec-ch-ua": "\" Not;A Brand\";v=\"99\", \"Google Chrome\";v=\"145\", \"Chromium\";v=\"145\"",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "sec-ch-ua-mobile": "?0"
}
```





---

### API 3: GET https://bin.bnbstatic.com/api/i18n/-/web/cms/en/profile

**Request Headers**:
```json
{
  "sec-ch-ua-platform": "\"Mac OS X\"",
  "referer": "https://www.binance.com/",
  "accept-language": "en-US,en;q=0.9",
  "sec-ch-ua": "\" Not;A Brand\";v=\"99\", \"Google Chrome\";v=\"145\", \"Chromium\";v=\"145\"",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "sec-ch-ua-mobile": "?0"
}
```




**Response** (200):
```json
{
  "profile-title": "Edit Profile",
  "profile-form-cancel": "Cancel",
  "profile-form-apply": "Apply",
  "profile-avatar-save-warning": "Avatar or nickname can each be changed {{count}} time per {{day}} days. Please double check before you continue.",
  "profile-save-success": "Profile successfully updated!",
  "profile-form-back": "Back to Edit",
  "profile-form-continue": "Continue",
  "profile-avatar-warning-web": "Avatar can only be modified {{count}} time per {{day}} days.",
  "profile-nickname-warning": "Nickname can only be modified {{count}} time per {{day}} days.",
  "profile-avatar-warning": "Avatar or nickname can each be changed {{count}} time per {{day}} days.",
  "profile-nickname-title": "Nickname",
  "profile-avatar-desc-2": "*Nickname will be used across the Binance platform, including Binance Square and Binance Pay. Abusing it may lead to community penalties.",
  "profile-avatar-title": "Avatar",
  "profile-avatar-desc-1": "*Avatar will also be displayed on Binance Square.",
  "profile-form-save": "Save",
  "USER_PROFILE_ERROR_30002": "This nickname is already taken. Please input a new nickname and try again.",
  "USER_PROFILE_ERROR_30004": "Invalid user. Please try again later.",
  "USER_PROFILE_ERROR_30006": "This nickname has exceeded the maximum character limit. Please edit it and try again.",
  "USER_PROFILE_ERROR_30007": "Nicknames must only consist of letters, Arabic numerals, spaces, '-' and '_'.",
  "USER_PROFILE_ERROR_30008": "This action is not allowed because you have violated the guideline of the platform.",
  "USER_PROFILE_ERROR_30015": "This action is not allowed because your account has been deactivated.",
  "USER_PROFILE_ERROR_200022": "Invalid nickname. Please change and try again.",
  "USER_PROFILE_ERROR_30016": "This nickname is already used by another user. Please input a new nickname and try again.",
  "USER_PROFILE_ERROR_200021": "Invalid avatar. Please change and try again.",
  "USER_PROFILE_ERROR_300002": "Nickname can on

... (truncated)
```


---

### API 4: GET https://www.binance.com/bapi/apex/v1/friendly/apex/compliance/notification/display-detail?key=copyTrading&preCheck=true&currency=undefined

**Request Headers**:
```json
{
  "sec-ch-ua-platform": "\"Mac OS X\"",
  "csrftoken": "d41d8cd98f00b204e9800998ecf8427e",
  "lang": "en",
  "sec-ch-ua": "\" Not;A Brand\";v=\"99\", \"Google Chrome\";v=\"145\", \"Chromium\";v=\"145\"",
  "sec-ch-ua-mobile": "?0",
  "fvideo-id": "",
  "bnc-uuid": "eaaf3544-2573-49be-a1ab-82cd357b0a6b",
  "x-passthrough-token": "",
  "content-type": "application/json",
  "fvideo-token": "",
  "referer": "https://www.binance.com/en/copy-trading/lead-details",
  "accept-language": "en-US,en;q=0.9",
  "x-trace-id": "81f0d98c-eb96-4226-bdbb-fccb0ef162cb",
  "x-ui-request-trace": "81f0d98c-eb96-4226-bdbb-fccb0ef162cb",
  "bnc-time-zone": "America/Los_Angeles",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  "clienttype": "web",
  "device-info": "eyJzY3JlZW5fcmVzb2x1dGlvbiI6IjE5MjAsMTA4MCIsImF2YWlsYWJsZV9zY3JlZW5fcmVzb2x1dGlvbiI6IjE5MjAsMTA4MCIsInN5c3RlbV92ZXJzaW9uIjoiTWFjIE9TIDEwLjE1LjciLCJicmFuZF9tb2RlbCI6InVua25vd24iLCJzeXN0ZW1fbGFuZyI6ImVuLVVTIiwidGltZXpvbmUiOiJHTVQtMDg6MDAiLCJ0aW1lem9uZU9mZnNldCI6NDgwLCJ1c2VyX2FnZW50IjoiTW96aWxsYS81LjAgKE1hY2ludG9zaDsgSW50ZWwgTWFjIE9TIFggMTBfMTVfNykgQXBwbGVXZWJLaXQvNTM3LjM2IChLSFRNTCwgbGlrZSBHZWNrbykgQ2hyb21lLzE0NS4wLjAuMCBTYWZhcmkvNTM3LjM2IiwibGlzdF9wbHVnaW4iOiJQREYgVmlld2VyLENocm9tZSBQREYgVmlld2VyLENocm9taXVtIFBERiBWaWV3ZXIsTWljcm9zb2Z0IEVkZ2UgUERGIFZpZXdlcixXZWJLaXQgYnVpbHQtaW4gUERGIiwiY2FudmFzX2NvZGUiOiI1NWQ1MTA4YyIsIndlYmdsX3ZlbmRvciI6IkludGVsIEluYy4iLCJ3ZWJnbF9yZW5kZXJlciI6IkludGVsIElyaXMgT3BlbkdMIEVuZ2luZSIsImF1ZGlvIjoiMTI0LjA0MzQ3NzQ1NTEyNDk2IiwicGxhdGZvcm0iOiJNYWNJbnRlbCIsIndlYl90aW1lem9uZSI6IkFtZXJpY2EvTG9zX0FuZ2VsZXMiLCJkZXZpY2VfbmFtZSI6IkNocm9tZSBWMTQ1LjAuMC4wIChNYWMgT1MpIiwiZmluZ2VycHJpbnQiOiI2ZjVmOTI2YWIxMDc2NTZjNjU3NTM3NTg2NzI0MmQ0MSIsImRldmljZV9pZCI6IiIsInJlbGF0ZWRfZGV2aWNlX2lkcyI6IiJ9",
  "bnc-location": ""
}
```




**Response** (200):
```json
{
  "code": "000000",
  "message": null,
  "messageDetail": null,
  "data": [],
  "success": true
}

```


---

## 📝 Next Steps

1. Review the APIs above
2. Identify which one contains trader detail data (roi, pnl, win_rate, max_drawdown)
3. Map fields to our DB schema
4. Implement connector in `lib/exchanges/binance_web3.ts`
5. Test with real trader IDs

## 🔗 Related Files

- Import script: `scripts/import/import_binance_web3.mjs`
- Enrich script: `scripts/enrich-binance-web3-detail.mjs`
