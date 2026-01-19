/**
 * Binance Futures Copy Trading 爬虫
 * 重构自 scripts/import_binance_futures.mjs
 */
import { BaseScraper, parseTraderFromApi } from './base.js';
const PERIOD_CONFIG = {
    '7D': { tabTexts: ['7天', '7 Days', '7D'], sortText: '收益率' },
    '30D': { tabTexts: ['30天', '30 Days', '30D'], sortText: '收益率' },
    '90D': { tabTexts: ['90天', '90 Days', '90D'], sortText: '收益率' },
};
export class BinanceFuturesScraper extends BaseScraper {
    baseUrl = 'https://www.binance.com/zh-CN/copy-trading';
    targetCount = 100;
    perPage = 18;
    apiResponses = [];
    constructor() {
        super('binance');
    }
    async scrapeData(timeRange) {
        const config = PERIOD_CONFIG[timeRange];
        const traders = new Map();
        const maxPages = Math.ceil(this.targetCount / this.perPage) + 1;
        this.log.info('Starting Binance Futures scrape', {
            timeRange,
            targetCount: this.targetCount,
            maxPages,
        });
        // 设置 API 响应拦截器
        this.page.on('response', (response) => this.handleApiResponse(response));
        // 访问页面
        try {
            await this.navigateWithRetry(this.baseUrl);
        }
        catch (error) {
            this.log.warn('Initial page load timeout, continuing', {
                error: error instanceof Error ? error.message : String(error),
            });
        }
        await this.wait(5000);
        // 点击收益率排序
        this.log.info('Clicking ROI sort');
        await this.clickSortByRoi(config.sortText);
        await this.wait(2000);
        // 切换时间周期
        this.log.info('Switching time period', { timeRange });
        await this.switchTimePeriod(config.tabTexts, timeRange);
        // 分页获取数据
        for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
            this.log.debug('Processing page', { pageNum });
            await this.wait(2000);
            await this.page.evaluate(() => window.scrollBy(0, 500));
            await this.wait(1000);
            // 处理 API 响应
            const recentResponses = this.apiResponses.filter(r => r.timestamp > Date.now() - 10000);
            for (const { list } of recentResponses) {
                list.forEach((item, idx) => {
                    const trader = parseTraderFromApi(item, traders.size + idx + 1);
                    if (trader && trader.traderId && !traders.has(trader.traderId)) {
                        traders.set(trader.traderId, trader);
                    }
                });
            }
            this.log.debug('Current traders count', { count: traders.size });
            if (traders.size >= this.targetCount) {
                this.log.info('Target count reached', { count: traders.size });
                break;
            }
            // 翻页
            if (pageNum < maxPages) {
                const clicked = await this.clickNextPage(pageNum + 1);
                if (clicked) {
                    await this.wait(3000);
                }
            }
        }
        // 如果 API 拦截数据不够，尝试从 DOM 提取
        if (traders.size < this.targetCount) {
            this.log.info('Insufficient data from API, extracting from DOM');
            const domTraders = await this.extractFromDom();
            for (const t of domTraders) {
                if (!traders.has(t.traderId)) {
                    traders.set(t.traderId, t);
                }
            }
        }
        // 排序并返回
        const result = Array.from(traders.values())
            .sort((a, b) => (b.roi || 0) - (a.roi || 0))
            .slice(0, this.targetCount)
            .map((t, idx) => ({ ...t, rank: idx + 1 }));
        // 数据质量检查
        const topRoi = result[0]?.roi || 0;
        if (topRoi < 500) {
            this.log.warn('Data quality warning: Top ROI seems low', { topRoi });
        }
        return result;
    }
    async handleApiResponse(response) {
        const url = response.url();
        if (url.includes('copy-trade') &&
            (url.includes('query-list') ||
                url.includes('list') ||
                url.includes('home-page') ||
                url.includes('rank'))) {
            try {
                const json = await response.json();
                if (json.data && (json.code === '000000' || json.success !== false)) {
                    const list = json.data?.list || json.data?.data || (Array.isArray(json.data) ? json.data : []);
                    if (Array.isArray(list) && list.length > 0) {
                        this.log.debug('Intercepted API response', { count: list.length });
                        this.apiResponses.push({ url, list, timestamp: Date.now() });
                    }
                }
            }
            catch {
                // Ignore JSON parse errors
            }
        }
    }
    async clickSortByRoi(sortText) {
        const clicked = await this.page.evaluate((text) => {
            const elements = document.querySelectorAll('span, div, button, th');
            for (const el of elements) {
                const elText = el.textContent?.trim();
                if (elText === text || elText?.includes(text)) {
                    const rect = el.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0 && rect.top < 500) {
                        ;
                        el.click();
                        return true;
                    }
                }
            }
            return false;
        }, sortText);
        if (clicked) {
            this.log.debug('Sort by ROI clicked successfully');
        }
        return clicked;
    }
    async switchTimePeriod(tabTexts, timeRange) {
        await this.page.evaluate(() => window.scrollTo(0, 0));
        await this.wait(1000);
        // 尝试通过下拉菜单切换
        const selectTrigger = this.page.locator('[class*="bn-select"]:has-text("天")').first();
        if ((await selectTrigger.count()) > 0) {
            this.log.debug('Found time dropdown, clicking');
            await selectTrigger.click();
            await this.wait(1000);
            for (const tabText of tabTexts) {
                const option = this.page.locator(`[class*="bn-select-option"]:has-text("${tabText}")`).first();
                if ((await option.count()) > 0) {
                    await option.click();
                    this.log.info('Time period switched', { period: tabText });
                    await this.wait(3000);
                    this.apiResponses = []; // 清空旧数据
                    return true;
                }
            }
        }
        // 备用方案：直接点击文本
        for (const tabText of tabTexts) {
            const elements = await this.page.locator(`text=${tabText}`).all();
            for (const el of elements) {
                try {
                    const box = await el.boundingBox();
                    if (box && box.y < 600 && box.y > 100) {
                        await el.click();
                        this.log.info('Time period switched (fallback)', { period: tabText });
                        await this.wait(3000);
                        this.apiResponses = [];
                        return true;
                    }
                }
                catch {
                    // Ignore click errors
                }
            }
        }
        this.log.warn('Failed to switch time period, using default', { timeRange });
        return false;
    }
    async clickNextPage(targetPage) {
        await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await this.wait(1000);
        const clicked = await this.page.evaluate((pageNum) => {
            // 尝试在分页容器中找页码按钮
            const paginationContainers = document.querySelectorAll('[class*="pagination"], [class*="Pagination"], [class*="page-nav"], nav');
            for (const container of paginationContainers) {
                const buttons = container.querySelectorAll('button, a, span, li');
                for (const btn of buttons) {
                    const text = btn.textContent?.trim();
                    if (text === String(pageNum)) {
                        ;
                        btn.click();
                        return true;
                    }
                }
            }
            // 备用：全局搜索页码
            const allElements = document.querySelectorAll('button, a, span, li');
            for (const el of allElements) {
                const text = el.textContent?.trim();
                const elem = el;
                if (text === String(pageNum) && elem.offsetParent !== null) {
                    const rect = el.getBoundingClientRect();
                    if (rect.top > window.innerHeight * 0.5) {
                        elem.click();
                        return true;
                    }
                }
            }
            // 最后尝试：点击 "下一页" 按钮
            const nextBtns = document.querySelectorAll('[class*="next"], [aria-label*="next"], [aria-label*="Next"]');
            for (const btn of nextBtns) {
                const elem = btn;
                if (elem.offsetParent !== null) {
                    elem.click();
                    return true;
                }
            }
            return false;
        }, targetPage);
        if (clicked) {
            this.log.debug('Page navigation successful', { targetPage });
        }
        else {
            this.log.warn('Page navigation failed', { targetPage });
        }
        return clicked;
    }
    async extractFromDom() {
        const pageTraders = await this.page.evaluate(() => {
            const results = [];
            const seen = new Set();
            const cards = document.querySelectorAll('[class*="trader"], [class*="card"], [class*="item"], tr');
            cards.forEach((card) => {
                const text = card.innerText || '';
                const link = card.querySelector('a[href*="portfolio"], a[href*="lead"], a[href*="trader"]');
                const href = link?.getAttribute('href') || '';
                const idMatch = href.match(/portfolioId=(\d+)/) ||
                    href.match(/encryptedUid=([A-Za-z0-9]+)/) ||
                    href.match(/\/(\d{10,})/);
                const traderId = idMatch?.[1];
                if (!traderId || seen.has(traderId))
                    return;
                seen.add(traderId);
                const roiMatches = text.match(/([+-]?\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*%/g);
                let roi = null;
                if (roiMatches) {
                    for (const match of roiMatches) {
                        const val = parseFloat(match.replace(/[^0-9.+-]/g, ''));
                        if (val > 0 && (roi === null || val > roi)) {
                            roi = val;
                        }
                    }
                }
                let nickname = null;
                const nameEl = card.querySelector('[class*="name"], [class*="nick"]');
                if (nameEl) {
                    nickname = nameEl.innerText?.trim()?.split('\n')[0] || null;
                }
                if (traderId && roi !== null && roi > 0) {
                    results.push({
                        traderId,
                        nickname,
                        avatar: null,
                        roi,
                        pnl: 0,
                        winRate: null,
                        maxDrawdown: null,
                        followers: 0,
                        aum: null,
                        tradesCount: null,
                        rank: results.length + 1,
                    });
                }
            });
            return results;
        });
        this.log.info('Extracted from DOM', { count: pageTraders.length });
        return pageTraders;
    }
}
//# sourceMappingURL=binance-futures.js.map