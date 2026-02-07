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

// 最终批次的金融资源
const finalFinancialBatch = [
    // 地区性和国际金融期刊
    {
        title: "Journal of Asian Economics",
        author: "Elsevier",
        description: "Academic journal covering economic and financial developments in Asian countries, including China, Japan, Korea, and Southeast Asia.",
        category: "research",
        subcategory: "journal",
        source: "Elsevier",
        source_url: "https://www.journals.elsevier.com/journal-of-asian-economics",
        language: "en",
        tags: ["finance", "asian economics", "regional", "development"],
        is_free: false,
        cover_url: "https://ars.els-cdn.com/content/image/1-s2.0-S1049007818X-cov-150h.gif"
    },
    {
        title: "European Financial Management",
        author: "Wiley",
        description: "Academic journal focusing on financial management issues specific to European markets and multinational corporations.",
        category: "research",
        subcategory: "journal",
        source: "Wiley",
        source_url: "https://onlinelibrary.wiley.com/journal/1468036x",
        language: "en",
        tags: ["finance", "european markets", "management", "multinational"],
        is_free: false,
        cover_url: "https://onlinelibrary.wiley.com/pb-assets/journal-banners/1468036X-1568722654046.jpg"
    },
    {
        title: "Pacific-Basin Finance Journal",
        author: "Elsevier",
        description: "Academic journal covering financial markets and institutions in the Pacific Basin region, including Australia, Asia, and the Pacific Rim.",
        category: "research",
        subcategory: "journal",
        source: "Elsevier",
        source_url: "https://www.journals.elsevier.com/pacific-basin-finance-journal",
        language: "en",
        tags: ["finance", "pacific basin", "asia", "regional"],
        is_free: false,
        cover_url: "https://ars.els-cdn.com/content/image/1-s2.0-S0927538X18X-cov-150h.gif"
    },

    // 专业投资策略和分析
    {
        title: "Active Trader Magazine",
        author: "Active Trader",
        description: "Professional magazine for active traders covering technical analysis, trading strategies, and market commentary.",
        category: "research",
        subcategory: "magazine",
        source: "Active Trader",
        source_url: "https://www.activetrader.com",
        language: "en",
        tags: ["finance", "trading", "technical analysis", "strategies"],
        is_free: false,
        cover_url: "https://www.activetrader.com/images/at-logo.png"
    },
    {
        title: "Stocks & Commodities Magazine",
        author: "Technical Analysis Inc.",
        description: "Monthly magazine covering technical analysis, trading systems, and market indicators for stocks and commodities.",
        category: "research",
        subcategory: "magazine",
        source: "Technical Analysis Inc.",
        source_url: "https://www.traders.com",
        language: "en",
        tags: ["finance", "technical analysis", "commodities", "indicators"],
        is_free: false,
        cover_url: "https://www.traders.com/Documentation/images/tasc-logo.png"
    },
    {
        title: "Futures Magazine",
        author: "Futures Magazine",
        description: "Professional magazine covering futures and options markets, derivatives trading, and commodity analysis.",
        category: "research",
        subcategory: "magazine",
        source: "Futures Magazine",
        source_url: "https://www.futuresmag.com",
        language: "en",
        tags: ["finance", "futures", "options", "derivatives"],
        is_free: false,
        cover_url: "https://www.futuresmag.com/themes/custom/futures/logo.png"
    },

    // 银行业专业期刊
    {
        title: "American Banker",
        author: "American Banker",
        description: "Daily publication for banking professionals covering industry news, regulatory developments, and technology trends.",
        category: "research",
        subcategory: "newspaper",
        source: "American Banker",
        source_url: "https://www.americanbanker.com",
        language: "en",
        tags: ["finance", "banking", "regulation", "technology"],
        is_free: false,
        cover_url: "https://www.americanbanker.com/masthead/images/american-banker-logo.svg"
    },
    {
        title: "The Banker",
        author: "Financial Times",
        description: "International banking magazine covering global banking trends, regulation, and financial institution analysis.",
        category: "research",
        subcategory: "magazine",
        source: "Financial Times",
        source_url: "https://www.thebanker.com",
        language: "en",
        tags: ["finance", "banking", "international", "regulation"],
        is_free: false,
        cover_url: "https://www.thebanker.com/images/thebanker-logo.png"
    },
    {
        title: "Banking Technology",
        author: "Finextra",
        description: "Publication focusing on banking technology, fintech innovations, digital transformation, and IT solutions for financial services.",
        category: "research",
        subcategory: "magazine",
        source: "Finextra",
        source_url: "https://www.bankingtech.com",
        language: "en",
        tags: ["finance", "banking technology", "fintech", "digital"],
        is_free: true,
        cover_url: "https://www.bankingtech.com/wp-content/themes/bankingtech/img/bt-logo.svg"
    },

    // 保险业期刊
    {
        title: "Insurance Journal",
        author: "Insurance Journal",
        description: "Professional publication covering property/casualty insurance, commercial insurance, and insurance industry news.",
        category: "research",
        subcategory: "magazine",
        source: "Insurance Journal",
        source_url: "https://www.insurancejournal.com",
        language: "en",
        tags: ["finance", "insurance", "property casualty", "commercial"],
        is_free: true,
        cover_url: "https://www.insurancejournal.com/app/uploads/2019/03/ij-logo-social.jpg"
    },
    {
        title: "Life & Health Insurance News",
        author: "LifeHealthPro",
        description: "Professional publication covering life insurance, health insurance, employee benefits, and retirement planning.",
        category: "research",
        subcategory: "magazine",
        source: "LifeHealthPro",
        source_url: "https://www.lifehealthpro.com",
        language: "en",
        tags: ["finance", "life insurance", "health insurance", "benefits"],
        is_free: true,
        cover_url: "https://www.lifehealthpro.com/ext/resources/images/lhp-logo.png"
    },

    // 财富管理和私人银行
    {
        title: "Wealth Management",
        author: "InvestmentNews",
        description: "Professional magazine for financial advisors covering wealth management strategies, investment products, and advisory practice management.",
        category: "research",
        subcategory: "magazine",
        source: "InvestmentNews",
        source_url: "https://www.wealthmanagement.com",
        language: "en",
        tags: ["finance", "wealth management", "advisors", "investment"],
        is_free: true,
        cover_url: "https://www.wealthmanagement.com/sites/wealthmanagement.com/themes/wealthmanagement/logo.png"
    },
    {
        title: "Private Banker International",
        author: "Euromoney Institutional Investor",
        description: "Publication covering private banking, wealth management, and high net worth client services globally.",
        category: "research",
        subcategory: "magazine",
        source: "Euromoney",
        source_url: "https://www.privatebankerinternational.com",
        language: "en",
        tags: ["finance", "private banking", "wealth management", "HNW"],
        is_free: false,
        cover_url: "https://www.privatebankerinternational.com/logo.png"
    },

    // 金融科技专业媒体
    {
        title: "FinTech Futures",
        author: "FinTech Futures",
        description: "Digital publication covering fintech innovation, digital banking, payments technology, and financial services transformation.",
        category: "research",
        subcategory: "news",
        source: "FinTech Futures",
        source_url: "https://www.fintechfutures.com",
        language: "en",
        tags: ["finance", "fintech", "digital banking", "payments"],
        is_free: true,
        cover_url: "https://www.fintechfutures.com/files/2019/06/FinTech-Futures-logo.png"
    },
    {
        title: "PaymentsSource",
        author: "Arizent",
        description: "Professional publication covering payments industry news, technology trends, and regulatory developments.",
        category: "research",
        subcategory: "news",
        source: "PaymentsSource",
        source_url: "https://www.paymentssource.com",
        language: "en",
        tags: ["finance", "payments", "technology", "regulation"],
        is_free: true,
        cover_url: "https://www.paymentssource.com/images/paymentssource-logo.png"
    },
    {
        title: "The Fintech Times",
        author: "Fintech Times",
        description: "Global publication covering fintech startups, digital finance innovations, and financial technology trends worldwide.",
        category: "research",
        subcategory: "magazine",
        source: "Fintech Times",
        source_url: "https://thefintechtimes.com",
        language: "en",
        tags: ["finance", "fintech", "startups", "innovation"],
        is_free: true,
        cover_url: "https://thefintechtimes.com/wp-content/uploads/2019/07/TFT-logo.png"
    },

    // 更多中文财经专业媒体
    {
        title: "中国银行业",
        author: "中国银行业协会",
        description: "中国银行业协会主办的专业期刊，关注银行业发展、监管政策、风险管理和创新业务。",
        category: "research",
        subcategory: "magazine",
        source: "中国银行业协会",
        source_url: "http://www.china-cba.net",
        language: "zh",
        tags: ["finance", "chinese", "banking", "regulation"],
        is_free: false,
        cover_url: "http://www.china-cba.net/images/logo.png"
    },
    {
        title: "投资与理财",
        author: "投资与理财杂志社",
        description: "面向个人投资者的理财杂志，提供投资策略、理财规划、市场分析和财富管理建议。",
        category: "research",
        subcategory: "magazine",
        source: "投资与理财",
        source_url: "http://www.touzi.com",
        language: "zh",
        tags: ["finance", "chinese", "investment", "personal finance"],
        is_free: false,
        cover_url: "http://www.touzi.com/images/logo.png"
    },
    {
        title: "期货日报",
        author: "期货日报社",
        description: "中国期货市场权威报纸，专注于期货、期权、衍生品市场的新闻报道和分析。",
        category: "research",
        subcategory: "newspaper",
        source: "期货日报",
        source_url: "http://www.qhrb.com.cn",
        language: "zh",
        tags: ["finance", "chinese", "futures", "derivatives"],
        is_free: true,
        cover_url: "http://www.qhrb.com.cn/images/logo.png"
    },
    {
        title: "中国保险报",
        author: "中国保险报社",
        description: "中国保险业权威报纸，报道保险业政策、市场动态、产品创新和监管发展。",
        category: "research",
        subcategory: "newspaper",
        source: "中国保险报",
        source_url: "http://www.cib.cn",
        language: "zh",
        tags: ["finance", "chinese", "insurance", "regulation"],
        is_free: true,
        cover_url: "http://www.cib.cn/images/logo.png"
    },
    {
        title: "上海证券报",
        author: "上海证券报社",
        description: "中国权威证券类报纸，专注于股票市场、证券投资、上市公司和资本市场报道。",
        category: "research",
        subcategory: "newspaper",
        source: "上海证券报",
        source_url: "https://www.cnstock.com",
        language: "zh",
        tags: ["finance", "chinese", "securities", "capital markets"],
        is_free: true,
        cover_url: "https://www.cnstock.com/images/logo.png"
    },
    {
        title: "国际融资",
        author: "国际融资杂志社",
        description: "专业的国际金融期刊，关注跨境投资、国际融资、贸易金融和全球资本市场。",
        category: "research",
        subcategory: "magazine",
        source: "国际融资",
        source_url: "http://www.gjrz.com",
        language: "zh",
        tags: ["finance", "chinese", "international", "cross-border"],
        is_free: false,
        cover_url: "http://www.gjrz.com/images/logo.png"
    },

    // 商品和能源金融
    {
        title: "Energy Risk",
        author: "Infopro Digital",
        description: "Professional publication covering energy derivatives, commodity trading, risk management in energy markets.",
        category: "research",
        subcategory: "magazine",
        source: "Energy Risk",
        source_url: "https://www.risk.net/energy-risk",
        language: "en",
        tags: ["finance", "energy", "commodities", "risk management"],
        is_free: false,
        cover_url: "https://www.risk.net/sites/default/files/styles/rn_hero_image/public/2019-03/energy-risk-logo.png"
    },
    {
        title: "Commodity Trading Magazine",
        author: "Commodity Trading Week",
        description: "Professional magazine covering commodity trading, agricultural finance, metals markets, and energy trading.",
        category: "research",
        subcategory: "magazine",
        source: "CTW",
        source_url: "https://www.commoditytrading.net",
        language: "en",
        tags: ["finance", "commodities", "trading", "agriculture"],
        is_free: false,
        cover_url: "https://www.commoditytrading.net/images/ctw-logo.png"
    },

    // ESG和可持续投资更多资源
    {
        title: "ESG Investing",
        author: "Institutional Investor",
        description: "Professional publication covering ESG investing strategies, sustainable finance, impact investing, and responsible investment practices.",
        category: "research",
        subcategory: "magazine",
        source: "Institutional Investor",
        source_url: "https://www.institutionalinvestor.com/section/esg-investing",
        language: "en",
        tags: ["finance", "ESG", "sustainable", "impact investing"],
        is_free: false,
        cover_url: "https://www.institutionalinvestor.com/images/ii-logo.png"
    },
    {
        title: "Responsible Investor",
        author: "Responsible Investor",
        description: "Global publication covering responsible investment, ESG integration, sustainable finance, and impact measurement.",
        category: "research",
        subcategory: "news",
        source: "Responsible Investor",
        source_url: "https://www.responsible-investor.com",
        language: "en",
        tags: ["finance", "responsible investing", "ESG", "sustainable"],
        is_free: true,
        cover_url: "https://www.responsible-investor.com/images/ri-logo.png"
    },

    // 退休和养老金行业
    {
        title: "Pensions & Investments",
        author: "Crain Communications",
        description: "Professional newspaper covering institutional investing, pension fund management, and retirement plan administration.",
        category: "research",
        subcategory: "newspaper",
        source: "Crain Communications",
        source_url: "https://www.pionline.com",
        language: "en",
        tags: ["finance", "pensions", "institutional", "retirement"],
        is_free: false,
        cover_url: "https://www.pionline.com/s3fs-public/styles/width_500/public/pi-logo-2019.png"
    },
    {
        title: "Benefits Quarterly",
        author: "International Society of Certified Employee Benefit Specialists",
        description: "Academic journal covering employee benefits, retirement planning, healthcare finance, and compensation strategy.",
        category: "research",
        subcategory: "journal",
        source: "ISCEBS",
        source_url: "https://www.iscebs.org/Resources/BQ",
        language: "en",
        tags: ["finance", "benefits", "retirement", "compensation"],
        is_free: false,
        cover_url: "https://www.iscebs.org/images/iscebs-logo.png"
    },

    // 金融监管和合规更多资源
    {
        title: "Risk Magazine",
        author: "Infopro Digital",
        description: "Leading publication covering financial risk management, derivatives, quantitative analysis, and regulatory developments.",
        category: "research",
        subcategory: "magazine",
        source: "Risk Magazine",
        source_url: "https://www.risk.net",
        language: "en",
        tags: ["finance", "risk management", "derivatives", "regulation"],
        is_free: false,
        cover_url: "https://www.risk.net/sites/default/files/styles/rn_hero_image/public/2019-03/risk-logo.png"
    },
    {
        title: "Compliance Week",
        author: "Compliance Week",
        description: "Professional publication covering corporate compliance, regulatory requirements, and governance issues in financial services.",
        category: "research",
        subcategory: "magazine",
        source: "Compliance Week",
        source_url: "https://www.complianceweek.com",
        language: "en",
        tags: ["finance", "compliance", "governance", "regulation"],
        is_free: false,
        cover_url: "https://www.complianceweek.com/images/cw-logo.png"
    },

    // 税务和会计期刊（与金融相关）
    {
        title: "Tax Notes",
        author: "Tax Analysts",
        description: "Professional publication covering tax policy, international tax, corporate taxation, and tax planning strategies.",
        category: "research",
        subcategory: "magazine",
        source: "Tax Analysts",
        source_url: "https://www.taxnotes.com",
        language: "en",
        tags: ["finance", "taxation", "policy", "corporate"],
        is_free: false,
        cover_url: "https://www.taxnotes.com/images/taxnotes-logo.png"
    },
    {
        title: "Journal of Accountancy",
        author: "American Institute of CPAs",
        description: "Professional magazine covering accounting practices, financial reporting, auditing, and business advisory services.",
        category: "research",
        subcategory: "magazine",
        source: "AICPA",
        source_url: "https://www.journalofaccountancy.com",
        language: "en",
        tags: ["finance", "accounting", "auditing", "reporting"],
        is_free: true,
        cover_url: "https://www.aicpa.org/content/dam/aicpa/logo/aicpa-logo.svg"
    },

    // 新兴市场金融
    {
        title: "Emerging Markets Review",
        author: "Elsevier",
        description: "Academic journal covering financial markets, economic development, and investment in emerging market economies.",
        category: "research",
        subcategory: "journal",
        source: "Elsevier",
        source_url: "https://www.journals.elsevier.com/emerging-markets-review",
        language: "en",
        tags: ["finance", "emerging markets", "development", "investment"],
        is_free: false,
        cover_url: "https://ars.els-cdn.com/content/image/1-s2.0-S1566014118X-cov-150h.gif"
    },
    {
        title: "EMEA Finance",
        author: "EMEA Finance",
        description: "Publication covering financial markets, banking, and capital markets in Europe, Middle East, and Africa.",
        category: "research",
        subcategory: "magazine",
        source: "EMEA Finance",
        source_url: "https://www.emeafinance.com",
        language: "en",
        tags: ["finance", "EMEA", "banking", "capital markets"],
        is_free: false,
        cover_url: "https://www.emeafinance.com/images/emea-logo.png"
    },

    // 数字资产和DeFi专业媒体（更多）
    {
        title: "DeFi Pulse",
        author: "DeFi Pulse",
        description: "Analytics and news platform covering decentralized finance (DeFi) protocols, yields, and total value locked metrics.",
        category: "research",
        subcategory: "news",
        source: "DeFi Pulse",
        source_url: "https://www.defipulse.com",
        language: "en",
        tags: ["finance", "DeFi", "cryptocurrency", "analytics"],
        is_free: true,
        cover_url: "https://defipulse.com/img/defipulse-logo.svg"
    },
    {
        title: "DeFi Prime",
        author: "DeFi Prime",
        description: "Curated list and analysis of decentralized finance products, protocols, and services in the cryptocurrency ecosystem.",
        category: "research",
        subcategory: "news",
        source: "DeFi Prime",
        source_url: "https://defiprime.com",
        language: "en",
        tags: ["finance", "DeFi", "protocols", "cryptocurrency"],
        is_free: true,
        cover_url: "https://defiprime.com/images/defi-prime-logo.png"
    },
    {
        title: "NFT Evening",
        author: "NFT Evening",
        description: "News and analysis platform covering NFT markets, digital collectibles, and blockchain-based art and gaming.",
        category: "research",
        subcategory: "news",
        source: "NFT Evening",
        source_url: "https://nftevening.com",
        language: "en",
        tags: ["finance", "NFT", "digital assets", "blockchain"],
        is_free: true,
        cover_url: "https://nftevening.com/wp-content/uploads/2021/08/nft-evening-logo.png"
    },

    // 投资银行和并购专业媒体
    {
        title: "Investment Banking News",
        author: "FinanceTracker",
        description: "Professional publication covering investment banking deals, M&A transactions, capital markets, and financial advisory services.",
        category: "research",
        subcategory: "news",
        source: "FinanceTracker",
        source_url: "https://www.investmentbankingnews.com",
        language: "en",
        tags: ["finance", "investment banking", "M&A", "capital markets"],
        is_free: true,
        cover_url: "https://www.investmentbankingnews.com/images/ibn-logo.png"
    },
    {
        title: "Mergers & Acquisitions",
        author: "SourceMedia",
        description: "Professional magazine covering M&A transactions, deal-making strategies, valuation, and corporate development.",
        category: "research",
        subcategory: "magazine",
        source: "SourceMedia",
        source_url: "https://www.themiddlemarket.com",
        language: "en",
        tags: ["finance", "M&A", "deals", "valuation"],
        is_free: false,
        cover_url: "https://www.sourcemedia.com/images/sm-logo.png"
    },

    // 学术研究机构期刊
    {
        title: "Wharton Finance Papers",
        author: "University of Pennsylvania",
        description: "Academic research papers from the Wharton School covering corporate finance, investments, and financial markets.",
        category: "research",
        subcategory: "research_paper",
        source: "Wharton School",
        source_url: "https://finance.wharton.upenn.edu/research/",
        language: "en",
        tags: ["finance", "academic", "Wharton", "research"],
        is_free: true,
        cover_url: "https://finance.wharton.upenn.edu/wp-content/uploads/2019/03/wharton-logo.png"
    },
    {
        title: "Chicago Booth Research",
        author: "University of Chicago",
        description: "Academic research from Chicago Booth School of Business covering financial economics, behavioral finance, and market microstructure.",
        category: "research",
        subcategory: "research_paper",
        source: "Chicago Booth",
        source_url: "https://www.chicagobooth.edu/research",
        language: "en",
        tags: ["finance", "academic", "Chicago Booth", "behavioral"],
        is_free: true,
        cover_url: "https://www.chicagobooth.edu/-/media/booth/logos/booth-logo.svg"
    },
    {
        title: "MIT Sloan Finance Papers",
        author: "MIT Sloan School",
        description: "Academic research papers from MIT Sloan covering financial innovation, corporate finance, and market efficiency.",
        category: "research",
        subcategory: "research_paper",
        source: "MIT Sloan",
        source_url: "https://mitsloan.mit.edu/faculty/research",
        language: "en",
        tags: ["finance", "academic", "MIT", "innovation"],
        is_free: true,
        cover_url: "https://mitsloan.mit.edu/sites/default/files/2021-06/mit-sloan-logo-black.svg"
    },

    // 个人理财和投资教育
    {
        title: "Bogleheads",
        author: "Bogleheads Community",
        description: "Community-driven investment education platform following John Bogle's investment philosophy of low-cost index investing.",
        category: "research",
        subcategory: "education",
        source: "Bogleheads",
        source_url: "https://www.bogleheads.org",
        language: "en",
        tags: ["finance", "education", "index investing", "community"],
        is_free: true,
        cover_url: "https://www.bogleheads.org/images/bogleheads-logo.png"
    },
    {
        title: "Khan Academy Finance",
        author: "Khan Academy",
        description: "Free online finance education covering personal finance, investing basics, financial markets, and economic concepts.",
        category: "research",
        subcategory: "education",
        source: "Khan Academy",
        source_url: "https://www.khanacademy.org/economics-finance-domain",
        language: "en",
        tags: ["finance", "education", "free", "basics"],
        is_free: true,
        cover_url: "https://cdn.kastatic.org/images/khan-logo-vertical-transparent.png"
    },
    {
        title: "Coursera Finance Courses",
        author: "Coursera",
        description: "Online finance courses from top universities covering corporate finance, investment management, and financial analysis.",
        category: "research",
        subcategory: "education",
        source: "Coursera",
        source_url: "https://www.coursera.org/browse/business/finance",
        language: "en",
        tags: ["finance", "education", "online courses", "university"],
        is_free: false,
        cover_url: "https://about.coursera.org/press/wp-content/uploads/2017/02/coursera-logo-square.png"
    }
];

// 分批插入函数
async function insertInBatches(items, batchSize = 10) {
    let totalInserted = 0;
    const totalItems = items.length;
    
    console.log(`开始插入 ${totalItems} 条最终批次记录到 Supabase...`);
    
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
    
    console.log(`\n📊 最终批次插入完成! 总共尝试插入 ${totalItems} 条记录，成功插入 ${totalInserted} 条记录`);
    return totalInserted;
}

// 主函数
async function main() {
    console.log('🚀 开始插入最终批次的金融资源...\n');
    
    // 插入数据
    const totalInserted = await insertInBatches(finalFinancialBatch);
    
    // 保存到本地文件用于备份
    const backupFile = `/Users/adelinewen/ranking-arena/final_financial_batch_backup_${Date.now()}.json`;
    fs.writeFileSync(backupFile, JSON.stringify(finalFinancialBatch, null, 2));
    console.log(`\n💾 最终批次数据已备份到: ${backupFile}`);
    
    // 输出摘要
    console.log('\n📈 最终批次收集摘要:');
    console.log(`- 英文出版物: ${finalFinancialBatch.filter(p => p.language === 'en').length} 个`);
    console.log(`- 中文出版物: ${finalFinancialBatch.filter(p => p.language === 'zh').length} 个`);
    console.log(`- 学术期刊: ${finalFinancialBatch.filter(p => p.subcategory === 'journal').length} 个`);
    console.log(`- 专业杂志: ${finalFinancialBatch.filter(p => p.subcategory === 'magazine').length} 个`);
    console.log(`- 新闻媒体: ${finalFinancialBatch.filter(p => p.subcategory === 'news').length} 个`);
    console.log(`- 教育资源: ${finalFinancialBatch.filter(p => p.subcategory === 'education').length} 个`);
    console.log(`- 研究论文: ${finalFinancialBatch.filter(p => p.subcategory === 'research_paper').length} 个`);
    console.log(`- 免费资源: ${finalFinancialBatch.filter(p => p.is_free).length} 个`);
    console.log(`- 付费资源: ${finalFinancialBatch.filter(p => !p.is_free).length} 个`);
    console.log(`\n✅ 最终批次任务完成! 新增收集了 ${finalFinancialBatch.length} 个金融资源记录`);
}

// 运行主函数
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { finalFinancialBatch, insertToSupabase, insertInBatches };