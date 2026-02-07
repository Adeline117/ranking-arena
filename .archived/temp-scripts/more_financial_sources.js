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

// 更多金融媒体和资源
const moreFinancialSources = [
    // 知名财经网站和博客
    {
        title: "Zero Hedge",
        author: "Zero Hedge",
        description: "Financial blog providing alternative analysis of markets, economics, and financial news with contrarian perspectives.",
        category: "research",
        subcategory: "blog",
        source: "Zero Hedge",
        source_url: "https://www.zerohedge.com",
        language: "en",
        tags: ["finance", "blog", "markets", "contrarian"],
        is_free: true,
        cover_url: "https://www.zerohedge.com/s3/files/pictures/picture-5.jpg"
    },
    {
        title: "MarketWatch",
        author: "Dow Jones",
        description: "Financial information website providing real-time market data, analysis, and financial news for investors and traders.",
        category: "research",
        subcategory: "news",
        source: "MarketWatch",
        source_url: "https://www.marketwatch.com",
        language: "en",
        tags: ["finance", "markets", "news", "trading"],
        is_free: true,
        cover_url: "https://mw3.wsj.net/mw5/content/logos/mw_logo_social.png"
    },
    {
        title: "Yahoo Finance",
        author: "Yahoo",
        description: "Comprehensive financial platform providing market data, news, portfolio tracking, and financial planning tools.",
        category: "research",
        subcategory: "news",
        source: "Yahoo",
        source_url: "https://finance.yahoo.com",
        language: "en",
        tags: ["finance", "markets", "news", "portfolio"],
        is_free: true,
        cover_url: "https://s.yimg.com/ny/api/res/1.2/4HoLkKH2aTNJfLut8c4nLg--/YXBwaWQ9aGlnaGxhbmRlcjtzbT0xO3c9MTIwMDtoPTYzMA--/https://media.zenfs.com/en-US/yahoo_finance_live_924/cce54ea10bea3b45aa9de5e17a30ff41"
    },
    {
        title: "Seeking Alpha",
        author: "Seeking Alpha",
        description: "Crowdsourced investment research platform providing stock analysis, earnings calls, and market commentary from analysts and investors.",
        category: "research",
        subcategory: "investment_platform",
        source: "Seeking Alpha",
        source_url: "https://seekingalpha.com",
        language: "en",
        tags: ["finance", "investment", "analysis", "stocks"],
        is_free: false,
        cover_url: "https://static.seekingalpha.com/uploads/2019/4/12/saupload_SA_logo_512x512.png"
    },
    {
        title: "The Motley Fool",
        author: "The Motley Fool",
        description: "Investment advice and financial education platform providing stock recommendations, market analysis, and long-term investment strategies.",
        category: "research",
        subcategory: "investment_platform",
        source: "The Motley Fool",
        source_url: "https://www.fool.com",
        language: "en",
        tags: ["finance", "investment", "advice", "long-term"],
        is_free: true,
        cover_url: "https://g.foolcdn.com/art/companylogos/square/tmf.png"
    },
    {
        title: "Morningstar",
        author: "Morningstar, Inc.",
        description: "Investment research and management platform providing mutual fund analysis, stock research, and portfolio tools.",
        category: "research",
        subcategory: "investment_platform",
        source: "Morningstar",
        source_url: "https://www.morningstar.com",
        language: "en",
        tags: ["finance", "investment", "funds", "research"],
        is_free: false,
        cover_url: "https://www.morningstar.com/content/dam/ms-com/images/company/logo/morningstar-logo-blue.svg"
    },
    {
        title: "Investopedia",
        author: "Dotdash Meredith",
        description: "Financial education website providing investing tutorials, market analysis, and comprehensive financial term definitions.",
        category: "research",
        subcategory: "education",
        source: "Investopedia",
        source_url: "https://www.investopedia.com",
        language: "en",
        tags: ["finance", "education", "investing", "tutorials"],
        is_free: true,
        cover_url: "https://www.investopedia.com/thmb/yjKmGfKoP4hIm7PaLu3g9xyHLMM=/1500x0/filters:no_upscale():max_bytes(150000):strip_icc()/Investopedia_Logo_5000px_White-100654b0f8e54bfdb34dc8568e4bb8e6.jpg"
    },
    {
        title: "CNBC",
        author: "NBCUniversal",
        description: "Business news television network and website providing real-time financial market coverage, business news, and economic analysis.",
        category: "research",
        subcategory: "news",
        source: "CNBC",
        source_url: "https://www.cnbc.com",
        language: "en",
        tags: ["finance", "news", "television", "markets"],
        is_free: true,
        cover_url: "https://www.cnbc.com/a/img/cnbc-logo-square-500x500.png"
    },
    {
        title: "Bloomberg Terminal",
        author: "Bloomberg L.P.",
        description: "Professional financial data and analytics terminal providing real-time market data, news, and trading tools for financial professionals.",
        category: "research",
        subcategory: "terminal",
        source: "Bloomberg",
        source_url: "https://www.bloomberg.com/professional/solution/bloomberg-terminal/",
        language: "en",
        tags: ["finance", "terminal", "professional", "data"],
        is_free: false,
        cover_url: "https://assets.bbhub.io/professional/sites/10/Bloomberg-Terminal-logo.png"
    },
    {
        title: "Reuters",
        author: "Thomson Reuters",
        description: "International news organization providing comprehensive coverage of global markets, business news, and financial analysis.",
        category: "research",
        subcategory: "news",
        source: "Reuters",
        source_url: "https://www.reuters.com/business/finance/",
        language: "en",
        tags: ["finance", "news", "international", "markets"],
        is_free: true,
        cover_url: "https://www.reuters.com/resizer/9AbiZ4A8xc9rAhWs1YjYTOBvC6M=/1200x628/smart/filters:quality(80)/cloudfront-us-east-2.images.arcpublishing.com/reuters/2ALWGPXEHJJOVFPG5UYOFR37FY.jpg"
    },

    // 专业投资研究平台
    {
        title: "FactSet",
        author: "FactSet Research Systems",
        description: "Financial data and software company providing integrated portfolio management, analytics, and reporting solutions for investment professionals.",
        category: "research",
        subcategory: "terminal",
        source: "FactSet",
        source_url: "https://www.factset.com",
        language: "en",
        tags: ["finance", "data", "analytics", "professional"],
        is_free: false,
        cover_url: "https://www.factset.com/hubfs/FactSet-Logo-Blue.png"
    },
    {
        title: "Refinitiv (formerly Thomson Reuters)",
        author: "Refinitiv",
        description: "Financial market data and infrastructure provider offering analytics, trading solutions, and risk management tools.",
        category: "research",
        subcategory: "terminal",
        source: "Refinitiv",
        source_url: "https://www.refinitiv.com",
        language: "en",
        tags: ["finance", "data", "trading", "risk"],
        is_free: false,
        cover_url: "https://www.refinitiv.com/content/dam/marketing/en_us/images/logos/refinitiv-logo.png"
    },
    {
        title: "S&P Capital IQ",
        author: "S&P Global Market Intelligence",
        description: "Financial research and analytics platform providing company data, market intelligence, and credit risk assessment tools.",
        category: "research",
        subcategory: "terminal",
        source: "S&P Global",
        source_url: "https://www.capitaliq.com",
        language: "en",
        tags: ["finance", "research", "analytics", "credit risk"],
        is_free: false,
        cover_url: "https://www.spglobal.com/_assets/images/spglobal-logo-color.svg"
    },

    // 货币和外汇专业媒体
    {
        title: "ForexLive",
        author: "ForexLive",
        description: "Foreign exchange news and analysis website providing real-time FX market updates, central bank coverage, and trading insights.",
        category: "research",
        subcategory: "news",
        source: "ForexLive",
        source_url: "https://www.forexlive.com",
        language: "en",
        tags: ["finance", "forex", "currency", "trading"],
        is_free: true,
        cover_url: "https://www.forexlive.com/assets/images/fl-logo-sq.png"
    },
    {
        title: "DailyFX",
        author: "IG Group",
        description: "Foreign exchange and CFD trading news, analysis, and educational content for currency traders and investors.",
        category: "research",
        subcategory: "news",
        source: "DailyFX",
        source_url: "https://www.dailyfx.com",
        language: "en",
        tags: ["finance", "forex", "CFD", "education"],
        is_free: true,
        cover_url: "https://a.c-dn.net/b/0DHCLD/logo-dailyfx.svg"
    },

    // 另类投资和私募媒体
    {
        title: "Private Equity International",
        author: "PEI Media",
        description: "Professional publication covering private equity, venture capital, and alternative investment markets worldwide.",
        category: "research",
        subcategory: "magazine",
        source: "PEI Media",
        source_url: "https://www.privateequityinternational.com",
        language: "en",
        tags: ["finance", "private equity", "venture capital", "alternative"],
        is_free: false,
        cover_url: "https://www.peimedia.com/sitefiles/peimedia/img/logo.png"
    },
    {
        title: "Hedge Fund Journal",
        author: "Hedge Fund Journal",
        description: "Professional publication covering hedge fund industry news, strategies, performance analysis, and regulatory developments.",
        category: "research",
        subcategory: "magazine",
        source: "Hedge Fund Journal",
        source_url: "https://www.thehedgefundjournal.com",
        language: "en",
        tags: ["finance", "hedge funds", "strategies", "performance"],
        is_free: false,
        cover_url: "https://www.thehedgefundjournal.com/wp-content/uploads/2019/03/hfj-logo.png"
    },

    // 房地产金融
    {
        title: "Real Estate Finance & Investment",
        author: "Euromoney Institutional Investor",
        description: "Professional publication covering real estate finance, REIT analysis, property investment, and commercial real estate markets.",
        category: "research",
        subcategory: "magazine",
        source: "Euromoney",
        source_url: "https://www.refi-news.com",
        language: "en",
        tags: ["finance", "real estate", "REIT", "property"],
        is_free: false,
        cover_url: "https://www.euromoney.com/sitecore/content/Euromoney/Home/Resources/Images/Euromoney-Logo.svg"
    },

    // 更多中文金融媒体
    {
        title: "和讯网",
        author: "和讯网",
        description: "中国知名财经门户网站，提供股票、基金、期货、外汇、保险等全方位的金融信息和分析。",
        category: "research",
        subcategory: "news",
        source: "和讯网",
        source_url: "http://www.hexun.com",
        language: "zh",
        tags: ["finance", "chinese", "portal", "comprehensive"],
        is_free: true,
        cover_url: "http://i0.hexun.com/images/logo.png"
    },
    {
        title: "新浪财经",
        author: "新浪",
        description: "新浪旗下财经频道，提供股市行情、财经新闻、投资理财和宏观经济分析。",
        category: "research",
        subcategory: "news",
        source: "新浪",
        source_url: "https://finance.sina.com.cn",
        language: "zh",
        tags: ["finance", "chinese", "sina", "markets"],
        is_free: true,
        cover_url: "https://n.sinaimg.cn/finance/transform/266/w640h426/20200326/c5f4-iquxrux5853964.png"
    },
    {
        title: "网易财经",
        author: "网易",
        description: "网易旗下财经频道，关注宏观经济、股市动态、基金投资和企业财报分析。",
        category: "research",
        subcategory: "news",
        source: "网易",
        source_url: "https://money.163.com",
        language: "zh",
        tags: ["finance", "chinese", "netease", "economy"],
        is_free: true,
        cover_url: "https://s.money.163.com/netease_money/img/logo.png"
    },
    {
        title: "腾讯财经",
        author: "腾讯",
        description: "腾讯旗下财经频道，提供实时股市行情、财经新闻、投资策略和理财指南。",
        category: "research",
        subcategory: "news",
        source: "腾讯",
        source_url: "https://finance.qq.com",
        language: "zh",
        tags: ["finance", "chinese", "tencent", "investment"],
        is_free: true,
        cover_url: "https://mat1.gtimg.com/finance/images/logo.png"
    },
    {
        title: "东方财富网",
        author: "东方财富",
        description: "中国领先的财经门户网站，提供股票、基金、期货、债券等金融产品的行情和分析。",
        category: "research",
        subcategory: "news",
        source: "东方财富",
        source_url: "http://www.eastmoney.com",
        language: "zh",
        tags: ["finance", "chinese", "eastmoney", "trading"],
        is_free: true,
        cover_url: "http://webquotepic.eastmoney.com/GetPic.aspx?nid=1.000001&imageType=k&token=28dfeb41d35cc81d84b4664d7c23c49f"
    },
    {
        title: "中金在线",
        author: "中金在线",
        description: "专业的财经网站，专注于黄金、外汇、期货、股票等金融市场的实时行情和深度分析。",
        category: "research",
        subcategory: "news",
        source: "中金在线",
        source_url: "http://www.cnfol.com",
        language: "zh",
        tags: ["finance", "chinese", "gold", "forex"],
        is_free: true,
        cover_url: "http://res.cnfol.com/2016pc/img/logo_new.png"
    },
    {
        title: "金融界",
        author: "金融界",
        description: "中国知名的财经门户网站，提供股票、基金、理财、保险等全方位的金融服务和资讯。",
        category: "research",
        subcategory: "news",
        source: "金融界",
        source_url: "http://www.jrj.com.cn",
        language: "zh",
        tags: ["finance", "chinese", "jrj", "comprehensive"],
        is_free: true,
        cover_url: "http://img.jrjimg.cn/2017/08/jrj_logo.png"
    },
    {
        title: "同花顺财经",
        author: "同花顺",
        description: "知名的金融信息服务商，提供股票软件、行情分析、投资策略和财经资讯。",
        category: "research",
        subcategory: "platform",
        source: "同花顺",
        source_url: "http://www.10jqka.com.cn",
        language: "zh",
        tags: ["finance", "chinese", "software", "analysis"],
        is_free: true,
        cover_url: "http://img.10jqka.com.cn/20161025/logo.png"
    },

    // 国际经济组织报告
    {
        title: "OECD Economic Outlook",
        author: "Organization for Economic Co-operation and Development",
        description: "Biannual publication providing analysis and forecasts of economic developments in OECD countries and major non-member economies.",
        category: "research",
        subcategory: "report",
        source: "OECD",
        source_url: "https://www.oecd.org/economic-outlook/",
        language: "en",
        tags: ["finance", "economics", "forecast", "international"],
        is_free: true,
        cover_url: "https://www.oecd.org/media/oecdorg/satellitesites/newsroom/2019-OECD-Logo-Colour-Horizontal-EN.png"
    },
    {
        title: "World Economic Forum Reports",
        author: "World Economic Forum",
        description: "Research and reports on global economic issues, financial system risks, and sustainable development from the World Economic Forum.",
        category: "research",
        subcategory: "report",
        source: "WEF",
        source_url: "https://www.weforum.org/reports/",
        language: "en",
        tags: ["finance", "global", "sustainability", "risks"],
        is_free: true,
        cover_url: "https://assets.weforum.org/global/images/wef-logo-blue.svg"
    },
    {
        title: "G20 Financial Stability Board",
        author: "Financial Stability Board",
        description: "International body that monitors and makes recommendations about the global financial system and financial stability.",
        category: "research",
        subcategory: "report",
        source: "FSB",
        source_url: "https://www.fsb.org/",
        language: "en",
        tags: ["finance", "stability", "regulation", "international"],
        is_free: true,
        cover_url: "https://www.fsb.org/wp-content/themes/fsb/images/logo-fsb.png"
    },

    // 评级机构
    {
        title: "Moody's Investor Services",
        author: "Moody's Corporation",
        description: "Credit rating agency providing credit ratings, research, and analysis on bonds, loans, and other financial instruments.",
        category: "research",
        subcategory: "rating_agency",
        source: "Moody's",
        source_url: "https://www.moodys.com",
        language: "en",
        tags: ["finance", "credit rating", "bonds", "research"],
        is_free: false,
        cover_url: "https://www.moodys.com/sites/products/ProductAttachments/moodyslogo.png"
    },
    {
        title: "Standard & Poor's Global Ratings",
        author: "S&P Global Inc.",
        description: "Credit rating agency providing credit ratings, research, and analysis on corporate and sovereign debt worldwide.",
        category: "research",
        subcategory: "rating_agency",
        source: "S&P Global",
        source_url: "https://www.standardandpoors.com",
        language: "en",
        tags: ["finance", "credit rating", "sovereign", "corporate"],
        is_free: false,
        cover_url: "https://www.spglobal.com/_assets/images/spglobal-logo-color.svg"
    },
    {
        title: "Fitch Ratings",
        author: "Fitch Ratings Inc.",
        description: "Credit rating agency providing credit opinions, research, and data to the global financial markets.",
        category: "research",
        subcategory: "rating_agency",
        source: "Fitch",
        source_url: "https://www.fitchratings.com",
        language: "en",
        tags: ["finance", "credit rating", "research", "data"],
        is_free: false,
        cover_url: "https://www.fitchratings.com/images/logos/fitch-logo.svg"
    },

    // 交易所出版物
    {
        title: "NYSE Research",
        author: "New York Stock Exchange",
        description: "Research and market insights from the New York Stock Exchange covering market structure, trading, and listed company analysis.",
        category: "research",
        subcategory: "exchange",
        source: "NYSE",
        source_url: "https://www.nyse.com/research",
        language: "en",
        tags: ["finance", "NYSE", "trading", "market structure"],
        is_free: true,
        cover_url: "https://www.nyse.com/publicdocs/nyse/images/NYSE_Logo_Horizontal_RGB.svg"
    },
    {
        title: "NASDAQ Economic Research",
        author: "NASDAQ",
        description: "Economic research and market analysis from NASDAQ covering technology stocks, market trends, and economic indicators.",
        category: "research",
        subcategory: "exchange",
        source: "NASDAQ",
        source_url: "https://www.nasdaq.com/market-insight",
        language: "en",
        tags: ["finance", "NASDAQ", "technology", "market trends"],
        is_free: true,
        cover_url: "https://www.nasdaq.com/sites/acquia.prod/files/2019-07/nasdaq-logo-blue.svg"
    },
    {
        title: "LSE Research",
        author: "London Stock Exchange",
        description: "Research and market intelligence from the London Stock Exchange covering European markets and global financial trends.",
        category: "research",
        subcategory: "exchange",
        source: "LSE",
        source_url: "https://www.londonstockexchange.com/research",
        language: "en",
        tags: ["finance", "LSE", "european markets", "research"],
        is_free: true,
        cover_url: "https://docs.londonstockexchange.com/sites/default/files/documents/lse-logo-black.svg"
    },

    // 专业培训和认证机构
    {
        title: "CFA Institute Publications",
        author: "CFA Institute",
        description: "Professional development materials, research, and publications for investment management professionals and CFA charterholders.",
        category: "research",
        subcategory: "education",
        source: "CFA Institute",
        source_url: "https://www.cfainstitute.org/en/membership/professional-development/refresher-readings",
        language: "en",
        tags: ["finance", "CFA", "professional development", "certification"],
        is_free: false,
        cover_url: "https://www.cfainstitute.org/-/media/images/cfa-institute/images-logos/cfa-logo.png"
    },
    {
        title: "FRM Handbook",
        author: "Global Association of Risk Professionals",
        description: "Risk management education materials and handbook for Financial Risk Manager (FRM) certification candidates.",
        category: "research",
        subcategory: "education",
        source: "GARP",
        source_url: "https://www.garp.org/frm",
        language: "en",
        tags: ["finance", "risk management", "FRM", "certification"],
        is_free: false,
        cover_url: "https://www.garp.org/hubfs/Website_2019/GARP-logo-tag-high-res-removebg.png"
    },

    // 政府金融部门出版物
    {
        title: "U.S. Treasury Financial Research",
        author: "U.S. Department of Treasury",
        description: "Research and analysis from the U.S. Treasury on fiscal policy, debt management, and financial market developments.",
        category: "research",
        subcategory: "government",
        source: "U.S. Treasury",
        source_url: "https://home.treasury.gov/policy-issues/financial-markets-financial-institutions-and-fiscal-service/financial-research",
        language: "en",
        tags: ["finance", "treasury", "fiscal policy", "government"],
        is_free: true,
        cover_url: "https://home.treasury.gov/sites/default/files/treasury_seal_rgb_tm.png"
    },
    {
        title: "UK Financial Conduct Authority",
        author: "Financial Conduct Authority",
        description: "Regulatory publications, research, and guidance from the UK's financial services regulator.",
        category: "research",
        subcategory: "government",
        source: "FCA",
        source_url: "https://www.fca.org.uk/publications/research",
        language: "en",
        tags: ["finance", "regulation", "UK", "FCA"],
        is_free: true,
        cover_url: "https://www.fca.org.uk/static/fca-logo-black.svg"
    },

    // 更多专业博客和分析师
    {
        title: "Calculated Risk",
        author: "Bill McBride",
        description: "Economic and financial blog providing analysis of housing markets, employment data, and economic indicators.",
        category: "research",
        subcategory: "blog",
        source: "Calculated Risk",
        source_url: "https://www.calculatedriskblog.com",
        language: "en",
        tags: ["finance", "blog", "economics", "housing"],
        is_free: true,
        cover_url: "https://2.bp.blogspot.com/-5p7H2m3Hpec/V3lrF5QGZTI/AAAAAAAAhPE/t9Rt5EiQaJQjKmVaKvJ5qF8pYi8_6wGXgCLcB/s1600/CR%2BLogo%2B2016%2B-%2BSmall.jpg"
    },
    {
        title: "Marginal Revolution",
        author: "Tyler Cowen and Alex Tabarrok",
        description: "Economics blog covering financial markets, economic theory, and policy analysis from George Mason University economists.",
        category: "research",
        subcategory: "blog",
        source: "Marginal Revolution",
        source_url: "https://marginalrevolution.com",
        language: "en",
        tags: ["finance", "blog", "economics", "academic"],
        is_free: true,
        cover_url: "https://marginalrevolution.com/wp-content/themes/mr/img/mr-logo.png"
    },
    {
        title: "Macro Musings",
        author: "David Beckworth",
        description: "Macroeconomic analysis blog and podcast covering monetary policy, central banking, and macroeconomic developments.",
        category: "research",
        subcategory: "blog",
        source: "Macro Musings",
        source_url: "https://macromusings.libsyn.com",
        language: "en",
        tags: ["finance", "blog", "macro", "monetary policy"],
        is_free: true,
        cover_url: "https://ssl-static.libsyn.com/p/assets/8/1/3/2/8132d0b4c43e0946/MacroMusings.png"
    }
];

// 分批插入函数
async function insertInBatches(items, batchSize = 10) {
    let totalInserted = 0;
    const totalItems = items.length;
    
    console.log(`开始插入 ${totalItems} 条更多金融媒体记录到 Supabase...`);
    
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
    
    console.log(`\n📊 更多媒体插入完成! 总共尝试插入 ${totalItems} 条记录，成功插入 ${totalInserted} 条记录`);
    return totalInserted;
}

// 主函数
async function main() {
    console.log('🚀 开始添加更多金融媒体和资源...\n');
    
    // 插入数据
    const totalInserted = await insertInBatches(moreFinancialSources);
    
    // 保存到本地文件用于备份
    const backupFile = `/Users/adelinewen/ranking-arena/more_financial_sources_backup_${Date.now()}.json`;
    fs.writeFileSync(backupFile, JSON.stringify(moreFinancialSources, null, 2));
    console.log(`\n💾 更多媒体数据已备份到: ${backupFile}`);
    
    // 输出摘要
    console.log('\n📈 更多媒体收集摘要:');
    console.log(`- 英文出版物: ${moreFinancialSources.filter(p => p.language === 'en').length} 个`);
    console.log(`- 中文出版物: ${moreFinancialSources.filter(p => p.language === 'zh').length} 个`);
    console.log(`- 新闻网站: ${moreFinancialSources.filter(p => p.subcategory === 'news').length} 个`);
    console.log(`- 博客: ${moreFinancialSources.filter(p => p.subcategory === 'blog').length} 个`);
    console.log(`- 投资平台: ${moreFinancialSources.filter(p => p.subcategory === 'investment_platform').length} 个`);
    console.log(`- 终端/平台: ${moreFinancialSources.filter(p => p.subcategory === 'terminal').length} 个`);
    console.log(`- 评级机构: ${moreFinancialSources.filter(p => p.subcategory === 'rating_agency').length} 个`);
    console.log(`- 教育资源: ${moreFinancialSources.filter(p => p.subcategory === 'education').length} 个`);
    console.log(`- 免费资源: ${moreFinancialSources.filter(p => p.is_free).length} 个`);
    console.log(`- 付费资源: ${moreFinancialSources.filter(p => !p.is_free).length} 个`);
    console.log(`\n✅ 更多媒体任务完成! 新增收集了 ${moreFinancialSources.length} 个金融媒体记录`);
}

// 运行主函数
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { moreFinancialSources, insertToSupabase, insertInBatches };