#!/usr/bin/env node
/**
 * Arena Worker CLI
 * 命令行工具，用于手动触发数据抓取
 */
import 'dotenv/config';
import { logger } from './logger.js';
import { getScraperForSource, getAvailableSources } from './scrapers/index.js';
import { saveTraders, logScrapeResult } from './db.js';
const TIME_RANGES = ['7D', '30D', '90D'];
async function scrapeSource(source, timeRanges) {
    const scraper = getScraperForSource(source);
    if (!scraper) {
        logger.error('Unknown source', new Error(`No scraper for source: ${source}`), { source });
        return;
    }
    for (const timeRange of timeRanges) {
        logger.info('Starting scrape job', { source, timeRange });
        const result = await scraper.scrape(timeRange);
        if (result.success && result.traders.length > 0) {
            // 保存到数据库
            const { saved, errors } = await saveTraders(result.traders, source, timeRange);
            logger.info('Scrape job completed', {
                source,
                timeRange,
                tradersScraped: result.traders.length,
                saved,
                errors,
                duration: result.duration,
            });
            // 记录日志
            await logScrapeResult(source, timeRange, true, {
                tradersCount: result.traders.length,
                duration: result.duration,
            });
        }
        else {
            logger.error('Scrape job failed', new Error(result.error || 'Unknown error'), {
                source,
                timeRange,
                duration: result.duration,
            });
            await logScrapeResult(source, timeRange, false, {
                tradersCount: 0,
                duration: result.duration,
                error: result.error,
            });
        }
    }
}
async function scrapeAll() {
    const sources = getAvailableSources();
    logger.info('Starting full scrape', { sources, timeRanges: TIME_RANGES });
    for (const source of sources) {
        await scrapeSource(source, TIME_RANGES);
    }
    logger.info('Full scrape completed');
}
function printUsage() {
    console.log(`
Arena Worker CLI

Usage:
  tsx src/cli.ts scrape --all                     Scrape all sources and time ranges
  tsx src/cli.ts scrape --source <source>         Scrape specific source (all time ranges)
  tsx src/cli.ts scrape --source <source> --time <range>  Scrape specific source and time range

Available sources: ${getAvailableSources().join(', ')}
Time ranges: 7D, 30D, 90D

Examples:
  tsx src/cli.ts scrape --all
  tsx src/cli.ts scrape --source binance_spot
  tsx src/cli.ts scrape --source binance_spot --time 90D
`);
}
async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        printUsage();
        process.exit(0);
    }
    const command = args[0];
    if (command === 'scrape') {
        const allFlag = args.includes('--all');
        const sourceIndex = args.indexOf('--source');
        const timeIndex = args.indexOf('--time');
        if (allFlag) {
            await scrapeAll();
        }
        else if (sourceIndex !== -1 && args[sourceIndex + 1]) {
            const source = args[sourceIndex + 1];
            const timeRanges = timeIndex !== -1 && args[timeIndex + 1]
                ? [args[timeIndex + 1]]
                : TIME_RANGES;
            await scrapeSource(source, timeRanges);
        }
        else {
            console.error('Error: Please specify --all or --source <source>');
            printUsage();
            process.exit(1);
        }
    }
    else {
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
}
main().catch((error) => {
    logger.error('CLI error', error);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map