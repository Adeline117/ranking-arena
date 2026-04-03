# Arena Pipeline 根本原因分析与永久修复 (2026-04-03)

## 问题现象
- 19个失败任务
- 2个卡住任务（meta-monitor 55分钟，snapshot-positions 50分钟）
- cleanup-stuck-logs报错"supabaseUrl is required"
- 健康监控脚本超时

## 根本原因分析

### 1. **CI/CD部署失败（最关键）**
**发现**: 最近5次GitHub Actions CI全部FAILURE
```
e2ae3cfa9: failure (2026-04-03 16:09)
fe26563df: failure (2026-04-03 16:07)
895b7bfae: failure (2026-04-03 16:06) ← CRITICAL FIX提交
```

**原因**: 重复的数据库迁移版本号
```
supabase/migrations/20260331a_*.sql (2个文件同版本号)
supabase/migrations/20260401000001_*.sql (2个文件同版本号)
supabase/migrations/20260401b_*.sql (2个文件同版本号)
```

**后果**: 
- commit 895b7bfae的getPlatformTimeout()修复根本没有部署到生产环境
- batch-enrich仍在使用旧的硬编码超时（90s/120s）
- 所有"已修复"的功能实际上都没有生效

### 2. **cleanup-stuck-logs不工作**
**原因**: 环境变量NEXT_PUBLIC_SUPABASE_URL在shell环境中未设置
- .env文件里有配置
- 但运行脚本时环境未加载
- createClient()抛出"supabaseUrl is required"错误

**后果**:
- 卡住的任务无法自动清理
- meta-monitor和snapshot-positions等超时任务一直显示"running"状态
- 健康监控误报

### 3. **卡住任务的本质**
**meta-monitor** (maxDuration: 30s):
- Vercel超时后自动kill进程
- 但PipelineLogger没有机会将状态更新为"timeout"
- 日志永远停留在"running"状态

**snapshot-positions** (maxDuration: 120s):
- 同样问题：进程被kill，状态未更新

**设计缺陷**: 
- 依赖进程内的finally块来更新日志状态
- 进程被强制kill时，finally不执行
- 需要外部清理机制（cleanup-stuck-logs）

## 永久修复方案

### ✅ 已完成（2026-04-03 10:07 PDT）

#### 1. 修复重复迁移版本号
```bash
# 重命名冲突文件
20260331a_security_audit_rls_fixes.sql → 20260331a2_security_audit_rls_fixes.sql
20260401000001_user_strikes.sql → 20260401000000_user_strikes.sql
20260401b_security_rls_fixes.sql → 20260401b2_security_rls_fixes.sql
```
**Commit**: da5b7039e "fix: resolve duplicate migration versions"
**状态**: ✅ 已push，CI运行中

#### 2. 修复cleanup-stuck-logs环境变量
**根本修复**: 
- 健康监控脚本现在会加载.env文件
- 所有调用Supabase的脚本都必须确保环境变量已设置

**验证**: 
```
✅ Auto-cleaned 20 stuck logs
```

### 🔄 待验证

#### 3. 验证部署成功
```bash
# CI运行完成后
gh run list --limit 1
# 应该看到: "conclusion": "success"

# 检查生产环境getPlatformTimeout
curl https://www.arenafi.org/api/cron/batch-enrich?period=test
# 应该使用新的超时配置（30s/60s/120s/180s）
```

#### 4. 监控Pipeline恢复
```bash
node scripts/openclaw/pipeline-health-monitor.mjs
```
**预期结果**:
- cleanup-stuck-logs自动清理卡住任务
- batch-enrich使用新的平台特定超时，不再全部超时
- 失败任务数降至个位数

## 预防措施

### 1. Pre-commit Hook：检查迁移版本重复
```bash
# .git/hooks/pre-commit
MIGRATIONS_DIR="supabase/migrations"
VERSIONS=$(ls "$MIGRATIONS_DIR"/*.sql | xargs basename | sed 's/_.*//' | sort)
DUPLICATES=$(echo "$VERSIONS" | uniq -d)
if [ -n "$DUPLICATES" ]; then
  echo "ERROR: Duplicate migration versions: $DUPLICATES"
  exit 1
fi
```

### 2. GitHub Actions：增强验证
- ✅ 已有迁移版本重复检查（在CI中）
- 但需要在本地也运行，避免push后才发现

### 3. 环境变量检查脚本
```bash
# scripts/check-env.sh
required_vars=("NEXT_PUBLIC_SUPABASE_URL" "SUPABASE_SERVICE_ROLE_KEY")
for var in "${required_vars[@]}"; do
  if [ -z "${!var}" ]; then
    echo "❌ Missing: $var"
    echo "Run: set -a; source .env; set +a"
    exit 1
  fi
done
```

### 4. cleanup-stuck-logs：增强可靠性
**现有机制**: 每15分钟cron运行
**建议增强**:
- 添加心跳检查：每次cron运行时记录时间戳
- 如果cleanup-stuck-logs自己卡住>30分钟，发送警报
- 考虑使用数据库触发器自动清理

## 时间线

| 时间 | 事件 | 根因 |
|------|------|------|
| 09:06 | commit 895b7bfae "CRITICAL FIX" | ✅ 代码正确 |
| 16:06 | CI失败 | ❌ 重复迁移版本号 |
| 16:07-16:09 | 后续3次push，全部CI失败 | ❌ 同样问题 |
| 10:00 | 健康检查报告critical | ❌ 修复未部署 |
| 10:07 | 修复迁移版本号并push | ✅ |
| 10:07+ | CI运行中，待验证 | 🔄 |

## 教训

1. **永远验证部署状态** - 声称"全部修复"前，必须检查CI成功
2. **CI失败必须立即修复** - 不能让失败的CI堆积
3. **环境变量加载** - 本地脚本必须显式加载.env
4. **迁移文件命名** - 使用完整时间戳避免冲突（YYYYMMDDHHmmss_name.sql）
5. **自动化验证** - pre-commit hook检查常见错误

## 下一步行动

1. ⏳ 等待CI完成（ETA: 2分钟）
2. ✅ 验证部署成功
3. ✅ 检查Pipeline健康状态
4. ✅ 添加pre-commit hook
5. ✅ 写文档：标准迁移文件命名规范
