#!/bin/bash
# MCP 环境变量设置脚本
# 此脚本会帮助你在 shell 配置文件中设置 MCP 所需的环境变量

echo "🔧 MCP 环境变量设置工具"
echo ""

# 检测 shell 类型
if [ -n "$ZSH_VERSION" ]; then
    SHELL_CONFIG="$HOME/.zshrc"
    SHELL_NAME="zsh"
elif [ -n "$BASH_VERSION" ]; then
    SHELL_CONFIG="$HOME/.bashrc"
    SHELL_NAME="bash"
else
    echo "⚠️  未识别的 shell，默认使用 .zshrc"
    SHELL_CONFIG="$HOME/.zshrc"
    SHELL_NAME="zsh"
fi

echo "检测到 shell: $SHELL_NAME"
echo "配置文件: $SHELL_CONFIG"
echo ""

# 检查配置文件是否存在
if [ ! -f "$SHELL_CONFIG" ]; then
    echo "📝 创建新的配置文件: $SHELL_CONFIG"
    touch "$SHELL_CONFIG"
fi

# 检查是否已存在环境变量设置
if grep -q "GITHUB_TOKEN" "$SHELL_CONFIG"; then
    echo "⚠️  检测到已存在 GITHUB_TOKEN 配置"
else
    echo ""
    echo "请提供以下信息（如果暂时没有，可以先设置占位符）："
    echo ""
    
    # 询问 GitHub Token
    read -p "GitHub Personal Access Token (按 Enter 跳过): " github_token
    if [ -n "$github_token" ]; then
        echo "" >> "$SHELL_CONFIG"
        echo "# MCP GitHub Token (设置于 $(date +%Y-%m-%d))" >> "$SHELL_CONFIG"
        echo "export GITHUB_TOKEN=\"$github_token\"" >> "$SHELL_CONFIG"
        echo "✅ 已添加 GITHUB_TOKEN 到 $SHELL_CONFIG"
    else
        echo "⏭️  跳过 GITHUB_TOKEN 设置"
        echo "# MCP GitHub Token (未设置)" >> "$SHELL_CONFIG"
        echo "# export GITHUB_TOKEN=\"your_github_token_here\"" >> "$SHELL_CONFIG"
    fi
fi

if grep -q "BRAVE_API_KEY" "$SHELL_CONFIG"; then
    echo "⚠️  检测到已存在 BRAVE_API_KEY 配置"
else
    # 询问 Brave API Key
    read -p "Brave Search API Key (按 Enter 跳过): " brave_key
    if [ -n "$brave_key" ]; then
        echo "" >> "$SHELL_CONFIG"
        echo "# MCP Brave Search API Key (设置于 $(date +%Y-%m-%d))" >> "$SHELL_CONFIG"
        echo "export BRAVE_API_KEY=\"$brave_key\"" >> "$SHELL_CONFIG"
        echo "✅ 已添加 BRAVE_API_KEY 到 $SHELL_CONFIG"
    else
        echo "⏭️  跳过 BRAVE_API_KEY 设置"
        echo "# MCP Brave Search API Key (未设置)" >> "$SHELL_CONFIG"
        echo "# export BRAVE_API_KEY=\"your_brave_api_key_here\"" >> "$SHELL_CONFIG"
    fi
fi

echo ""
echo "📋 设置完成！"
echo ""
echo "💡 下一步操作："
echo "1. 如果设置了新的环境变量，请运行: source $SHELL_CONFIG"
echo "2. 或者重新打开终端窗口"
echo "3. 重启 Cursor 以使 MCP 服务器识别新的环境变量"
echo ""
echo "📖 如何获取 API 密钥："
echo ""
echo "GitHub Token:"
echo "  1. 访问: https://github.com/settings/tokens"
echo "  2. 点击 'Generate new token (classic)'"
echo "  3. 选择必要的权限（至少需要 'repo' 权限）"
echo "  4. 复制生成的 token"
echo ""
echo "Brave Search API Key:"
echo "  1. 访问: https://api.search.brave.com/"
echo "  2. 注册账号并创建 API Key"
echo "  3. 复制生成的 API Key"
echo ""
