import http from 'k6/http';
import { check } from 'k6';

// 冒烟测试 - 快速验证系统是否正常
export const options = {
  vus: 1,              // 1个虚拟用户
  duration: '10s',     // 运行10秒
  thresholds: {
    http_req_duration: ['p(99)<1500'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = 'https://ranking-arena.vercel.app';

export default function () {
  // 测试关键端点
  const endpoints = [
    { name: 'Homepage', url: '/' },
    { name: 'Exchange Auth', url: '/exchange/auth' },
    { name: 'Settings', url: '/settings' },
  ];

  for (const endpoint of endpoints) {
    const res = http.get(`${BASE_URL}${endpoint.url}`);
    check(res, {
      [`${endpoint.name} is OK`]: (r) => r.status === 200,
    });
  }
}
