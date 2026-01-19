/**
 * 爬虫基础类
 * 提供通用的浏览器自动化和错误处理
 * 支持代理池轮换
 */
import { Browser, BrowserContext, Page } from 'playwright';
import { logger } from '../logger.js';
import type { TraderData, DataSource, TimeRange, ScrapeResult, ScraperOptions } from '../types.js';
/**
 * 代理配置
 */
interface ProxyConfig {
    server: string;
    username?: string;
    password?: string;
}
/**
 * 获取代理池状态
 */
export declare function getProxyPoolStats(): {
    total: number;
    failed: number;
    available: number;
};
export declare abstract class BaseScraper {
    protected source: DataSource;
    protected options: Required<ScraperOptions>;
    protected browser: Browser | null;
    protected context: BrowserContext | null;
    protected page: Page | null;
    protected log: ReturnType<typeof logger.withContext>;
    protected currentProxy: ProxyConfig | null;
    constructor(source: DataSource, options?: ScraperOptions);
    /**
     * 获取下一个代理
     */
    protected getNextProxy(): ProxyConfig | null;
    /**
     * 标记当前代理为失败
     */
    protected markCurrentProxyFailed(): void;
    /**
     * 初始化浏览器
     */
    protected initBrowser(): Promise<void>;
    /**
     * 关闭浏览器
     */
    protected closeBrowser(): Promise<void>;
    /**
     * 安全等待
     */
    protected wait(ms: number): Promise<void>;
    /**
     * 安全点击元素
     */
    protected safeClick(selector: string, description: string): Promise<boolean>;
    /**
     * 带重试的页面导航
     */
    protected navigateWithRetry(url: string): Promise<void>;
    /**
     * 截图保存（用于调试）
     */
    protected takeScreenshot(name: string): Promise<string | null>;
    /**
     * 抽象方法：执行实际的数据抓取
     */
    protected abstract scrapeData(timeRange: TimeRange): Promise<TraderData[]>;
    /**
     * 添加随机延迟（降低被检测风险）
     */
    protected randomDelay(minMs?: number, maxMs?: number): Promise<void>;
    /**
     * 执行抓取（带完整的生命周期管理）
     * 支持代理失败重试
     */
    scrape(timeRange: TimeRange): Promise<ScrapeResult>;
}
/**
 * 从 API 响应中解析交易员数据的通用函数
 */
export declare function parseTraderFromApi(item: Record<string, unknown>, rank: number): TraderData | null;
export {};
//# sourceMappingURL=base.d.ts.map