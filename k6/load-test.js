import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// 自定义指标
const errorRate = new Rate('errors');
const homepageDuration = new Trend('homepage_duration');
const apiDuration = new Trend('api_duration');

// 测试配置
export const options = {
  stages: [
    { duration: '30s', target: 10 },   // 预热: 30秒增加到10用户
    { duration: '1m', target: 50 },    // 加压: 1分钟增加到50用户
    { duration: '2m', target: 50 },    // 稳定: 保持50用户2分钟
    { duration: '30s', target: 0 },    // 降压: 30秒降到0
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'],  // 95%请求需<2秒
    errors: ['rate<0.1'],                // 错误率<10%
  },
  // k6 Cloud 配置
  cloud: {
    projectID: 3737280,
    name: 'Ranking Arena Load Test',
  },
};

const BASE_URL = 'https://ranking-arena.vercel.app';

export default function () {
  // 1. 测试首页
  group('Homepage', () => {
    const res = http.get(`${BASE_URL}/`);
    homepageDuration.add(res.timings.duration);

    const success = check(res, {
      'homepage status 200': (r) => r.status === 200,
      'homepage < 2s': (r) => r.timings.duration < 2000,
    });
    errorRate.add(!success);
  });

  sleep(1);

  // 2. 测试排行榜 API
  group('Ranking API', () => {
    const res = http.get(`${BASE_URL}/api/traders?source=binance_futures&limit=20`);
    apiDuration.add(res.timings.duration);

    const success = check(res, {
      'traders API status 200': (r) => r.status === 200,
      'traders API < 1s': (r) => r.timings.duration < 1000,
      'has data': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body && (Array.isArray(body) || body.traders);
        } catch {
          return false;
        }
      },
    });
    errorRate.add(!success);
  });

  sleep(1);

  // 3. 测试搜索 API
  group('Search API', () => {
    const res = http.get(`${BASE_URL}/api/search?q=btc&limit=10`);
    apiDuration.add(res.timings.duration);

    const success = check(res, {
      'search API status 200': (r) => r.status === 200,
      'search API < 1s': (r) => r.timings.duration < 1000,
    });
    errorRate.add(!success);
  });

  sleep(1);

  // 4. 测试交易员详情页
  group('Trader Detail Page', () => {
    const res = http.get(`${BASE_URL}/trader/test`);

    const success = check(res, {
      'trader page loads': (r) => r.status === 200 || r.status === 404,
      'trader page < 2s': (r) => r.timings.duration < 2000,
    });
    errorRate.add(!success);
  });

  sleep(Math.random() * 2 + 1); // 随机等待1-3秒
}

// 测试结束后的汇总
export function handleSummary(data) {
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    'k6/summary.json': JSON.stringify(data, null, 2),
  };
}

function textSummary(data, opts) {
  const metrics = data.metrics;
  let output = '\n========== 测试结果汇总 ==========\n\n';

  output += `总请求数: ${metrics.http_reqs?.values?.count || 0}\n`;
  output += `平均响应时间: ${Math.round(metrics.http_req_duration?.values?.avg || 0)}ms\n`;
  output += `P95 响应时间: ${Math.round(metrics.http_req_duration?.values?.['p(95)'] || 0)}ms\n`;
  output += `错误率: ${((metrics.errors?.values?.rate || 0) * 100).toFixed(2)}%\n`;

  return output;
}
