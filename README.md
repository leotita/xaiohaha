# Xiaohaha MCP — Cursor 额度放大器（免费版）

让 Cursor AI 在一次对话中持续工作。现在同时支持：

- 浏览器聊天壳：通过本地网页发送后续消息
- MCP App 聊天壳：直接在 Cursor chat 内嵌 UI 里继续发后续消息

## 快速开始（3 步）

### 1. 安装依赖并构建 MCP App

```bash
cd xiaohaha-mcp
npm install
npm run build:app
```

### 2. 用 Cursor 打开本文件夹

直接用 Cursor 打开 `xiaohaha-mcp` 这个文件夹即可。MCP 服务和 AI 规则已经预配置好，无需手动修改任何配置。

### 3. 打开浏览器对话或直接使用 Cursor 内嵌 UI

浏览器访问 **http://localhost:3456**，即可看到聊天界面。

如果你使用的是带 `check_messages` 工具的 Agent 会话，AI 第一次回复后，Cursor chat 中也会直接出现一个内嵌的 Xiaohaha MCP App 聊天 UI。

## 使用方法

1. 在 Cursor 中正常发起一次对话（Agent 模式）
2. AI 完成回复后会自动等待你的下一条消息
3. 后续指令可以二选一：
   - 在浏览器状态变为「等待输入...」后继续输入
   - 在 Cursor chat 内嵌的 Xiaohaha App 里继续输入
4. AI 收到消息继续工作，如此循环

## 在其他项目中使用

如果你想在自己的项目里使用，需要做两件事：

**1. 配置 MCP**：在你的项目 `.cursor/mcp.json` 中添加：

```json
{
  "mcpServers": {
    "xiaohaha-mcp": {
      "command": "node",
      "args": ["xiaohaha-mcp 文件夹的完整路径/server.js"]
    }
  }
}
```

**2. 复制规则文件**：把本项目的 `.cursor/rules/xiaohaha.mdc` 复制到你项目的 `.cursor/rules/` 下。

## 注意事项

- 需要 Node.js 22+
- 推荐安装 [ripgrep](https://github.com/BurntSushi/ripgrep)（`brew install ripgrep`），用于粘贴代码时快速定位文件名和行号。未安装时会自动回退到 Node.js 搜索
- 默认端口 3456，可通过环境变量 `XIAOHAHA_MCP_PORT` 修改
- 仅本地使用，无需联网，无需后端服务，无需注册
- 修改 `app/mcp-chat-ui.js` 后，需要重新执行 `npm run build:app`
