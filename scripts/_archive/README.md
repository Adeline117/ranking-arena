# scripts/_archive

用于归档低风险、临时性、未被引用的脚本；默认不硬删除，便于恢复。

## 目录说明

- `root-checks/`: 原仓库根目录下的一次性检查/测试脚本
- `legacy-tests/`: `scripts/` 下历史 `_test-*` 临时脚本

## 恢复方式

1. 从归档目录将文件移回原路径
2. 运行 `pnpm tsc --noEmit` 验证
3. 如脚本需要，执行对应 smoke test
