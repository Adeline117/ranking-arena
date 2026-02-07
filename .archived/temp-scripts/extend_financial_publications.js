#!/usr/bin/env node

const https = require('https');
const fs = require('fs');

// Supabase配置
const SUPABASE_URL = 'https://iknktzifjdyujdccyhsv.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlrbmt0emlmamR5dWpkY2N5aHN2Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NjU1MTU1MywiZXhwIjoyMDgyMTI3NTUzfQ.dBTyJ6tPY-eelVj4khLq31RuUg59Opcy5B48zOLLuGE';

// HTTP请求函数
function makeRequest(options, postData = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve(data);
                }
            });
        });
        
        req.on('error', reject);
        
        if (postData) {
            req.write(JSON.stringify(postData));
        }
        
        req.end();
    });
}

// 插入到Supabase的函数
async function insertToSupabase(items) {
    const options = {
        hostname: 'iknktzifjdyujdccyhsv.supabase.co',
        port: 443,
        path: '/rest/v1/library_items',
        method: 'POST',
        headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
        }
    };

    try {
        const result = await makeRequest(options, items);
        return result;
    } catch (error) {
        console.error('Error inserting to Supabase:', error);
        return null;
    }
}

// 扩展的金融出版物数据
const extendedFinancialPublications = [
    // 央行和国际机构报告
    {
        title: "BIS Working Papers",
        author: "Bank for International Settlements",
        description: "Working papers published by the Bank for International Settlements covering monetary policy, financial stability, banking regulation, and international finance.",
        category: "research",
        subcategory: "research_paper",
        source: "BIS",
        source_url: "https://www.bis.org/list/biswp/",
        language: "en",
        tags: ["finance", "central bank", "monetary policy", "research"],
        is_free: true,
        cover_url: "https://www.bis.org/theme/bis/img/logo-bis-print.png"
    },
    {
        title: "BIS Quarterly Review",
        author: "Bank for International Settlements",
        description: "Quarterly publication providing analysis of international financial markets and developments in banking and finance.",
        category: "research",
        subcategory: "periodical",
        source: "BIS",
        source_url: "https://www.bis.org/publ/qtrpdf/",
        language: "en",
        tags: ["finance", "central bank", "quarterly", "international"],
        is_free: true,
        cover_url: "https://www.bis.org/theme/bis/img/logo-bis-print.png"
    },
    {
        title: "NBER Working Paper Series",
        author: "National Bureau of Economic Research",
        description: "Working papers from the National Bureau of Economic Research covering macroeconomics, financial economics, and economic policy research.",
        category: "research",
        subcategory: "research_paper",
        source: "NBER",
        source_url: "https://www.nber.org/papers",
        language: "en",
        tags: ["finance", "economics", "research", "working papers"],
        is_free: true,
        cover_url: "https://www.nber.org/sites/default/files/NBER-logo-new.png"
    },
    {
        title: "Federal Reserve Economic Data (FRED)",
        author: "Federal Reserve Bank of St. Louis",
        description: "Economic data and research from the Federal Reserve, including financial market data, monetary policy analysis, and economic indicators.",
        category: "research",
        subcategory: "database",
        source: "Federal Reserve",
        source_url: "https://fred.stlouisfed.org/",
        language: "en",
        tags: ["finance", "federal reserve", "economic data", "research"],
        is_free: true,
        cover_url: "https://fred.stlouisfed.org/images/FRED-Logo.png"
    },
    {
        title: "IMF Working Papers",
        author: "International Monetary Fund",
        description: "Research papers from the International Monetary Fund covering global economic issues, financial stability, and monetary policy.",
        category: "research",
        subcategory: "research_paper",
        source: "IMF",
        source_url: "https://www.imf.org/en/Publications/WP",
        language: "en",
        tags: ["finance", "IMF", "international", "monetary"],
        is_free: true,
        cover_url: "https://www.imf.org/-/media/Images/IMF/LOGOS/imf-logo.png"
    },
    {
        title: "World Bank Economic Review",
        author: "World Bank Group",
        description: "Academic journal published by the World Bank focusing on development economics, international finance, and economic policy research.",
        category: "research",
        subcategory: "journal",
        source: "World Bank",
        source_url: "https://academic.oup.com/wber",
        language: "en",
        tags: ["finance", "development", "international", "world bank"],
        is_free: false,
        cover_url: "https://www.worldbank.org/content/dam/wbg/logos/logo-wb-header-en.svg"
    },
    {
        title: "ECB Working Paper Series",
        author: "European Central Bank",
        description: "Working papers from the European Central Bank covering monetary policy, banking supervision, and financial stability in the Euro area.",
        category: "research",
        subcategory: "research_paper",
        source: "ECB",
        source_url: "https://www.ecb.europa.eu/pub/research/working-papers/html/index.en.html",
        language: "en",
        tags: ["finance", "european central bank", "monetary policy", "eurozone"],
        is_free: true,
        cover_url: "https://www.ecb.europa.eu/shared/img/logo/ecb-logo-print.png"
    },

    // SSRN 热门金融论文主题
    {
        title: "SSRN Corporate Finance Network",
        author: "Social Science Research Network",
        description: "Research network focusing on corporate finance, including papers on capital structure, corporate governance, and firm valuation.",
        category: "research",
        subcategory: "research_network",
        source: "SSRN",
        source_url: "https://www.ssrn.com/index.cfm/en/cfn/",
        language: "en",
        tags: ["finance", "corporate finance", "research", "SSRN"],
        is_free: true,
        cover_url: "https://www.ssrn.com/images/ssrn-logo.png"
    },
    {
        title: "SSRN Financial Economics Network",
        author: "Social Science Research Network",
        description: "Research network covering asset pricing, financial markets, investments, and quantitative finance research papers.",
        category: "research",
        subcategory: "research_network",
        source: "SSRN",
        source_url: "https://www.ssrn.com/index.cfm/en/fen/",
        language: "en",
        tags: ["finance", "asset pricing", "investments", "SSRN"],
        is_free: true,
        cover_url: "https://www.ssrn.com/images/ssrn-logo.png"
    },
    {
        title: "SSRN Banking & Insurance Network",
        author: "Social Science Research Network",
        description: "Research papers focusing on banking, insurance, financial intermediation, and financial institution management.",
        category: "research",
        subcategory: "research_network",
        source: "SSRN",
        source_url: "https://www.ssrn.com/index.cfm/en/bin/",
        language: "en",
        tags: ["finance", "banking", "insurance", "SSRN"],
        is_free: true,
        cover_url: "https://www.ssrn.com/images/ssrn-logo.png"
    },

    // 更多国际金融期刊
    {
        title: "Journal of International Economics",
        author: "Elsevier",
        description: "Academic journal focusing on international trade, international finance, exchange rates, and open economy macroeconomics.",
        category: "research",
        subcategory: "journal",
        source: "Elsevier",
        source_url: "https://www.journals.elsevier.com/journal-of-international-economics",
        language: "en",
        tags: ["finance", "international", "economics", "exchange rates"],
        is_free: false,
        cover_url: "https://ars.els-cdn.com/content/image/1-s2.0-S0022199618X-cov-150h.gif"
    },
    {
        title: "Journal of Financial Markets",
        author: "Elsevier",
        description: "Academic journal covering market microstructure, trading, liquidity, market efficiency, and behavioral finance research.",
        category: "research",
        subcategory: "journal",
        source: "Elsevier",
        source_url: "https://www.journals.elsevier.com/journal-of-financial-markets",
        language: "en",
        tags: ["finance", "financial markets", "trading", "microstructure"],
        is_free: false,
        cover_url: "https://ars.els-cdn.com/content/image/1-s2.0-S1386418118X-cov-150h.gif"
    },
    {
        title: "Journal of Empirical Finance",
        author: "Elsevier",
        description: "Academic journal focusing on empirical research in finance, covering asset pricing, risk management, and financial econometrics.",
        category: "research",
        subcategory: "journal",
        source: "Elsevier",
        source_url: "https://www.journals.elsevier.com/journal-of-empirical-finance",
        language: "en",
        tags: ["finance", "empirical", "econometrics", "risk"],
        is_free: false,
        cover_url: "https://ars.els-cdn.com/content/image/1-s2.0-S0927539818X-cov-150h.gif"
    },

    // 金融科技和区块链期刊
    {
        title: "Journal of Financial Technology",
        author: "World Scientific",
        description: "Academic journal covering fintech innovations, digital finance, blockchain applications, and financial technology research.",
        category: "research",
        subcategory: "journal",
        source: "World Scientific",
        source_url: "https://www.worldscientific.com/worldscinet/jft",
        language: "en",
        tags: ["finance", "fintech", "technology", "blockchain"],
        is_free: false,
        cover_url: "https://www.worldscientific.com/na101/home/literatum/publisher/wspc/journals/jft.png"
    },
    {
        title: "Financial Innovation",
        author: "Springer Open",
        description: "Open access journal covering financial innovations, digital currencies, fintech applications, and financial technology research.",
        category: "research",
        subcategory: "journal",
        source: "Springer",
        source_url: "https://jfin-swufe.springeropen.com/",
        language: "en",
        tags: ["finance", "innovation", "fintech", "open access"],
        is_free: true,
        cover_url: "https://media.springernature.com/lw685/springer-static/image/art%3A10.1186%2Fs40854-018-0101-2/MediaObjects/40854_2018_101_Figa_HTML.png"
    },

    // 更多中文金融机构和研究
    {
        title: "中国金融",
        author: "中国金融杂志社",
        description: "中国人民银行主管的权威金融期刊，专注于货币政策、金融改革、银行业发展等领域。",
        category: "research",
        subcategory: "journal",
        source: "中国人民银行",
        source_url: "http://www.zgjr.com.cn/",
        language: "zh",
        tags: ["finance", "chinese", "central bank", "monetary policy"],
        is_free: false,
        cover_url: "http://www.zgjr.com.cn/images/logo.png"
    },
    {
        title: "金融研究",
        author: "中国金融学会",
        description: "中国最权威的金融学术期刊，刊载金融理论、政策和实践方面的高质量研究成果。",
        category: "research",
        subcategory: "journal",
        source: "中国金融学会",
        source_url: "http://www.jryj.org.cn/",
        language: "zh",
        tags: ["finance", "chinese", "academic", "research"],
        is_free: false,
        cover_url: "http://www.jryj.org.cn/images/logo.png"
    },
    {
        title: "国际金融研究",
        author: "中国国际金融学会",
        description: "专注于国际金融理论与实践研究的学术期刊，涵盖汇率、国际资本流动、金融开放等领域。",
        category: "research",
        subcategory: "journal",
        source: "中国国际金融学会",
        source_url: "http://www.iifr.org.cn/",
        language: "zh",
        tags: ["finance", "chinese", "international", "exchange rate"],
        is_free: false,
        cover_url: "http://www.iifr.org.cn/images/logo.png"
    },
    {
        title: "银行家",
        author: "中国银行家杂志社",
        description: "面向银行业从业者的专业期刊，关注银行经营管理、风险控制、金融创新等实务问题。",
        category: "research",
        subcategory: "magazine",
        source: "银行家杂志",
        source_url: "http://www.bankershr.com/",
        language: "zh",
        tags: ["finance", "chinese", "banking", "management"],
        is_free: false,
        cover_url: "http://www.bankershr.com/images/logo.png"
    },
    {
        title: "证券市场周刊",
        author: "证券市场周刊社",
        description: "专业的证券投资类期刊，提供股票分析、投资策略、市场观察和上市公司研究。",
        category: "research",
        subcategory: "magazine",
        source: "证券市场周刊",
        source_url: "http://www.stockweekly.com.cn/",
        language: "zh",
        tags: ["finance", "chinese", "securities", "investment"],
        is_free: false,
        cover_url: "http://www.stockweekly.com.cn/images/logo.png"
    },

    // 区域性金融媒体
    {
        title: "Asian Wall Street Journal",
        author: "Dow Jones & Company",
        description: "Asian edition of the Wall Street Journal covering Asian financial markets, business developments, and economic trends.",
        category: "research",
        subcategory: "newspaper",
        source: "Dow Jones",
        source_url: "https://asia.wsj.com/",
        language: "en",
        tags: ["finance", "newspaper", "asian markets", "business"],
        is_free: false,
        cover_url: "https://s.wsj.net/img/meta/wsj-social-share.png"
    },
    {
        title: "Nikkei Asian Review",
        author: "Nikkei Inc.",
        description: "English-language publication covering Asian business, markets, politics, and economics with focus on regional developments.",
        category: "research",
        subcategory: "magazine",
        source: "Nikkei",
        source_url: "https://asia.nikkei.com/",
        language: "en",
        tags: ["finance", "magazine", "asian markets", "nikkei"],
        is_free: false,
        cover_url: "https://www.nikkei.com/images/common/common_logo_01.png"
    },
    {
        title: "South China Morning Post Business",
        author: "South China Morning Post",
        description: "Business and financial news from Hong Kong and Greater China, covering markets, economy, and corporate developments.",
        category: "research",
        subcategory: "newspaper",
        source: "SCMP",
        source_url: "https://www.scmp.com/business",
        language: "en",
        tags: ["finance", "newspaper", "hong kong", "china"],
        is_free: false,
        cover_url: "https://cdn.scmp.com/sites/default/files/styles/facebook_image/public/images/methode/2019/06/12/b1df5c54-8cde-11e9-9e4a-1b9b7a38f8c8.jpg"
    },

    // 专业投资和资产管理期刊
    {
        title: "Journal of Portfolio Management",
        author: "Institutional Investor",
        description: "Professional journal for investment managers covering portfolio theory, asset allocation, risk management, and investment strategies.",
        category: "research",
        subcategory: "journal",
        source: "Institutional Investor",
        source_url: "https://jpm.pm-research.com/",
        language: "en",
        tags: ["finance", "portfolio management", "investment", "asset allocation"],
        is_free: false,
        cover_url: "https://pm-research.com/content/iijpm/cover_current.png"
    },
    {
        title: "Journal of Alternative Investments",
        author: "Institutional Investor",
        description: "Professional journal focusing on alternative investments including hedge funds, private equity, real estate, and commodities.",
        category: "research",
        subcategory: "journal",
        source: "Institutional Investor",
        source_url: "https://jai.pm-research.com/",
        language: "en",
        tags: ["finance", "alternative investments", "hedge funds", "private equity"],
        is_free: false,
        cover_url: "https://pm-research.com/content/iijaltinv/cover_current.png"
    },
    {
        title: "CFA Institute Research Foundation",
        author: "CFA Institute",
        description: "Research publications from CFA Institute covering investment management, ethics, portfolio construction, and financial analysis.",
        category: "research",
        subcategory: "research_paper",
        source: "CFA Institute",
        source_url: "https://www.cfainstitute.org/en/research/foundation",
        language: "en",
        tags: ["finance", "CFA", "investment", "research"],
        is_free: true,
        cover_url: "https://www.cfainstitute.org/-/media/images/cfa-institute/images-logos/cfa-logo.png"
    },

    // ESG和可持续金融
    {
        title: "Journal of Sustainable Finance & Investment",
        author: "Taylor & Francis",
        description: "Academic journal focusing on sustainable finance, ESG investing, green bonds, and responsible investment practices.",
        category: "research",
        subcategory: "journal",
        source: "Taylor & Francis",
        source_url: "https://www.tandfonline.com/toc/tsfi20/current",
        language: "en",
        tags: ["finance", "sustainable", "ESG", "green finance"],
        is_free: false,
        cover_url: "https://www.tandfonline.com/na101/home/literatum/publisher/tandf/journals/tsfi20.png"
    },
    {
        title: "Green Finance",
        author: "AIMS Press",
        description: "Open access journal covering green finance, sustainable investing, climate finance, and environmental economics.",
        category: "research",
        subcategory: "journal",
        source: "AIMS Press",
        source_url: "https://www.aimspress.com/journal/gf",
        language: "en",
        tags: ["finance", "green finance", "climate", "sustainable"],
        is_free: true,
        cover_url: "https://www.aimspress.com/fileOther/PDF/GF/aims-logo.png"
    },

    // 金融监管和合规期刊
    {
        title: "Journal of Financial Regulation and Compliance",
        author: "Emerald Publishing",
        description: "Professional journal covering financial regulation, compliance, risk management, and regulatory developments in banking and finance.",
        category: "research",
        subcategory: "journal",
        source: "Emerald",
        source_url: "https://www.emerald.com/insight/publication/issn/1358-1988",
        language: "en",
        tags: ["finance", "regulation", "compliance", "risk management"],
        is_free: false,
        cover_url: "https://www.emeraldgrouppublishing.com/journal/jfrc/cover_current.png"
    },
    {
        title: "Banking & Finance Law Review",
        author: "CCH",
        description: "Professional journal covering banking law, financial services regulation, and legal developments in the financial sector.",
        category: "research",
        subcategory: "journal",
        source: "CCH",
        source_url: "https://www.cch.com/bflr/",
        language: "en",
        tags: ["finance", "banking law", "regulation", "legal"],
        is_free: false,
        cover_url: "https://www.cch.com/images/bflr-cover.png"
    },

    // 行为金融学
    {
        title: "Journal of Behavioral Finance",
        author: "Taylor & Francis",
        description: "Academic journal focusing on behavioral aspects of finance, including investor psychology, market anomalies, and decision-making biases.",
        category: "research",
        subcategory: "journal",
        source: "Taylor & Francis",
        source_url: "https://www.tandfonline.com/toc/hbhf20/current",
        language: "en",
        tags: ["finance", "behavioral finance", "psychology", "decision making"],
        is_free: false,
        cover_url: "https://www.tandfonline.com/na101/home/literatum/publisher/tandf/journals/hbhf20.png"
    },

    // 量化金融
    {
        title: "Quantitative Finance",
        author: "Taylor & Francis",
        description: "Academic journal covering mathematical finance, derivatives pricing, risk management, and computational methods in finance.",
        category: "research",
        subcategory: "journal",
        source: "Taylor & Francis",
        source_url: "https://www.tandfonline.com/toc/rquf20/current",
        language: "en",
        tags: ["finance", "quantitative", "derivatives", "mathematical finance"],
        is_free: false,
        cover_url: "https://www.tandfonline.com/na101/home/literatum/publisher/tandf/journals/rquf20.png"
    },
    {
        title: "Journal of Computational Finance",
        author: "Incisive Media",
        description: "Academic journal focusing on computational methods, numerical techniques, and mathematical modeling in finance.",
        category: "research",
        subcategory: "journal",
        source: "Incisive Media",
        source_url: "https://www.risk.net/journal-of-computational-finance",
        language: "en",
        tags: ["finance", "computational", "mathematical modeling", "numerical methods"],
        is_free: false,
        cover_url: "https://www.risk.net/sites/default/files/styles/rn_hero_image/public/2019-03/jcf-logo.png"
    },

    // 保险和精算期刊
    {
        title: "Journal of Risk and Insurance",
        author: "Wiley",
        description: "Academic journal covering risk management, insurance theory, actuarial science, and insurance market research.",
        category: "research",
        subcategory: "journal",
        source: "Wiley",
        source_url: "https://onlinelibrary.wiley.com/journal/15396975",
        language: "en",
        tags: ["finance", "insurance", "risk management", "actuarial"],
        is_free: false,
        cover_url: "https://onlinelibrary.wiley.com/pb-assets/journal-banners/15396975-1568722654039.jpg"
    },
    {
        title: "Geneva Papers on Risk and Insurance",
        author: "Springer",
        description: "Academic journal covering issues and theory in risk and insurance, with focus on international perspectives and policy analysis.",
        category: "research",
        subcategory: "journal",
        source: "Springer",
        source_url: "https://link.springer.com/journal/41288",
        language: "en",
        tags: ["finance", "insurance", "risk", "policy"],
        is_free: false,
        cover_url: "https://media.springernature.com/lw685/springer-static/image/journal/41288.png"
    }
];

// 分批插入函数
async function insertInBatches(items, batchSize = 10) {
    let totalInserted = 0;
    const totalItems = items.length;
    
    console.log(`开始插入 ${totalItems} 条扩展记录到 Supabase...`);
    
    for (let i = 0; i < totalItems; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        
        console.log(`插入第 ${Math.floor(i/batchSize) + 1} 批，共 ${batch.length} 条记录...`);
        
        try {
            const result = await insertToSupabase(batch);
            if (result && Array.isArray(result)) {
                totalInserted += result.length;
                console.log(`✅ 成功插入 ${result.length} 条记录`);
            } else if (result) {
                totalInserted += batch.length;
                console.log(`✅ 批量插入成功`);
            } else {
                console.log(`❌ 批量插入失败`);
            }
        } catch (error) {
            console.error(`❌ 插入第 ${Math.floor(i/batchSize) + 1} 批时出错:`, error);
        }
        
        // 避免API限制，每批之间稍微等待
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    console.log(`\n📊 扩展插入完成! 总共尝试插入 ${totalItems} 条记录，成功插入 ${totalInserted} 条记录`);
    return totalInserted;
}

// 主函数
async function main() {
    console.log('🚀 开始扩展金融出版物数据集...\n');
    
    // 插入数据
    const totalInserted = await insertInBatches(extendedFinancialPublications);
    
    // 保存到本地文件用于备份
    const backupFile = `/Users/adelinewen/ranking-arena/extended_financial_publications_backup_${Date.now()}.json`;
    fs.writeFileSync(backupFile, JSON.stringify(extendedFinancialPublications, null, 2));
    console.log(`\n💾 扩展数据已备份到: ${backupFile}`);
    
    // 输出摘要
    console.log('\n📈 扩展收集摘要:');
    console.log(`- 英文出版物: ${extendedFinancialPublications.filter(p => p.language === 'en').length} 个`);
    console.log(`- 中文出版物: ${extendedFinancialPublications.filter(p => p.language === 'zh').length} 个`);
    console.log(`- 学术期刊: ${extendedFinancialPublications.filter(p => p.subcategory === 'journal').length} 个`);
    console.log(`- 研究论文: ${extendedFinancialPublications.filter(p => p.subcategory === 'research_paper').length} 个`);
    console.log(`- 研究网络: ${extendedFinancialPublications.filter(p => p.subcategory === 'research_network').length} 个`);
    console.log(`- 报纸: ${extendedFinancialPublications.filter(p => p.subcategory === 'newspaper').length} 个`);
    console.log(`- 杂志: ${extendedFinancialPublications.filter(p => p.subcategory === 'magazine').length} 个`);
    console.log(`- 免费资源: ${extendedFinancialPublications.filter(p => p.is_free).length} 个`);
    console.log(`- 付费资源: ${extendedFinancialPublications.filter(p => !p.is_free).length} 个`);
    console.log(`\n✅ 扩展任务完成! 新增收集了 ${extendedFinancialPublications.length} 个金融出版物记录`);
}

// 运行主函数
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { extendedFinancialPublications, insertToSupabase, insertInBatches };