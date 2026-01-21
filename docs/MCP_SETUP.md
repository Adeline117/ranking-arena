# MCP (Model Context Protocol) 配置说明

## 概述

Model Context Protocol (MCP) 是一个开放协议，允许将外部工具和数据源与 Cursor 的 AI 代理集成。

## 配置文件位置

本项目使用项目级别的 MCP 配置，配置文件位于：
- `.cursor/mcp.json` - 项目级配置（仅在此工作区生效）

如果你想使用全局配置，可以在以下位置创建配置文件：
- `~/.cursor/mcp.json` - 全局配置（在所有项目中生效）

## 当前配置的 MCP 服务器

### 1. Filesystem（文件系统）
- **用途**: 提供对项目文件系统的访问
- **传输方式**: stdio
- **无需配置**: 开箱即用

### 2. Git
- **用途**: 提供 Git 仓库操作功能
- **传输方式**: stdio
- **无需配置**: 开箱即用

### 3. Puppeteer
- **用途**: 网页抓取和自动化
- **传输方式**: stdio
- **无需配置**: 开箱即用
- **注意**: 项目中已安装 puppeteer，此服务器可以提供浏览器自动化功能

### 4. Fetch
- **用途**: HTTP 请求工具
- **传输方式**: stdio
- **无需配置**: 开箱即用

### 5. GitHub
- **用途**: GitHub API 集成
- **传输方式**: stdio
- **需要配置**: 需要在环境变量中设置 `GITHUB_TOKEN`
- **设置方法**:
  ```bash
  export GITHUB_TOKEN=your_github_token_here
  ```

### 6. Brave Search
- **用途**: Brave Search API 集成
- **传输方式**: stdio
- **需要配置**: 需要在环境变量中设置 `BRAVE_API_KEY`
- **设置方法**:
  ```bash
  export BRAVE_API_KEY=your_brave_api_key_here
  ```

## 如何添加新的 MCP 服务器

### 方式一：通过配置文件

编辑 `.cursor/mcp.json`，添加新的服务器配置：

```json
{
  "mcpServers": {
    "your-server-name": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-name"],
      "env": {
        "API_KEY": "${env:YOUR_API_KEY}"
      }
    }
  }
}
```

### 方式二：通过 Cursor UI

1. 打开 **Cursor Settings → Features → MCP**
2. 点击 **"+ Add New MCP Server"**
3. 填写服务器信息：
   - **名称**: 服务器的昵称
   - **传输类型**: stdio, SSE 或 HTTP
   - **命令**（stdio）或 **URL**（SSE/HTTP）
4. 配置认证信息（如需要）

## 传输类型

### stdio（标准输入输出）
- 适用于本地进程
- 单用户使用
- 通过命令行通信
- **示例**: 本地工具、脚本

### SSE（Server-Sent Events）
- 适用于远程或本地 HTTP 服务器
- 支持多用户
- 需要 SSE 端点
- **示例**: 团队共享的服务

### HTTP（流式 HTTP）
- 传统的 HTTP 端点
- 支持流式响应
- 远程或本地
- **示例**: REST API 集成

## 环境变量支持

配置文件支持以下变量替换：

- `${env:VARIABLE_NAME}` - 环境变量
- `${workspaceFolder}` - 当前工作区根目录
- `${userHome}` - 用户主目录
- `${workspaceFolderBasename}` - 工作区文件夹名称
- `${pathSeparator}` - 路径分隔符

## 管理 MCP 服务器

### 查看已配置的服务器

```bash
cursor-agent mcp list
```

### 查看服务器提供的工具

```bash
cursor-agent mcp list-tools <server-identifier>
```

### 禁用服务器

```bash
cursor-agent mcp disable <server-identifier>
```

### 登录认证（如需要）

```bash
cursor-agent mcp login <server-identifier>
```

## 调试

如果遇到问题，可以查看 MCP 日志：

1. 在 Cursor 中打开 **View → Output**
2. 选择 **MCP Logs** 通道
3. 查看初始化错误、服务器崩溃或认证失败信息

## 安全建议

1. **使用环境变量**: 不要在配置文件中硬编码 API 密钥或令牌
2. **限制权限**: 审查 MCP 服务器的来源和功能
3. **本地优先**: 敏感数据处理优先使用 stdio 传输
4. **网络限制**: 远程服务器使用强认证和网络限制

## 示例：为本项目定制配置

由于这是一个 Next.js + Supabase 项目，你可能想要添加：

### Supabase MCP 服务器（如果可用）

```json
{
  "supabase": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-supabase"],
    "env": {
      "SUPABASE_URL": "${env:NEXT_PUBLIC_SUPABASE_URL}",
      "SUPABASE_KEY": "${env:SUPABASE_SERVICE_ROLE_KEY}"
    }
  }
}
```

### 数据库查询工具（如果有的话）

可以根据项目需求添加其他 MCP 服务器。

## 参考资源

- [Cursor MCP 文档](https://docs.cursor.com/context/model-context-protocol)
- [MCP 官方仓库](https://github.com/modelcontextprotocol)
- [MCP 服务器列表](https://github.com/modelcontextprotocol/servers)
