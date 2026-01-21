# MCP 环境变量快速设置指南

## ✅ 已完成

我已经在你的 `~/.zshrc` 文件中添加了 MCP 环境变量的配置模板。

## 📝 下一步操作

### 1. 获取 API 密钥（如果还没有）

**GitHub Token:**
1. 访问: https://github.com/settings/tokens
2. 点击 "Generate new token (classic)"
3. 选择必要的权限（至少需要 `repo` 权限）
4. 复制生成的 token

**Brave Search API Key:**
1. 访问: https://api.search.brave.com/
2. 注册账号并创建 API Key
3. 复制生成的 API Key

### 2. 编辑配置文件

打开 `~/.zshrc` 文件：

```bash
nano ~/.zshrc
```

找到文件末尾的 MCP 配置部分，取消注释并填入实际的密钥：

```bash
# 将这行：
# export GITHUB_TOKEN="your_github_token_here"

# 改为（使用你的实际 token）：
export GITHUB_TOKEN="ghp_xxxxxxxxxxxxxxxxxxxx"

# 将这行：
# export BRAVE_API_KEY="your_brave_api_key_here"

# 改为（使用你的实际 key）：
export BRAVE_API_KEY="BSA_xxxxxxxxxxxxxxxxxxxx"
```

### 3. 应用配置

```bash
# 重新加载配置
source ~/.zshrc

# 验证设置
echo $GITHUB_TOKEN
echo $BRAVE_API_KEY
```

### 4. 重启 Cursor

完全关闭并重新打开 Cursor，让 MCP 服务器识别新的环境变量。

### 5. 验证 MCP 部署

运行检查脚本：

```bash
node scripts/test-mcp.mjs
```

## 🚀 或者使用交互式脚本

运行自动化设置脚本：

```bash
./scripts/setup-mcp-env.sh
```

脚本会引导你输入密钥并自动配置。

## 💡 注意事项

- 如果暂时不需要某个服务（如 GitHub 或 Brave Search），可以不设置对应的环境变量
- 其他 MCP 服务器（Filesystem、Git、Puppeteer、Fetch）不需要环境变量即可正常工作
- 确保不要将密钥提交到 Git 仓库

## 📚 更多信息

查看详细文档：
- [MCP 环境变量设置指南](./MCP_ENV_SETUP.md)
- [MCP 配置说明](./MCP_SETUP.md)
