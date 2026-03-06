// 交易所配置
export const EXCHANGE_CONFIGS = {
  binance: {
    name: 'Binance',
    apiManagementUrl: 'https://www.binance.com/en/my/settings/api-management',
    needsPassphrase: false,
    steps: {
      zh: [
        { title: '登录 Binance', desc: '访问 Binance 官网，登录您的账户' },
        { title: '进入 API 管理', desc: '点击右上角头像 → 选择「API 管理」' },
        { title: '创建 API Key', desc: '点击「创建 API」，选择「系统生成」，设置标签名称' },
        { title: '设置只读权限', desc: '只勾选「启用读取」，不要勾选其他权限，完成后复制 API Key 和 Secret' },
      ],
      en: [
        { title: 'Login to Binance', desc: 'Visit Binance website and login to your account' },
        { title: 'Go to API Management', desc: 'Click avatar on top right → Select "API Management"' },
        { title: 'Create API Key', desc: 'Click "Create API", select "System Generated", set a label' },
        { title: 'Set Read-Only Permission', desc: 'Only check "Enable Reading", do not check other permissions. Copy API Key and Secret' },
      ],
    },
  },
  bybit: {
    name: 'Bybit',
    apiManagementUrl: 'https://www.bybit.com/user/api-management',
    needsPassphrase: false,
    steps: {
      zh: [
        { title: '登录 Bybit', desc: '访问 Bybit 官网，登录您的账户' },
        { title: '进入 API 管理', desc: '点击右上角头像 → 选择「API」' },
        { title: '创建 API Key', desc: '点击「创建新密钥」，选择「系统生成 API 密钥」' },
        { title: '设置只读权限', desc: '选择「只读」权限类型，完成安全验证后复制 API Key 和 Secret' },
      ],
      en: [
        { title: 'Login to Bybit', desc: 'Visit Bybit website and login to your account' },
        { title: 'Go to API Management', desc: 'Click avatar on top right → Select "API"' },
        { title: 'Create API Key', desc: 'Click "Create New Key", select "System-generated API Keys"' },
        { title: 'Set Read-Only Permission', desc: 'Select "Read-Only" permission type. Copy API Key and Secret after verification' },
      ],
    },
  },
  bitget: {
    name: 'Bitget',
    apiManagementUrl: 'https://www.bitget.com/account/api',
    needsPassphrase: true,
    steps: {
      zh: [
        { title: '登录 Bitget', desc: '访问 Bitget 官网，登录您的账户' },
        { title: '进入 API 管理', desc: '点击右上角头像 → 「API 管理」' },
        { title: '创建 API Key', desc: '点击「创建 API」，设置备注名和密码短语（Passphrase）' },
        { title: '设置只读权限', desc: '只勾选「只读」权限，完成验证后复制 API Key、Secret 和 Passphrase' },
      ],
      en: [
        { title: 'Login to Bitget', desc: 'Visit Bitget website and login to your account' },
        { title: 'Go to API Management', desc: 'Click avatar on top right → "API Management"' },
        { title: 'Create API Key', desc: 'Click "Create API", set a remark and Passphrase' },
        { title: 'Set Read-Only Permission', desc: 'Only check "Read-Only" permission. Copy API Key, Secret and Passphrase after verification' },
      ],
    },
  },
  mexc: {
    name: 'MEXC',
    apiManagementUrl: 'https://www.mexc.com/user/openapi',
    needsPassphrase: false,
    steps: {
      zh: [
        { title: '登录 MEXC', desc: '访问 MEXC 官网，登录您的账户' },
        { title: '进入 API 管理', desc: '点击右上角头像 → 「API 管理」' },
        { title: '创建 API Key', desc: '点击「创建 API」，输入备注名称' },
        { title: '设置只读权限', desc: '选择「只读」权限，完成安全验证后复制 API Key 和 Secret' },
      ],
      en: [
        { title: 'Login to MEXC', desc: 'Visit MEXC website and login to your account' },
        { title: 'Go to API Management', desc: 'Click avatar on top right → "API Management"' },
        { title: 'Create API Key', desc: 'Click "Create API", enter a remark' },
        { title: 'Set Read-Only Permission', desc: 'Select "Read-Only" permission. Copy API Key and Secret after verification' },
      ],
    },
  },
  coinex: {
    name: 'CoinEx',
    apiManagementUrl: 'https://www.coinex.com/apikey',
    needsPassphrase: false,
    steps: {
      zh: [
        { title: '登录 CoinEx', desc: '访问 CoinEx 官网，登录您的账户' },
        { title: '进入 API 管理', desc: '点击右上角头像 → 「API 管理」' },
        { title: '创建 API Key', desc: '点击「创建 API Key」，输入备注' },
        { title: '设置只读权限', desc: '只勾选「查询」权限，完成验证后复制 API Key 和 Secret' },
      ],
      en: [
        { title: 'Login to CoinEx', desc: 'Visit CoinEx website and login to your account' },
        { title: 'Go to API Management', desc: 'Click avatar on top right → "API Management"' },
        { title: 'Create API Key', desc: 'Click "Create API Key", enter a remark' },
        { title: 'Set Read-Only Permission', desc: 'Only check "Query" permission. Copy API Key and Secret after verification' },
      ],
    },
  },
  htx: {
    name: 'HTX',
    apiManagementUrl: 'https://www.htx.com/en-us/apikey/',
    needsPassphrase: false,
    steps: {
      zh: [
        { title: '登录 HTX', desc: '访问 HTX 官网，登录您的账户' },
        { title: '进入 API 管理', desc: '点击右上角头像 → 「API 管理」' },
        { title: '创建 API Key', desc: '点击「创建 API Key」，输入备注名称' },
        { title: '设置只读权限', desc: '只勾选「读取」权限，不要开启交易权限，完成验证后复制 API Key 和 Secret' },
      ],
      en: [
        { title: 'Login to HTX', desc: 'Visit HTX website and login to your account' },
        { title: 'Go to API Management', desc: 'Click avatar on top right, select "API Management"' },
        { title: 'Create API Key', desc: 'Click "Create API Key", enter a remark' },
        { title: 'Set Read-Only Permission', desc: 'Only check "Read" permission. Do not enable trading. Copy API Key and Secret after verification' },
      ],
    },
  },
  weex: {
    name: 'WEEX',
    apiManagementUrl: 'https://www.weex.com/account/api',
    needsPassphrase: false,
    steps: {
      zh: [
        { title: '登录 WEEX', desc: '访问 WEEX 官网，登录您的账户' },
        { title: '进入 API 管理', desc: '点击右上角头像 → 「API 管理」' },
        { title: '创建 API Key', desc: '点击「创建 API」，输入备注名称' },
        { title: '设置只读权限', desc: '只勾选「只读」权限，完成验证后复制 API Key 和 Secret' },
      ],
      en: [
        { title: 'Login to WEEX', desc: 'Visit WEEX website and login to your account' },
        { title: 'Go to API Management', desc: 'Click avatar on top right, select "API Management"' },
        { title: 'Create API Key', desc: 'Click "Create API", enter a remark' },
        { title: 'Set Read-Only Permission', desc: 'Only check "Read-Only" permission. Copy API Key and Secret after verification' },
      ],
    },
  },
} as const

export type ExchangeId = keyof typeof EXCHANGE_CONFIGS
