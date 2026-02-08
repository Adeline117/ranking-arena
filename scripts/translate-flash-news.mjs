const SUPABASE_URL = "https://iknktzifjdyujdccyhsv.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const translations = {
  "6ef25e3a-0a06-48a6-8108-2442d45ce0cb": "比特币多头发现触底信号，长期空头宣告胜利",
  "4192105a-e8b7-402c-9654-8c95fa5951fb": "耶稣基督2026年现身赔率翻倍，回报率超比特币",
  "22e0c85d-4b5b-408e-bfe8-be401a607890": "Block考虑裁员最多10%：彭博社",
  "2638c849-f46b-4bfe-a93c-1425f7c030c6": "比特币熊市尚未结束？交易员预测BTC真正底部在5万美元",
  "0ee1d6eb-39ba-44ef-b4c1-b143de682489": "今日加密市场要闻一览",
  "0b3bf69b-7937-4c10-95bf-a7f8a5d41beb": "Jack Dorsey旗下Block或裁员10%进行业务重组",
  "cd1527d1-8f0a-487c-bd66-fb0542bb8309": "ARK连续抛售Coinbase股票，再卖出2200万美元并增持Bullish",
  "ae3ef417-dbad-485a-85b0-a656a0000ade": "Arthur Hayes将比特币暴跌归因于ETF做市商对冲",
  "e0c23fde-9455-4878-a628-91a236d1264d": "门罗币XMR尝试一个月来首次反弹，但死亡交叉风险逼近",
  "8b091308-fa60-480e-8247-a871c4af215b": "HBAR价格有望反弹30%——图表信号解读",
  "3066961c-5f7c-4f42-9a5e-206baaa3557b": "比特币挖矿难度创2021年中国禁令以来最大跌幅",
  "1728be5b-37c2-4d90-951c-8d85743d0f68": "加密钓鱼攻击损失激增200%，攻击者转向高价值钱包",
  "6d9d9697-6f80-440e-a16a-43ee2c2df18e": "市场暴跌之际，Google'加密货币'搜索量接近年度低点",
  "d903ae6b-d63a-420d-9818-eebce1ca4e51": "Consensus香港2026前瞻：加密政策最新动态",
  "10d9e35e-f670-41a8-bb1b-f362992b4f04": "日本高市早苗赢得历史性胜选，市场与加密圈关注政策改革",
  "e6ed92cb-e31c-4291-8755-1c0cd7195577": "Kyle Samani离开Multicoin后公开抨击Hyperliquid",
};

async function main() {
  for (const [id, title_zh] of Object.entries(translations)) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/flash_news?id=eq.${id}`, {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ title_zh }),
    });
    console.log(`${res.status} ${title_zh}`);
  }
  console.log("Done!");
}

main();
