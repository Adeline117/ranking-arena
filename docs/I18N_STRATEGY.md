# i18n国际化方案

## A. 推荐方案

**保留现有自定义实现，优化结构**

理由：
- 已有 800+ 翻译条目，迁移成本高
- 自定义方案足够轻量
- 避免引入新依赖

---

## B. 目录结构

### 当前结构
```
lib/
└── i18n.ts              # 核心函数 + 所有翻译（800+行）
```

### 推荐重构结构
```
lib/
├── i18n/
│   ├── index.ts           # 核心函数导出
│   ├── types.ts           # 类型定义
│   ├── locales/
│   │   ├── zh.ts          # 中文翻译
│   │   └── en.ts          # 英文翻译
│   └── namespaces/        # 按功能分组（可选）
│       ├── common.ts      # 通用文案
│       ├── premium.ts     # Pro相关
│       └── errors.ts      # 错误信息
```

---

## C. Key 命名规范

```typescript
// 格式：namespace.context.action
{
  // 通用
  "common.confirm": "确定",
  "common.cancel": "取消",
  "common.loading": "加载中",

  // 用户操作
  "user.follow": "关注",
  "user.unfollow": "取消关注",
  "user.following": "关注中",

  // 错误
  "error.network": "网络不稳定",
  "error.unauthorized": "请先登录",
  "error.forbidden": "无权限",

  // Pro
  "pro.upgrade": "升级 Pro",
  "pro.exclusive": "Pro 专属",
  "pro.expired": "Pro 已到期",

  // 表单
  "form.required": "必填",
  "form.maxLength": "最多 {max} 字符",
}
```

---

## D. 迁移计划

### 步骤1：结构重构（可提交PR）
- 拆分 `lib/i18n.ts` 到 `lib/i18n/locales/` 目录
- 创建类型定义文件
- 不改变现有 API

### 步骤2：补全缺失翻译（可提交PR）
- 整理所有硬编码文案清单
- 添加缺失的 key
- 修改组件使用 `t()` 函数

### 步骤3：质量保证（可提交PR）
- 添加 lint 规则检测硬编码
- 添加翻译完整性检查脚本
- 文档化 key 命名规范

---

## E. 自动化检查策略

### 1. ESLint 规则
```javascript
// .eslintrc.js
{
  rules: {
    // 自定义规则：禁止 JSX 中的中文字符串
    'no-literal-string': ['warn', {
      ignore: ['className', 'style'],
      ignoreAttribute: ['data-testid']
    }]
  }
}
```

### 2. grep 脚本检测硬编码
```bash
#!/bin/bash
# scripts/check-hardcoded-strings.sh

echo "检查硬编码中文字符串..."
grep -r "[\u4e00-\u9fa5]" --include="*.tsx" app/components/ \
  | grep -v "// " \
  | grep -v "console\." \
  | grep -v "i18n\."

echo "检查未使用 t() 的组件..."
grep -rL "useLanguage\|t\(" --include="*.tsx" app/components/
```

### 3. CI 检查翻译完整性
```typescript
// scripts/check-i18n-completeness.ts
import { translations } from '../lib/i18n'

const zhKeys = Object.keys(translations.zh)
const enKeys = Object.keys(translations.en)

const missingInEn = zhKeys.filter(k => !enKeys.includes(k))
const missingInZh = enKeys.filter(k => !zhKeys.includes(k))

if (missingInEn.length || missingInZh.length) {
  console.error('翻译不完整：')
  console.error('英文缺失：', missingInEn)
  console.error('中文缺失：', missingInZh)
  process.exit(1)
}
```

---

## F. 示例 Key 设计

### Button
```typescript
// key
"common.save": "保存" / "Save"
"common.saving": "保存中" / "Saving"

// 使用
<Button>{t('common.save')}</Button>
```

### Toast
```typescript
// key
"toast.saved": "已保存" / "Saved"
"toast.error.network": "网络错误，请重试" / "Network error, try again"

// 使用
showToast(t('toast.saved'), 'success')
```

### Form 错误
```typescript
// key
"form.error.required": "此项必填" / "Required"
"form.error.email": "邮箱格式不正确" / "Invalid email"

// 使用
{errors.email && <span>{t('form.error.email')}</span>}
```

---

## G. 当前存在的硬编码位置

### 高优先级修复
| 文件 | 行号 | 硬编码内容 | 建议key |
|------|------|----------|---------|
| `TopNav.tsx` | 442 | aria-label="搜索交易员" | `aria.searchTrader` |
| `TopNav.tsx` | 597 | aria-label="用户菜单" | `aria.userMenu` |
| `Onboarding.tsx` | 63-84 | 独立TRANSLATIONS对象 | 合并到全局i18n |

### 中优先级修复
| 文件 | 内容 | 建议key |
|------|------|---------|
| 各处 console.warn | 中文日志信息 | 无需翻译，但建议统一为英文 |

---

## H. 已完成的i18n改进

### 本次新增翻译键（25+）
- UI操作反馈：confirm, cancel, saved, deleted, replied, voted, bookmarked, reposted
- 错误信息：networkError, operationFailed, timeout, loginExpired, tooFast
- Pro相关：proOnly, noAccess, contentNotFound
- 关注相关：unfollow, mutualFollow, followBack, followingAction, unfollowingAction

### 本次修复的组件
- Dialog.tsx：使用 t('confirm'), t('cancel')
- PremiumGate.tsx：使用 t('pleaseLogin'), t('proOnly')
- UpgradePrompt.tsx：使用 t('upgradeToPro'), t('proOnly')
