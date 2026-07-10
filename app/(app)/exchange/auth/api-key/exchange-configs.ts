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
        {
          title: '设置只读权限',
          desc: '只勾选「启用读取」，不要勾选其他权限，完成后复制 API Key 和 Secret',
        },
      ],
      en: [
        { title: 'Login to Binance', desc: 'Visit Binance website and login to your account' },
        {
          title: 'Go to API Management',
          desc: 'Click avatar on top right → Select "API Management"',
        },
        {
          title: 'Create API Key',
          desc: 'Click "Create API", select "System Generated", set a label',
        },
        {
          title: 'Set Read-Only Permission',
          desc: 'Only check "Enable Reading", do not check other permissions. Copy API Key and Secret',
        },
      ],
      ja: [
        {
          title: 'Binance にログイン',
          desc: 'Binance 公式サイトにアクセスし、アカウントにログインします',
        },
        { title: 'API 管理へ移動', desc: '右上のアイコンをクリック →「API 管理」を選択' },
        {
          title: 'API キーを作成',
          desc: '「API 作成」をクリックし、「システム生成」を選択して、ラベル名を設定します',
        },
        {
          title: '読み取り専用権限を設定',
          desc: '「読み取りを有効化」のみをチェックし、他の権限はチェックしないでください。完了後、API キーと Secret をコピーします',
        },
      ],
      ko: [
        {
          title: 'Binance 로그인',
          desc: 'Binance 공식 사이트에 접속하여 계정에 로그인합니다',
        },
        { title: 'API 관리로 이동', desc: '오른쪽 상단 아이콘 클릭 →「API 관리」 선택' },
        {
          title: 'API 키 생성',
          desc: '「API 생성」을 클릭하고 「시스템 생성」을 선택한 후 라벨 이름을 설정합니다',
        },
        {
          title: '읽기 전용 권한 설정',
          desc: '「읽기 활성화」만 체크하고 다른 권한은 체크하지 마세요. 완료 후 API 키와 Secret을 복사합니다',
        },
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
        {
          title: '设置只读权限',
          desc: '选择「只读」权限类型，完成安全验证后复制 API Key 和 Secret',
        },
      ],
      en: [
        { title: 'Login to Bybit', desc: 'Visit Bybit website and login to your account' },
        { title: 'Go to API Management', desc: 'Click avatar on top right → Select "API"' },
        {
          title: 'Create API Key',
          desc: 'Click "Create New Key", select "System-generated API Keys"',
        },
        {
          title: 'Set Read-Only Permission',
          desc: 'Select "Read-Only" permission type. Copy API Key and Secret after verification',
        },
      ],
      ja: [
        {
          title: 'Bybit にログイン',
          desc: 'Bybit 公式サイトにアクセスし、アカウントにログインします',
        },
        { title: 'API 管理へ移動', desc: '右上のアイコンをクリック →「API」を選択' },
        {
          title: 'API キーを作成',
          desc: '「新規キー作成」をクリックし、「システム生成 API キー」を選択します',
        },
        {
          title: '読み取り専用権限を設定',
          desc: '「読み取り専用」の権限タイプを選択し、セキュリティ認証の完了後、API キーと Secret をコピーします',
        },
      ],
      ko: [
        { title: 'Bybit 로그인', desc: 'Bybit 공식 사이트에 접속하여 계정에 로그인합니다' },
        { title: 'API 관리로 이동', desc: '오른쪽 상단 아이콘 클릭 →「API」 선택' },
        {
          title: 'API 키 생성',
          desc: '「새 키 생성」을 클릭하고 「시스템 생성 API 키」를 선택합니다',
        },
        {
          title: '읽기 전용 권한 설정',
          desc: '「읽기 전용」 권한 유형을 선택하고 보안 인증을 완료한 후 API 키와 Secret을 복사합니다',
        },
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
        {
          title: '设置只读权限',
          desc: '只勾选「只读」权限，完成验证后复制 API Key、Secret 和 Passphrase',
        },
      ],
      en: [
        { title: 'Login to Bitget', desc: 'Visit Bitget website and login to your account' },
        { title: 'Go to API Management', desc: 'Click avatar on top right → "API Management"' },
        { title: 'Create API Key', desc: 'Click "Create API", set a remark and Passphrase' },
        {
          title: 'Set Read-Only Permission',
          desc: 'Only check "Read-Only" permission. Copy API Key, Secret and Passphrase after verification',
        },
      ],
      ja: [
        {
          title: 'Bitget にログイン',
          desc: 'Bitget 公式サイトにアクセスし、アカウントにログインします',
        },
        { title: 'API 管理へ移動', desc: '右上のアイコンをクリック →「API 管理」' },
        {
          title: 'API キーを作成',
          desc: '「API 作成」をクリックし、メモ名とパスフレーズ（Passphrase）を設定します',
        },
        {
          title: '読み取り専用権限を設定',
          desc: '「読み取り専用」権限のみをチェックし、認証の完了後、API キー、Secret、Passphrase をコピーします',
        },
      ],
      ko: [
        { title: 'Bitget 로그인', desc: 'Bitget 공식 사이트에 접속하여 계정에 로그인합니다' },
        { title: 'API 관리로 이동', desc: '오른쪽 상단 아이콘 클릭 →「API 관리」' },
        {
          title: 'API 키 생성',
          desc: '「API 생성」을 클릭하고 메모 이름과 패스프레이즈(Passphrase)를 설정합니다',
        },
        {
          title: '읽기 전용 권한 설정',
          desc: '「읽기 전용」 권한만 체크하고 인증을 완료한 후 API 키, Secret, Passphrase를 복사합니다',
        },
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
        {
          title: 'Set Read-Only Permission',
          desc: 'Select "Read-Only" permission. Copy API Key and Secret after verification',
        },
      ],
      ja: [
        {
          title: 'MEXC にログイン',
          desc: 'MEXC 公式サイトにアクセスし、アカウントにログインします',
        },
        { title: 'API 管理へ移動', desc: '右上のアイコンをクリック →「API 管理」' },
        { title: 'API キーを作成', desc: '「API 作成」をクリックし、メモ名を入力します' },
        {
          title: '読み取り専用権限を設定',
          desc: '「読み取り専用」権限を選択し、セキュリティ認証の完了後、API キーと Secret をコピーします',
        },
      ],
      ko: [
        { title: 'MEXC 로그인', desc: 'MEXC 공식 사이트에 접속하여 계정에 로그인합니다' },
        { title: 'API 관리로 이동', desc: '오른쪽 상단 아이콘 클릭 →「API 관리」' },
        { title: 'API 키 생성', desc: '「API 생성」을 클릭하고 메모 이름을 입력합니다' },
        {
          title: '읽기 전용 권한 설정',
          desc: '「읽기 전용」 권한을 선택하고 보안 인증을 완료한 후 API 키와 Secret을 복사합니다',
        },
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
        {
          title: 'Set Read-Only Permission',
          desc: 'Only check "Query" permission. Copy API Key and Secret after verification',
        },
      ],
      ja: [
        {
          title: 'CoinEx にログイン',
          desc: 'CoinEx 公式サイトにアクセスし、アカウントにログインします',
        },
        { title: 'API 管理へ移動', desc: '右上のアイコンをクリック →「API 管理」' },
        { title: 'API キーを作成', desc: '「API キー作成」をクリックし、メモを入力します' },
        {
          title: '読み取り専用権限を設定',
          desc: '「照会」権限のみをチェックし、認証の完了後、API キーと Secret をコピーします',
        },
      ],
      ko: [
        { title: 'CoinEx 로그인', desc: 'CoinEx 공식 사이트에 접속하여 계정에 로그인합니다' },
        { title: 'API 관리로 이동', desc: '오른쪽 상단 아이콘 클릭 →「API 관리」' },
        { title: 'API 키 생성', desc: '「API 키 생성」을 클릭하고 메모를 입력합니다' },
        {
          title: '읽기 전용 권한 설정',
          desc: '「조회」 권한만 체크하고 인증을 완료한 후 API 키와 Secret을 복사합니다',
        },
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
        {
          title: '设置只读权限',
          desc: '只勾选「读取」权限，不要开启交易权限，完成验证后复制 API Key 和 Secret',
        },
      ],
      en: [
        { title: 'Login to HTX', desc: 'Visit HTX website and login to your account' },
        {
          title: 'Go to API Management',
          desc: 'Click avatar on top right, select "API Management"',
        },
        { title: 'Create API Key', desc: 'Click "Create API Key", enter a remark' },
        {
          title: 'Set Read-Only Permission',
          desc: 'Only check "Read" permission. Do not enable trading. Copy API Key and Secret after verification',
        },
      ],
      ja: [
        { title: 'HTX にログイン', desc: 'HTX 公式サイトにアクセスし、アカウントにログインします' },
        { title: 'API 管理へ移動', desc: '右上のアイコンをクリック →「API 管理」を選択' },
        { title: 'API キーを作成', desc: '「API キー作成」をクリックし、メモ名を入力します' },
        {
          title: '読み取り専用権限を設定',
          desc: '「読み取り」権限のみをチェックし、取引権限は有効にしないでください。認証の完了後、API キーと Secret をコピーします',
        },
      ],
      ko: [
        { title: 'HTX 로그인', desc: 'HTX 공식 사이트에 접속하여 계정에 로그인합니다' },
        { title: 'API 관리로 이동', desc: '오른쪽 상단 아이콘 클릭 →「API 관리」 선택' },
        { title: 'API 키 생성', desc: '「API 키 생성」을 클릭하고 메모 이름을 입력합니다' },
        {
          title: '읽기 전용 권한 설정',
          desc: '「읽기」 권한만 체크하고 거래 권한은 활성화하지 마세요. 인증을 완료한 후 API 키와 Secret을 복사합니다',
        },
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
        {
          title: 'Go to API Management',
          desc: 'Click avatar on top right, select "API Management"',
        },
        { title: 'Create API Key', desc: 'Click "Create API", enter a remark' },
        {
          title: 'Set Read-Only Permission',
          desc: 'Only check "Read-Only" permission. Copy API Key and Secret after verification',
        },
      ],
      ja: [
        {
          title: 'WEEX にログイン',
          desc: 'WEEX 公式サイトにアクセスし、アカウントにログインします',
        },
        { title: 'API 管理へ移動', desc: '右上のアイコンをクリック →「API 管理」を選択' },
        { title: 'API キーを作成', desc: '「API 作成」をクリックし、メモ名を入力します' },
        {
          title: '読み取り専用権限を設定',
          desc: '「読み取り専用」権限のみをチェックし、認証の完了後、API キーと Secret をコピーします',
        },
      ],
      ko: [
        { title: 'WEEX 로그인', desc: 'WEEX 공식 사이트에 접속하여 계정에 로그인합니다' },
        { title: 'API 관리로 이동', desc: '오른쪽 상단 아이콘 클릭 →「API 관리」 선택' },
        { title: 'API 키 생성', desc: '「API 생성」을 클릭하고 메모 이름을 입력합니다' },
        {
          title: '읽기 전용 권한 설정',
          desc: '「읽기 전용」 권한만 체크하고 인증을 완료한 후 API 키와 Secret을 복사합니다',
        },
      ],
    },
  },
} as const

export type ExchangeId = keyof typeof EXCHANGE_CONFIGS

// ── Single source of truth for the exchange-binding flow ──────────────────────
// Both /exchange/auth (method chooser) and /exchange/auth/api-key (API-key step)
// plus the settings ExchangeConnection manager derive their exchange list, display
// names and OAuth capability from here — never re-declare a local EXCHANGES array.
// Display names are the canonical brand casing (WEEX, CoinEx, MEXC, HTX).

// Exchanges that support OAuth authorization (vs API-key only).
export const OAUTH_SUPPORTED_EXCHANGES: ReadonlySet<ExchangeId> = new Set<ExchangeId>([
  'binance',
  'bybit',
])

export function isOAuthSupported(id: ExchangeId): boolean {
  return OAUTH_SUPPORTED_EXCHANGES.has(id)
}

export interface ExchangeBindOption {
  id: ExchangeId
  name: string
  oauthSupported: boolean
}

// Ordered list for rendering exchange pickers / connection managers.
export const EXCHANGE_BIND_LIST: readonly ExchangeBindOption[] = (
  Object.keys(EXCHANGE_CONFIGS) as ExchangeId[]
).map((id) => ({
  id,
  name: EXCHANGE_CONFIGS[id].name,
  oauthSupported: OAUTH_SUPPORTED_EXCHANGES.has(id),
}))
