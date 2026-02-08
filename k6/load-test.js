/**
 * 负载测试 (Load Test)
 *
 * 场景: 模拟正常流量 50-100 用户并发
 * 商业意义: 评估日常运营时的用户体验和服务器成本
 *
 * 运行: k6 run k6/load-test.js
 * 云端: k6 cloud k6/load-test.js
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// 自定义指标
const errorRate = new Rate('errors');
const pageLoadTime = new Trend('page_load_time');
const apiResponseTime = new Trend('api_response_time');
const requestCount = new Counter('total_requests');

export const options = {
  stages: [
    { duration: '1m', target: 50 },   // 1 分钟爬升到 50 用户
    { duration: '3m', target: 50 },   // 保持 50 用户 3 分钟
    { duration: '1m', target: 100 },  // 1 分钟爬升到 100 用户
    { duration: '3m', target: 100 },  // 保持 100 用户 3 分钟
    { duration: '2m', target: 0 },    // 2 分钟降到 0
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'],  // 95% 请求 < 2 秒
    http_req_failed: ['rate<0.05'],      // 错误率 < 5%
    errors: ['rate<0.05'],
    page_load_time: ['p(95)<3000'],      // 页面加载 < 3 秒
    api_response_time: ['p(95)<1000'],   // API 响应 < 1 秒
  },
  cloud: {
    name: 'Ranking Arena - Load Test',
  },
};

const BASE_URL = 'https://ranking-arena.vercel.app';

// 模拟真实用户行为
export default function main() {
  // 场景 1: 新用户访问首页并浏览排行榜
  group('新用户浏览', () => {
    // 访问首页
    let res = http.get(`${BASE_URL}/`);
    pageLoadTime.add(res.timings.duration);
    requestCount.add(1);
    let success = check(res, {
      '首页加载成功': (r) => r.status === 200,
    });
    errorRate.add(!success);
    sleep(2); // 用户看 2 秒

    // 加载排行榜数据
    res = http.get(`${BASE_URL}/api/traders?source=binance_futures&limit=20`);
    apiResponseTime.add(res.timings.duration);
    requestCount.add(1);
    success = check(res, {
      '排行榜 API 正常': (r) => r.status === 200,
      '有交易员数据': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body && (Array.isArray(body) || body.traders);
        } catch {
          return false;
        }
      },
    });
    errorRate.add(!success);
    sleep(3); // 用户浏览排行榜
  });

  // 场景 2: 用户搜索交易员
  group('搜索功能', () => {
    const searchTerms = ['btc', 'eth', 'sol', 'doge'];
    const term = searchTerms[Math.floor(Math.random() * searchTerms.length)];

    const res = http.get(`${BASE_URL}/api/search?q=${term}&limit=10`);
    apiResponseTime.add(res.timings.duration);
    requestCount.add(1);
    const success = check(res, {
      '搜索 API 正常': (r) => r.status === 200,
    });
    errorRate.add(!success);
    sleep(2);
  });

  // 场景 3: 查看交易员详情
  group('交易员详情', () => {
    const res = http.get(`${BASE_URL}/trader/test`);
    pageLoadTime.add(res.timings.duration);
    requestCount.add(1);
    const success = check(res, {
      '详情页加载': (r) => r.status === 200 || r.status === 404,
    });
    errorRate.add(!success);
    sleep(5); // 用户仔细查看
  });

  // 场景 4: 切换不同交易所筛选
  group('切换交易所', () => {
    const sources = ['binance_futures', 'bybit', 'bitget_futures', 'okx_futures'];
    const source = sources[Math.floor(Math.random() * sources.length)];

    const res = http.get(`${BASE_URL}/api/traders?source=${source}&limit=20`);
    apiResponseTime.add(res.timings.duration);
    requestCount.add(1);
    const success = check(res, {
      '交易所切换成功': (r) => r.status === 200,
    });
    errorRate.add(!success);
    sleep(2);
  });

  // 随机思考时间
  sleep(Math.random() * 3 + 1);
}
