# MCP 环境变量设置指南

本文档说明如何为 MCP（Model Context Protocol）服务器设置所需的环境变量。

## 快速设置

运行自动化设置脚本：

```bash
./scripts/setup-mcp-env.sh
```

脚本会引导你完成设置过程。

## 手动设置

### 方法一：在 Shell 配置文件中设置（推荐）

#### 对于 Zsh（macOS 默认）

1. 编辑 `~/.zshrc` 文件：
   ```bash
   nano ~/.zshrc
   ```

2. 添加以下内容：
   ```bash
   # MCP GitHub Token
   export GITHUB_TOKEN="your_github_token_here"
   
   # MCP Brave Search API Key
   export BRAVE_API_KEY="your_brave_api_key_here"
   ```

3. 保存并重新加载配置：
   ```bash
   source ~/.zshrc
   ```

#### 对于 Bash

1. 编辑 `~/.bashrc` 或 `~/.bash_profile`：
   ```bash
   nano ~/.bashrc
   ```

2. 添加相同的内容（如上所示）

3. 重新加载配置：
   ```bash
   source ~/.bashrc
   ```

### 方法二：在当前会话中临时设置

```bash
export GITHUB_TOKEN="your_github_token_here"
export BRAVE_API_KEY="your_brave_api_key_here"
```

⚠️ **注意**：此方法仅在当前终端会话有效，关闭终端后会丢失。

### 方法三：在 Cursor 中设置（如果支持）

某些情况下，Cursor 可以直接读取项目根目录的 `.env` 文件。你可以在项目根目录创建 `.env.mcp` 文件（不会被 git 跟踪）：

```bash
# .env.mcp (在项目根目录)
GITHUB_TOKEN=your_github_token_here
BRAVE_API_KEY=your_brave_api_key_here
```

然后在 shell 配置文件中加载它：
```bash
# 在 ~/.zshrc 中添加
if [ -f "$HOME/path/to/ranking-arena/.env.mcp" ]; then
    export $(cat "$HOME/path/to/ranking-arena/.env.mcp" | xargs)
fi
```

## 如何获取 API 密钥

### GitHub Personal Access Token

1. 访问 [GitHub Token 设置页面](https://github.com/settings/tokens)
2. 点击 **"Generate new token"** → **"Generate new token (classic)"**
3. 填写 Token 描述（例如：`MCP GitHub Server`）
4. 选择过期时间
5. 选择必要的权限：
   - 至少需要 `repo` 权限（用于访问仓库信息）
   - 根据需求可选：`read:org`, `read:user`, `read:gpg_key` 等
6. 点击 **"Generate token"**
7. **重要**：立即复制 token，因为它只显示一次

### Brave Search API Key

1. 访问 [Brave Search API 页面](https://api.search.brave.com/)
2. 注册账号（如果需要）
3. 登录后进入 Dashboard
4. 创建新的 API Key
5. 复制生成的 API Key

## 验证设置

运行检查脚本验证环境变量是否已正确设置：

```bash
node scripts/test-mcp.mjs
```

或者手动检查：

```bash
echo $GITHUB_TOKEN
echo $BRAVE_API_KEY
```

如果输出为空，说明环境变量未设置。

## 使设置生效

1. **重新加载 Shell 配置**：
   ```bash
   source ~/.zshrc  # 对于 zsh
   source ~/.bashrc  # 对于 bash
   ```

2. **重启 Cursor**：
   - 完全关闭 Cursor 应用
   - 重新打开 Cursor
   - MCP 服务器会在启动时读取环境变量

3. **检查 MCP 日志**：
   - 在 Cursor 中打开 `View → Output`
   - 选择 `MCP Logs` 通道
   - 查看是否有连接错误

## 故障排除

### 问题：环境变量设置了但仍然不工作

1. **检查变量名是否正确**：
   - 确保变量名是 `GITHUB_TOKEN`（不是 `GITHUB_PERSONAL_ACCESS_TOKEN`）
   - 确保变量名是 `BRAVE_API_KEY`

2. **检查 Shell 配置文件**：
   ```bash
   # 查看配置文件内容
   cat ~/.zshrc | grep -E "GITHUB_TOKEN|BRAVE_API_KEY"
   ```

3. **确认 Cursor 读取环境变量**：
   - Cursor 在启动时会读取当前 shell 的环境变量
   - 确保在启动 Cursor 之前已经设置了环境变量
   - 或者从已设置环境变量的终端中启动 Cursor

4. **查看 MCP 日志**：
   - 在 Cursor 中：`View → Output → MCP Logs`
   - 查找错误信息

### 问题：不想设置某些环境变量

完全没问题！如果不需要使用某个 MCP 服务器（如 GitHub 或 Brave Search），可以不设置对应的环境变量。

- 不设置 `GITHUB_TOKEN`：GitHub MCP 服务器无法工作，但不影响其他服务器
- 不设置 `BRAVE_API_KEY`：Brave Search MCP 服务器无法工作，但不影响其他服务器

其他服务器（Filesystem、Git、Puppeteer、Fetch）不需要环境变量即可正常工作。

## 安全建议

1. **不要将 Token/Key 提交到 Git**：
   - `.env` 文件已在 `.gitignore` 中
   - 不要在代码中硬编码密钥

2. **使用最小权限**：
   - GitHub Token 只授予必要的权限
   - 定期轮换密钥

3. **不要在共享环境中使用**：
   - 不要在公共或共享的计算机上设置生产密钥

## 相关文档

- [MCP 配置说明](./MCP_SETUP.md)
- [MCP 官方文档](https://modelcontextprotocol.io/)
