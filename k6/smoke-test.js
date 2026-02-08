/**
 * 冒烟测试 (Smoke Test)
 *
 * 场景: 1-2 个用户，持续 1 分钟
 * 商业意义: 验证基本功能在最小负载下是否正常
 *
 * 运行: k6 run k6/smoke-test.js
 * 云端: k6 cloud k6/smoke-test.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('errors');

export const options = {
  vus: 2,                // 2 个虚拟用户
  duration: '1m',        // 持续 1 分钟
  thresholds: {
    http_req_duration: ['p(95)<1000'],  // 95% 请求 < 1 秒
    http_req_failed: ['rate<0.01'],      // 错误率 < 1%
    errors: ['rate<0.01'],
  },
  cloud: {
    name: 'Ranking Arena - Smoke Test',
  },
};

const BASE_URL = 'https://ranking-arena.vercel.app';

export default function main() {
  // 1. 首页
  let res = http.get(`${BASE_URL}/`);
  let success = check(res, {
    '首页状态 200': (r) => r.status === 200,
    '首页响应 < 1s': (r) => r.timings.duration < 1000,
  });
  errorRate.add(!success);
  sleep(1);

  // 2. 排行榜 API
  res = http.get(`${BASE_URL}/api/traders?source=binance_futures&limit=20`);
  success = check(res, {
    '排行榜 API 200': (r) => r.status === 200,
    '排行榜响应 < 500ms': (r) => r.timings.duration < 500,
  });
  errorRate.add(!success);
  sleep(1);

  // 3. 搜索 API
  res = http.get(`${BASE_URL}/api/search?q=btc&limit=10`);
  success = check(res, {
    '搜索 API 200': (r) => r.status === 200,
  });
  errorRate.add(!success);
  sleep(1);

  // 4. 设置页
  res = http.get(`${BASE_URL}/settings`);
  success = check(res, {
    '设置页状态 200': (r) => r.status === 200,
  });
  errorRate.add(!success);
  sleep(1);
}
