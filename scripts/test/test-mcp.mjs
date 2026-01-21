#!/usr/bin/env node
/**
 * MCP 服务器部署状态检查脚本
 * 检查配置的 MCP 服务器是否可用
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const MCP_CONFIG_PATH = join(process.cwd(), '.cursor', 'mcp.json');

console.log('🔍 检查 MCP 配置和部署状态...\n');

// 读取配置文件
let config;
try {
  const configContent = readFileSync(MCP_CONFIG_PATH, 'utf-8');
  config = JSON.parse(configContent);
  console.log('✅ MCP 配置文件存在');
} catch (error) {
  console.error('❌ 无法读取 MCP 配置文件:', error.message);
  process.exit(1);
}

const servers = config.mcpServers || {};
const serverNames = Object.keys(servers);

console.log(`\n📋 已配置 ${serverNames.length} 个 MCP 服务器:\n`);

// 检查每个服务器
for (const [name, serverConfig] of Object.entries(servers)) {
  console.log(`服务器: ${name}`);
  console.log(`  命令: ${serverConfig.command || 'N/A'}`);
  console.log(`  参数: ${(serverConfig.args || []).join(' ')}`);
  
  // 检查环境变量
  const envVars = serverConfig.env || {};
  const envKeys = Object.keys(envVars);
  if (envKeys.length > 0) {
    console.log(`  环境变量要求:`);
    for (const key of envKeys) {
      const value = envVars[key];
      const envVarName = value?.replace('${env:', '').replace('}', '') || key;
      const envValue = process.env[envVarName];
      if (envValue) {
        console.log(`    ✅ ${key}: ${envVarName} (已设置)`);
      } else {
        console.log(`    ⚠️  ${key}: ${envVarName} (未设置)`);
      }
    }
  }
  
  // 特定服务器检查
  if (name === 'github' && !process.env.GITHUB_TOKEN) {
    console.log(`  ⚠️  警告: GitHub MCP 需要 GITHUB_TOKEN 环境变量`);
  }
  
  if (name === 'brave-search' && !process.env.BRAVE_API_KEY) {
    console.log(`  ⚠️  警告: Brave Search MCP 需要 BRAVE_API_KEY 环境变量`);
  }
  
  console.log('');
}

console.log('📝 说明:');
console.log('  - 此脚本仅检查配置文件和环境变量');
console.log('  - 实际 MCP 服务器连接状态需要在 Cursor 中查看');
console.log('  - 查看 MCP 日志: View → Output → MCP Logs\n');

// 总结
const missingEnv = [];
for (const [name, serverConfig] of Object.entries(servers)) {
  const envVars = serverConfig.env || {};
  for (const [key, value] of Object.entries(envVars)) {
    const envVarName = value?.replace('${env:', '').replace('}', '') || key;
    if (!process.env[envVarName]) {
      missingEnv.push({ server: name, envVar: envVarName });
    }
  }
}

if (missingEnv.length > 0) {
  console.log('⚠️  缺少以下环境变量:');
  missingEnv.forEach(({ server, envVar }) => {
    console.log(`  - ${server}: ${envVar}`);
  });
  console.log('\n💡 提示: 设置环境变量后需要重启 Cursor 才能生效\n');
} else {
  console.log('✅ 所有必需的环境变量都已设置\n');
}
