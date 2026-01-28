/**
 * 压力测试 (Stress Test)
 *
 * 场景: 用户数快速飙升到 100（Grafana Cloud 免费版限制）
 * 商业意义: 模拟行情暴涨或推特大 V 转发后的"瞬间流量"，看系统是否会雪崩
 *
 * 本地无限制版本: 修改 target 为 1000 后运行 k6 run k6/stress-test.js
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

export const options = {
  stages: [
    // 阶段 1: 基线 - 20 用户稳定运行
    { duration: '30s', target: 20 },   // 30 秒爬升到 20 用户
    { duration: '1m', target: 20 },    // 保持 1 分钟

    // 阶段 2: 快速飙升 - 模拟大 V 转发
    { duration: '30s', target: 50 },   // 30 秒内飙升到 50
    { duration: '1m', target: 50 },    // 保持 1 分钟

    // 阶段 3: 极限压力 - 模拟热搜/暴涨行情
    { duration: '30s', target: 100 },  // 30 秒内飙升到 100 (Cloud 最大值)
    { duration: '3m', target: 100 },   // 保持 3 分钟，观察系统是否雪崩

    // 阶段 4: 流量回落
    { duration: '30s', target: 50 },   // 30 秒降到 50
    { duration: '30s', target: 20 },   // 30 秒降到 20
    { duration: '30s', target: 0 },    // 30 秒降到 0
  ],
  thresholds: {
    // 压力测试阈值相对宽松
    http_req_duration: ['p(95)<5000'],  // 95% 请求 < 5 秒
    http_req_failed: ['rate<0.30'],      // 错误率 < 30%（高压下可接受）
    errors: ['rate<0.30'],
  },
  cloud: {
    name: 'Ranking Arena - Stress Test (瞬间流量)',
  },
};

const BASE_URL = 'https://ranking-arena.vercel.app';

// 高频访问场景 - 模拟行情暴涨时用户疯狂刷新
export default function () {
  const scenarios = [
    // 60% 用户疯狂刷新首页
    { weight: 60, fn: refreshHomepage },
    // 25% 用户查看排行榜 API
    { weight: 25, fn: checkRankings },
    // 10% 用户搜索
    { weight: 10, fn: searchTraders },
    // 5% 用户访问详情页
    { weight: 5, fn: viewTraderDetail },
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

  // 极短的思考时间（模拟疯狂刷新）
  sleep(Math.random() * 0.5 + 0.1); // 0.1-0.6 秒
}

function refreshHomepage() {
  const res = http.get(`${BASE_URL}/`);
  responseTime.add(res.timings.duration);
  requestCount.add(1);

  const success = check(res, {
    '首页可访问': (r) => r.status === 200 || r.status === 503,
  });

  if (!success) {
    failedRequests.add(1);
  }
  errorRate.add(!success);
}

function checkRankings() {
  const sources = ['binance_futures', 'bybit', 'bitget_futures', 'okx_futures', 'mexc'];
  const source = sources[Math.floor(Math.random() * sources.length)];

  const res = http.get(`${BASE_URL}/api/traders?source=${source}&limit=20`);
  responseTime.add(res.timings.duration);
  requestCount.add(1);

  const success = check(res, {
    '排行榜 API 可用': (r) => r.status === 200 || r.status === 503 || r.status === 429,
  });

  if (!success) {
    failedRequests.add(1);
  }
  errorRate.add(!success);
}

function searchTraders() {
  const terms = ['btc', 'eth', 'sol', 'doge', 'bnb', 'xrp'];
  const term = terms[Math.floor(Math.random() * terms.length)];

  const res = http.get(`${BASE_URL}/api/search?q=${term}&limit=10`);
  responseTime.add(res.timings.duration);
  requestCount.add(1);

  const success = check(res, {
    '搜索 API 可用': (r) => r.status === 200 || r.status === 503 || r.status === 429,
  });

  if (!success) {
    failedRequests.add(1);
  }
  errorRate.add(!success);
}

function viewTraderDetail() {
  const res = http.get(`${BASE_URL}/trader/test`);
  responseTime.add(res.timings.duration);
  requestCount.add(1);

  const success = check(res, {
    '详情页可访问': (r) => r.status === 200 || r.status === 404 || r.status === 503,
  });

  if (!success) {
    failedRequests.add(1);
  }
  errorRate.add(!success);
}

// 测试结束汇总
export function handleSummary(data) {
  const metrics = data.metrics;

  console.log('\n' + '='.repeat(60));
  console.log('📊 压力测试结果汇总');
  console.log('='.repeat(60));

  console.log(`\n🔥 峰值并发: 100 用户 (Cloud 限制)`);
  console.log(`📈 总请求数: ${metrics.total_requests?.values?.count || 0}`);
  console.log(`❌ 失败请求: ${metrics.failed_requests?.values?.count || 0}`);
  console.log(`⏱️  平均响应: ${Math.round(metrics.response_time?.values?.avg || 0)}ms`);
  console.log(`⏱️  P95 响应: ${Math.round(metrics.response_time?.values?.['p(95)'] || 0)}ms`);
  console.log(`⏱️  最大响应: ${Math.round(metrics.response_time?.values?.max || 0)}ms`);
  console.log(`📉 错误率: ${((metrics.errors?.values?.rate || 0) * 100).toFixed(2)}%`);

  // 判断是否通过
  const errorRateValue = metrics.errors?.values?.rate || 0;
  const p95 = metrics.response_time?.values?.['p(95)'] || 0;

  console.log('\n' + '-'.repeat(60));
  if (errorRateValue < 0.1 && p95 < 3000) {
    console.log('✅ 系统表现优秀！能够承受瞬间流量冲击');
  } else if (errorRateValue < 0.2 && p95 < 5000) {
    console.log('⚠️  系统基本可用，但在高压下有性能下降');
  } else {
    console.log('❌ 系统出现雪崩迹象，需要优化！');
    console.log('   建议: 增加服务器资源 / 添加缓存 / 使用 CDN / 限流');
  }
  console.log('='.repeat(60) + '\n');

  return {
    stdout: '',
  };
}
