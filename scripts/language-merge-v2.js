const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://postgres.iknktzifjdyujdccyhsv:j0qvCCZDzOHDfBka@aws-0-us-west-2.pooler.supabase.com:6543/postgres'
});

function normalize(title) {
  if (!title) return '';
  let t = title.replace(/[\s]*[:\-–—][\s]+.+$/, '');
  return t.toLowerCase().trim().replace(/[''"""\[\](){}]/g, '').replace(/\s+/g, ' ');
}

function normalizeAuthor(a) {
  return a ? a.toLowerCase().trim().replace(/[.,]/g, '').replace(/\s+/g, ' ') : '';
}

// Map: non-EN title → EN normalized title for lookup
const KNOWN = {
  // Already matched in v1, keeping for reference
  '聪明的投资者': 'the intelligent investor',
  '黑天鹅': 'the black swan',
  '说谎者的扑克牌': "liar's poker",
  '门口的野蛮人': 'barbarians at the gate',
  '投资最重要的事': 'the most important thing',
  '期权、期货及其他衍生产品': 'options, futures, and other derivatives',
  '波浪理论': 'elliott wave principle',
  '精通以太坊': 'mastering ethereum',
  '精通比特币': 'mastering bitcoin',
  '大空头': 'the big short',
  '对冲基金风云录': 'more money than god',
  '反脆弱': 'antifragile',
  '随机漫步的傻瓜': 'fooled by randomness',
  '穷查理宝典': "poor charlie's almanack",
  '日本蜡烛图技术': 'japanese candlestick charting techniques',
  '思考，快与慢': 'thinking, fast and slow',
  // New translations  
  '打开量化投资的黑箱': 'inside the black box',
  '以交易为生': 'trading for a living',
  '交易心理分析': 'trading in the zone',
  '短线交易秘诀': 'secrets of commodity trading',
  '加密资产：数字资产创新投资指南': 'cryptoassets',
  '期货市场技术分析': 'technical analysis of the financial markets',
  '投资中最简单的事': 'the most important thing', // same concept
  '股票大作手回忆录': 'reminiscences of a stock operator',
  '非理性繁荣': 'irrational exuberance',
  '漫步华尔街': 'a random walk down wall street',
  '金融炼金术': 'the alchemy of finance',
  '巴菲特致股东的信': 'the essays of warren buffett',
  '乌合之众': 'the crowd',
  '怪诞行为学': 'predictably irrational',
  '货币金融学': 'the economics of money banking and financial markets',
  '区块链革命': 'blockchain revolution',
  '数字黄金': 'digital gold',
  '从0到1': 'zero to one',
  '富爸爸穷爸爸': 'rich dad poor dad',
  '影响力': 'influence',
  '原则': 'principles',
  '魔鬼经济学': 'freakonomics',
  '国富论': 'the wealth of nations',
  '了不起的盖茨比': 'the great gatsby',
  '动物农场': 'animal farm',
  '百年孤独': 'one hundred years of solitude',
  '小王子': 'the little prince',
  '人性的弱点': 'how to win friends and influence people',
  '基业长青': 'built to last',
  '巴比伦富翁': 'the richest man in babylon',
  '彼得·林奇的成功投资': 'one up on wall street',
  '战胜华尔街': 'beating the street',
  '量化交易：如何建立自己的算法交易事业': 'quantitative trading',
  '量化交易': 'quantitative trading',
  'La sombra del viento': 'the shadow of the wind',
};

async function run() {
  const client = await pool.connect();
  
  try {
    const nonEn = await client.query(`
      SELECT id, title, title_en, title_zh, author, language, isbn, language_group_id
      FROM library_items WHERE category='book' AND language != 'en'
      AND NOT EXISTS (SELECT 1 FROM library_items b WHERE b.language_group_id = library_items.language_group_id AND b.id != library_items.id)
    `);
    console.log(`Unmatched non-EN books: ${nonEn.rows.length}`);

    const enBooks = await client.query(`
      SELECT id, title, title_en, author, language_group_id
      FROM library_items WHERE category='book' AND language = 'en'
    `);

    // Build indexes
    const byNormTitle = new Map();
    const byAuthor = new Map();

    for (const b of enBooks.rows) {
      for (const t of [b.title, b.title_en]) {
        if (!t) continue;
        // Index both normalized (no subtitle) and full lowercase
        for (const nt of [normalize(t), t.toLowerCase().trim()]) {
          if (nt.length >= 3) {
            if (!byNormTitle.has(nt)) byNormTitle.set(nt, []);
            byNormTitle.get(nt).push(b);
          }
        }
      }
      const na = normalizeAuthor(b.author);
      if (na.length >= 3) {
        if (!byAuthor.has(na)) byAuthor.set(na, []);
        byAuthor.get(na).push(b);
      }
    }

    function findByTitle(title) {
      if (!title) return null;
      const nt = normalize(title);
      if (nt.length >= 3 && byNormTitle.has(nt)) return byNormTitle.get(nt)[0];
      const full = title.toLowerCase().trim();
      if (full.length >= 3 && byNormTitle.has(full)) return byNormTitle.get(full)[0];
      return null;
    }

    let updates = [];
    let reasons = {};

    for (const book of nonEn.rows) {
      let match = null, reason = '';

      // 1. Direct title match (title_en or title)
      match = findByTitle(book.title_en) || findByTitle(book.title);
      if (match) reason = 'title';

      // 2. Known translations
      if (!match) {
        const t = book.title_zh || book.title;
        for (const [k, v] of Object.entries(KNOWN)) {
          if (t === k || t.startsWith(k)) {
            match = findByTitle(v);
            if (match) { reason = 'known'; break; }
          }
        }
      }

      // 3. Author + same-title match (EN title in non-EN record)
      if (!match && book.author) {
        const na = normalizeAuthor(book.author);
        const candidates = byAuthor.get(na) || [];
        if (candidates.length > 0) {
          // Check if the non-EN book title happens to be in English
          const bt = normalize(book.title);
          for (const c of candidates) {
            const ct = normalize(c.title);
            if (bt === ct || (bt.length >= 5 && ct.includes(bt)) || (ct.length >= 5 && bt.includes(ct))) {
              match = c; reason = 'author_exact'; break;
            }
          }
        }
      }

      if (match && book.language_group_id !== match.language_group_id) {
        updates.push({ id: book.id, gid: match.language_group_id, t: book.title, et: match.title, reason });
        reasons[reason] = (reasons[reason] || 0) + 1;
      }
    }

    console.log(`\nNew matches: ${updates.length}`);
    console.log('By reason:', reasons);
    updates.forEach(u => console.log(`  [${u.reason}] "${u.t}" → "${u.et}"`));

    if (updates.length > 0) {
      console.log(`\nApplying...`);
      for (const u of updates) {
        await client.query('UPDATE library_items SET language_group_id = $1 WHERE id = $2', [u.gid, u.id]);
      }
    }

    // Final stats
    const stats = await client.query(`SELECT count(*) as groups FROM (SELECT language_group_id FROM library_items WHERE category='book' GROUP BY language_group_id HAVING count(*) > 1) t`);
    const items = await client.query(`SELECT count(*) FROM library_items a WHERE category='book' AND EXISTS (SELECT 1 FROM library_items b WHERE b.language_group_id = a.language_group_id AND b.id != a.id)`);
    console.log(`\nFinal: ${stats.rows[0].groups} groups, ${items.rows[0].count} items in multi-member groups`);

  } finally {
    client.release();
    pool.end();
  }
}

run().catch(e => { console.error(e); pool.end(); });
