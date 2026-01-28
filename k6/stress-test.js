/**
 * 压力测试 (Stress Test) - Vercel Pro 优化版
 *
 * 场景: 用户数快速飙升到 100（Grafana Cloud 免费版限制）
 * 商业意义: 模拟行情暴涨或推特大 V 转发后的"瞬间流量"，看系统是否会雪崩
 *
 * Vercel Pro 优势:
 * - Serverless 函数超时: 60 秒（免费版 10 秒）
 * - 更高的并发连接数
 * - Edge Functions 优先级更高
 * - 更好的冷启动性能
 *
 * 运行: k6 run k6/stress-test.js
 * 云端: k6 cloud k6/stress-test.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// 自定义指标
const errorRate = new Rate('errors');
const responseTime = new Trend('response_time');
const requestCount = new Counter('total_requests');
const failedRequests = new Counter('failed_requests');

// API 响应时间细分
const homepageTime = new Trend('homepage_time');
const apiTime = new Trend('api_time');
const searchTime = new Trend('search_time');

export const options = {
  stages: [
    // 阶段 1: 预热 - 让 Serverless 函数热起来
    { duration: '20s', target: 10 },   // 20 秒爬升到 10 用户（预热）
    { duration: '30s', target: 10 },   // 保持 30 秒让函数热起来

    // 阶段 2: 正常负载
    { duration: '30s', target: 30 },   // 爬升到 30 用户
    { duration: '1m', target: 30 },    // 保持 1 分钟

    // 阶段 3: 高负载 - 模拟大 V 转发
    { duration: '30s', target: 60 },   // 30 秒内飙升到 60
    { duration: '1m', target: 60 },    // 保持 1 分钟

    // 阶段 4: 极限压力 - 模拟热搜/暴涨行情
    { duration: '30s', target: 100 },  // 30 秒内飙升到 100 (Cloud 最大值)
    { duration: '2m', target: 100 },   // 保持 2 分钟，观察系统稳定性

    // 阶段 5: 流量回落（测试恢复能力）
    { duration: '20s', target: 50 },   // 快速降到 50
    { duration: '20s', target: 20 },   // 降到 20
    { duration: '20s', target: 0 },    // 降到 0
  ],

  thresholds: {
    // Vercel Pro 应该有更好的性能，阈值更严格
    http_req_duration: ['p(95)<3000', 'p(99)<5000'],  // P95 < 3s, P99 < 5s
    http_req_failed: ['rate<0.10'],     // 错误率 < 10%
    errors: ['rate<0.10'],              // 自定义错误率 < 10%
    homepage_time: ['p(95)<2000'],      // 首页 P95 < 2s
    api_time: ['p(95)<2500'],           // API P95 < 2.5s
    search_time: ['p(95)<2000'],        // 搜索 P95 < 2s
  },

  // HTTP/2 连接复用，提高效率
  batch: 10,
  batchPerHost: 10,

  // 优雅停止
  gracefulRampDown: '30s',
  gracefulStop: '30s',

  cloud: {
    name: 'Ranking Arena - Stress Test (Vercel Pro)',
  },
};

const BASE_URL = 'https://ranking-arena.vercel.app';

// 请求配置 - Vercel Pro 支持更长超时
const params = {
  timeout: '30s',  // 30 秒超时（Pro 支持 60s）
  tags: { type: 'stress' },
};

// 高频访问场景 - 模拟行情暴涨时用户疯狂刷新
export default function () {
  const scenarios = [
    // 50% 用户疯狂刷新首页
    { weight: 50, fn: refreshHomepage },
    // 25% 用户查看排行榜 API
    { weight: 25, fn: checkRankings },
    // 15% 用户搜索
    { weight: 15, fn: searchTraders },
    // 10% 用户访问详情页
    { weight: 10, fn: viewTraderDetail },
  ];

  // 根据权重随机选择场景
  const rand = Math.random() * 100;
  let cumulative = 0;
  for (const scenario of scenarios) {
    cumulative += scenario.weight;
    if (rand < cumulative) {
      scenario.fn();
      break;
    }
  }

  // 模拟用户思考时间（稍长一点，更真实）
  sleep(Math.random() * 1 + 0.3); // 0.3-1.3 秒
}

function refreshHomepage() {
  const res = http.get(`${BASE_URL}/`, {
    ...params,
    tags: { name: 'Homepage', type: 'page' },
  });

  homepageTime.add(res.timings.duration);
  responseTime.add(res.timings.duration);
  requestCount.add(1);

  const success = check(res, {
    '首页状态正常': (r) => r.status === 200,
    '首页响应快': (r) => r.timings.duration < 3000,
  });

  if (!success) {
    failedRequests.add(1);
  }
  errorRate.add(!success);
}

function checkRankings() {
  const sources = ['binance_futures', 'bybit', 'bitget_futures', 'okx_futures', 'mexc'];
  const source = sources[Math.floor(Math.random() * sources.length)];

  const res = http.get(`${BASE_URL}/api/traders?source=${source}&limit=20`, {
    ...params,
    tags: { name: 'Rankings API', type: 'api', source: source },
  });

  apiTime.add(res.timings.duration);
  responseTime.add(res.timings.duration);
  requestCount.add(1);

  const success = check(res, {
    'API 状态正常': (r) => r.status === 200,
    'API 返回 JSON': (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body) || (body && typeof body === 'object');
      } catch {
        return false;
      }
    },
    'API 响应快': (r) => r.timings.duration < 3000,
  });

  if (!success) {
    failedRequests.add(1);
  }
  errorRate.add(!success);
}

function searchTraders() {
  const terms = ['btc', 'eth', 'sol', 'doge', 'bnb', 'xrp', 'pepe', 'shib'];
  const term = terms[Math.floor(Math.random() * terms.length)];

  const res = http.get(`${BASE_URL}/api/search?q=${term}&limit=10`, {
    ...params,
    tags: { name: 'Search API', type: 'api' },
  });

  searchTime.add(res.timings.duration);
  responseTime.add(res.timings.duration);
  requestCount.add(1);

  const success = check(res, {
    '搜索状态正常': (r) => r.status === 200 || r.status === 404,
    '搜索响应快': (r) => r.timings.duration < 2500,
  });

  if (!success) {
    failedRequests.add(1);
  }
  errorRate.add(!success);
}

function viewTraderDetail() {
  // 使用一些真实的交易员 handle
  const handles = ['test', 'demo', 'trader1'];
  const handle = handles[Math.floor(Math.random() * handles.length)];

  const res = http.get(`${BASE_URL}/trader/${handle}`, {
    ...params,
    tags: { name: 'Trader Detail', type: 'page' },
  });

  responseTime.add(res.timings.duration);
  requestCount.add(1);

  const success = check(res, {
    '详情页可访问': (r) => r.status === 200 || r.status === 404,
    '详情页响应快': (r) => r.timings.duration < 3000,
  });

  if (!success) {
    failedRequests.add(1);
  }
  errorRate.add(!success);
}

// 测试结束汇总
export function handleSummary(data) {
  const metrics = data.metrics;

  console.log('\n' + '='.repeat(70));
  console.log('  RANKING ARENA - STRESS TEST RESULTS (Vercel Pro)');
  console.log('='.repeat(70));

  console.log(`\n  Peak VUs: 100 (Grafana Cloud Limit)`);
  console.log(`  Total Requests: ${metrics.total_requests?.values?.count || 0}`);
  console.log(`  Failed Requests: ${metrics.failed_requests?.values?.count || 0}`);

  console.log('\n  Response Times:');
  console.log(`    Average: ${Math.round(metrics.response_time?.values?.avg || 0)}ms`);
  console.log(`    P95: ${Math.round(metrics.response_time?.values?.['p(95)'] || 0)}ms`);
  console.log(`    P99: ${Math.round(metrics.response_time?.values?.['p(99)'] || 0)}ms`);
  console.log(`    Max: ${Math.round(metrics.response_time?.values?.max || 0)}ms`);

  console.log('\n  By Endpoint:');
  console.log(`    Homepage P95: ${Math.round(metrics.homepage_time?.values?.['p(95)'] || 0)}ms`);
  console.log(`    API P95: ${Math.round(metrics.api_time?.values?.['p(95)'] || 0)}ms`);
  console.log(`    Search P95: ${Math.round(metrics.search_time?.values?.['p(95)'] || 0)}ms`);

  console.log(`\n  Error Rate: ${((metrics.errors?.values?.rate || 0) * 100).toFixed(2)}%`);

  // 判断是否通过
  const errorRateValue = metrics.errors?.values?.rate || 0;
  const p95 = metrics.response_time?.values?.['p(95)'] || 0;
  const p99 = metrics.response_time?.values?.['p(99)'] || 0;

  console.log('\n' + '-'.repeat(70));

  if (errorRateValue < 0.05 && p95 < 2000) {
    console.log('  EXCELLENT! System handles stress perfectly.');
    console.log('  Vercel Pro is performing as expected.');
  } else if (errorRateValue < 0.10 && p95 < 3000) {
    console.log('  GOOD. System is stable under stress.');
    console.log('  Minor optimizations could improve P95 further.');
  } else if (errorRateValue < 0.20 && p99 < 5000) {
    console.log('  WARNING. System shows degradation under peak load.');
    console.log('  Consider: Redis caching / Edge Functions / Rate limiting');
  } else {
    console.log('  CRITICAL. System struggles under stress.');
    console.log('  Immediate action needed:');
    console.log('    - Add Redis caching for /api/traders');
    console.log('    - Implement rate limiting');
    console.log('    - Consider Edge Functions for static content');
    console.log('    - Check Supabase connection pooling');
  }

  console.log('='.repeat(70) + '\n');

  return {
    stdout: '',
  };
}
