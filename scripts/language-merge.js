const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

function normalize(title) {
  if (!title) return '';
  let t = title.replace(/[\s]*[:\-–—][\s]+.+$/, '');
  t = t.toLowerCase().trim().replace(/[''"""\[\](){}]/g, '').replace(/\s+/g, ' ');
  return t;
}

function normalizeAuthor(author) {
  if (!author) return '';
  return author.toLowerCase().trim().replace(/[.,]/g, '').replace(/\s+/g, ' ');
}

// Known Chinese → English title mappings for famous books
const KNOWN_TRANSLATIONS = {
  '聪明的投资者': 'the intelligent investor',
  '黑天鹅': 'the black swan',
  '说谎者的扑克牌': "liar's poker",
  '门口的野蛮人': 'barbarians at the gate',
  '投资最重要的事': 'the most important thing',
  '期权、期货及其他衍生产品': 'options, futures, and other derivatives',
  '波浪理论': 'elliott wave principle',
  '高频交易': 'high-frequency trading',
  '精通以太坊': 'mastering ethereum',
  '漫步华尔街': 'a random walk down wall street',
  '穷查理宝典': "poor charlie's almanack",
  '证券分析': 'security analysis',
  '金融炼金术': 'the alchemy of finance',
  '股票大作手回忆录': 'reminiscences of a stock operator',
  '非理性繁荣': 'irrational exuberance',
  '魔鬼经济学': 'freakonomics',
  '思考，快与慢': 'thinking, fast and slow',
  '国富论': 'the wealth of nations',
  '资本论': 'das kapital',
  '了不起的盖茨比': 'the great gatsby',
  '1984': '1984',
  '动物农场': 'animal farm',
  '百年孤独': 'one hundred years of solitude',
  '小王子': 'the little prince',
  '人性的弱点': 'how to win friends and influence people',
  '富爸爸穷爸爸': 'rich dad poor dad',
  '影响力': 'influence',
  '原则': 'principles',
  '从0到1': 'zero to one',
  '基业长青': 'built to last',
  '大空头': 'the big short',
  '数字黄金': 'digital gold',
  '区块链革命': 'blockchain revolution',
  '精通比特币': 'mastering bitcoin',
  '随机漫步的傻瓜': 'fooled by randomness',
  '反脆弱': 'antifragile',
  '债务危机': 'a template for understanding big debt crises',
  '巴比伦富翁': 'the richest man in babylon',
  '彼得·林奇的成功投资': 'one up on wall street',
  '战胜华尔街': 'beating the street',
  '共同基金常识': "the little book of common sense investing",
  '金融学': 'finance',
  '货币金融学': 'the economics of money banking and financial markets',
  '经济学原理': 'principles of economics',
  '就业、利息和货币通论': 'the general theory of employment interest and money',
  '日本蜡烛图技术': 'japanese candlestick charting techniques',
  '技术分析': 'technical analysis',
  '量化交易': 'quantitative trading',
  '对冲基金风云录': 'more money than god',
  '大而不倒': 'too big to fail',
  '金钱永不眠': 'money never sleeps',
  '伟大的博弈': 'the great game',
  '摩根财团': 'the house of morgan',
  '洛克菲勒': 'titan',
  '滚雪球': 'the snowball',
  '巴菲特致股东的信': 'the essays of warren buffett',
  '穷查理宝典': "poor charlie's almanack",
  '乌合之众': 'the crowd',
  '怪诞行为学': 'predictably irrational',
  '助推': 'nudge',
  '稀缺': 'scarcity',
  '错误的行为': 'misbehaving',
  '快思慢想': 'thinking fast and slow',
};

async function run() {
  const client = await pool.connect();
  
  try {
    const nonEn = await client.query(`
      SELECT id, title, title_en, title_zh, author, language, isbn, language_group_id
      FROM library_items WHERE category='book' AND language != 'en'
    `);
    console.log(`Non-EN books: ${nonEn.rows.length}`);

    const enBooks = await client.query(`
      SELECT id, title, title_en, title_zh, author, language, isbn, language_group_id
      FROM library_items WHERE category='book' AND language = 'en'
    `);
    console.log(`EN books: ${enBooks.rows.length}`);

    // Build indexes
    const byNormTitle = new Map();
    const byIsbn = new Map();
    const byAuthor = new Map();

    for (const b of enBooks.rows) {
      for (const t of [b.title, b.title_en]) {
        const nt = normalize(t);
        if (nt.length >= 3) {
          if (!byNormTitle.has(nt)) byNormTitle.set(nt, []);
          byNormTitle.get(nt).push(b);
        }
        // Also full lowercase
        if (t) {
          const full = t.toLowerCase().trim();
          if (full.length >= 3 && !byNormTitle.has(full)) {
            byNormTitle.set(full, [b]);
          } else if (full.length >= 3) {
            byNormTitle.get(full).push(b);
          }
        }
      }
      if (b.isbn) {
        const isbn = b.isbn.replace(/[-\s]/g, '');
        if (!byIsbn.has(isbn)) byIsbn.set(isbn, []);
        byIsbn.get(isbn).push(b);
      }
      const na = normalizeAuthor(b.author);
      if (na.length >= 3) {
        if (!byAuthor.has(na)) byAuthor.set(na, []);
        byAuthor.get(na).push(b);
      }
    }

    let updates = [];
    let reasons = { title: 0, known_translation: 0, isbn: 0, author_single: 0, author_title: 0 };

    for (const book of nonEn.rows) {
      // Skip if already in multi-member group
      let match = null;
      let reason = '';

      // 1. title_en / title match
      for (const t of [book.title_en, book.title]) {
        if (!match && t) {
          const nt = normalize(t);
          if (nt.length >= 3 && byNormTitle.has(nt)) {
            match = byNormTitle.get(nt)[0]; reason = 'title';
          }
        }
      }

      // 2. Known translation mapping
      if (!match) {
        const zh = book.title_zh || book.title;
        // Try exact and also without punctuation
        const cleanZh = zh.replace(/[，。：；！？、·\s]/g, '');
        for (const [zhKey, enVal] of Object.entries(KNOWN_TRANSLATIONS)) {
          const cleanKey = zhKey.replace(/[，。：；！？、·\s]/g, '');
          if (cleanZh === cleanKey || zh === zhKey) {
            // Find EN book with this title
            const nt = normalize(enVal);
            if (byNormTitle.has(nt)) {
              match = byNormTitle.get(nt)[0]; reason = 'known_translation';
            } else {
              // Try full title
              const full = enVal.toLowerCase().trim();
              if (byNormTitle.has(full)) {
                match = byNormTitle.get(full)[0]; reason = 'known_translation';
              }
            }
            break;
          }
        }
      }

      // 3. ISBN
      if (!match && book.isbn) {
        const isbn = book.isbn.replace(/[-\s]/g, '');
        if (byIsbn.has(isbn)) {
          match = byIsbn.get(isbn)[0]; reason = 'isbn';
        }
      }

      // 4. Author with single EN book
      if (!match && book.author) {
        const na = normalizeAuthor(book.author);
        if (na.length >= 3 && byAuthor.has(na)) {
          const candidates = byAuthor.get(na);
          if (candidates.length === 1) {
            match = candidates[0]; reason = 'author_single';
          } else if (candidates.length <= 10) {
            // Try word overlap between title_en/title and candidate titles
            const bookWords = normalize(book.title_en || book.title).split(' ').filter(w => w.length > 3);
            let bestMatch = null, bestScore = 0;
            for (const c of candidates) {
              const ct = (c.title + ' ' + (c.title_en || '')).toLowerCase();
              const score = bookWords.filter(w => ct.includes(w)).length;
              if (score > bestScore && score >= 2) {
                bestMatch = c; bestScore = score;
              }
            }
            if (bestMatch) {
              match = bestMatch; reason = 'author_title';
            }
          }
        }
      }

      if (match && book.language_group_id !== match.language_group_id) {
        updates.push({ 
          nonEnId: book.id, enGroupId: match.language_group_id,
          nonEnTitle: book.title, enTitle: match.title, reason
        });
        reasons[reason]++;
      }
    }

    console.log(`\nMatches: ${updates.length}`);
    console.log('By reason:', reasons);
    console.log('\nAll matches:');
    updates.forEach(u => {
      console.log(`  [${u.reason}] "${u.nonEnTitle}" → "${u.enTitle}"`);
    });

    // Apply
    if (updates.length > 0) {
      console.log(`\nApplying ${updates.length} merges...`);
      for (const u of updates) {
        await client.query(
          'UPDATE library_items SET language_group_id = $1 WHERE id = $2',
          [u.enGroupId, u.nonEnId]
        );
      }
      console.log('Done!');
    }

    // Stats
    const stats = await client.query(`
      SELECT count(*) as groups FROM (
        SELECT language_group_id FROM library_items 
        WHERE category='book' GROUP BY language_group_id HAVING count(*) > 1
      ) t
    `);
    const itemsInGroups = await client.query(`
      SELECT count(*) FROM library_items a WHERE category='book' 
      AND EXISTS (SELECT 1 FROM library_items b WHERE b.language_group_id = a.language_group_id AND b.id != a.id)
    `);
    console.log(`\nFinal: ${stats.rows[0].groups} groups, ${itemsInGroups.rows[0].count} items in multi-member groups`);

  } finally {
    client.release();
    pool.end();
  }
}

run().catch(e => { console.error(e); pool.end(); });
