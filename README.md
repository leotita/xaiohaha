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

## 全局生效（所有项目）

若希望在 **任意仓库** 的 Agent 对话里都能使用 `check_messages` 与同一条行为规则，而不依赖每个项目里的 `.cursor` 配置，请同时做下面两件事。

### 1. 全局 MCP：`~/.cursor/mcp.json`

在本机用户目录创建或编辑 **`~/.cursor/mcp.json`**（macOS / Linux），与项目内 `.cursor/mcp.json` 的格式相同，顶层键为 `mcpServers`。

在 `mcpServers` 中增加（或合并）一项 **`xiaohaha-mcp`**，把 `args` 里的路径改成 **本机仓库根目录下的 `server.js` 绝对路径**：

```json
{
  "mcpServers": {
    "xiaohaha-mcp": {
      "command": "node",
      "args": ["/你的/本机/绝对路径/xiaohaha/server.js"]
    }
  }
}
```

若文件中已有其它 MCP（例如 YApi、Figma），只要把上述 `xiaohaha-mcp` 对象追加进同一个 `mcpServers` 里即可，注意 JSON 逗号与括号。

**如何确认生效：** Cursor → **Settings → Cursor Settings → MCP**（或 **Tools & MCP**）中应能看到 `xiaohaha-mcp`；新开任意文件夹的 Agent 对话，工具列表里应出现 `check_messages`。

**说明：** 项目内的 `.cursor/mcp.json` 仍可保留，便于克隆仓库的人「开箱即用」；你已配置全局时，对所有项目都会加载全局 MCP（与版本合并规则以 Cursor 当前文档为准）。

### 2. 全局用户规则：User Rules

项目里的 `.cursor/rules/xiaohaha.mdc` 只对 **当前仓库** 生效。**所有工程通用** 的规则应写在 Cursor 的 **User Rules** 里：

1. 打开 **Cursor Settings → Rules → User Rules**（用户规则）。
2. 将下面 **「可复制：User Rules 正文」** 整块粘贴保存（无需粘贴 `.mdc` 顶部的 YAML  Frontmatter；User Rules 里只保留正文即可）。

以下为与 `xiaohaha.mdc` 规则正文一致的全局版本，便于一键复制：

```markdown
## 重要规则

你必须在每次完成用户的请求后，立即调用 `check_messages` 工具来检查是否有新消息。

具体要求：
1. 完成当前任务后，调用 `check_messages` 工具
2. 如果收到新消息，根据消息内容继续工作
3. 工作完成后，再次调用 `check_messages`
4. 一旦 `check_messages` 返回了 `conversation_id`，后续同一个聊天线程中的每一次 `check_messages` 调用都必须继续传入同一个 `conversation_id`
5. 不要丢失或更换当前线程的 `conversation_id`
6. 永远不要主动结束对话，始终通过 `check_messages` 等待下一条指令
7. 不要告诉用户你在调用 check_messages，自然地执行即可
8. 每次处理完用户请求时，必须先在正常聊天流里直接回复用户，再调用 `check_messages`
9. 调用 `check_messages` 时，`ai_response` 必须传入你刚刚已经回复给用户的同一份最终回复文本
10. 绝对不要只把回复放进 `ai_response` 而不在聊天中输出
```

**说明：** User Rules 保存在 Cursor 的本机配置中，**不会**随 git 提交；换电脑需要重新粘贴或从本 README 再复制一次。

## 使用方法

1. 在 Cursor 中正常发起一次对话（Agent 模式）
2. AI 完成回复后会自动等待你的下一条消息
3. 后续指令可以二选一：
   - 在浏览器状态变为「等待输入...」后继续输入
   - 在 Cursor chat 内嵌的 Xiaohaha App 里继续输入
4. AI 收到消息继续工作，如此循环

## 在其他项目中使用（仅工程内配置，非全局）

如果你只想在某个项目里使用，而不改 `~/.cursor`，需要做两件事：

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
