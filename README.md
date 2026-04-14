# Xiaohaha MCP

让 Cursor AI 在一次对话里持续工作。当前版本只保留一种接入方式：

- Xiaohaha 作为本机常驻 MCP 服务在后台运行
- Cursor 通过 `Streamable HTTP` 连接 `http://127.0.0.1:13456/mcp`
- 关闭或多开 Cursor 不再重启/杀掉 Xiaohaha 服务

同时支持两种交互壳：

- 浏览器聊天壳：`http://127.0.0.1:13456/`
- Cursor 内嵌 MCP App 聊天壳

## 架构说明

旧方案是 `stdio` 子进程模式，生命周期绑定在 Cursor 实例上；多开实例、关闭窗口、端口抢占都会互相影响。

现在改成：

- 后台常驻本地服务：Node.js 进程单独运行
- 单一入口：同一服务同时提供浏览器页、MCP endpoint、状态检查
- Cursor 只负责连接：`mcp.json` 中只写 `url`

这也是更适合长期使用和多项目复用的方式。

## 快速开始（macOS 推荐）

### 前置要求

- macOS
- Node.js 22+
- Cursor
- 推荐安装：`ripgrep`（命令名 `rg`）

说明：

- 本项目不需要额外安装“代码搜索服务”。
- 推荐安装 `ripgrep`，MCP App 在“根据粘贴代码定位原文件”和输入 `@` 搜索项目文件时会更快、更稳定。
- 没安装 `ripgrep` 也能运行，程序会自动回退到 Node.js 文件扫描，只是更慢、扫描范围也更保守。
- 也就是说：`@` 搜索文件时，`rg` 不是必须安装，但装了体验会明显更好。
- macOS 安装 `ripgrep`：

```bash
brew install ripgrep
```

### 命令执行位置

文档里的 `npm run service:*` 默认都表示在**仓库根目录**执行：

```bash
cd /path/to/xiaohaha-mcp
npm run service:status
```


### 1. 安装依赖并构建 App UI

```bash
cd /path/to/xiaohaha-mcp
npm install
npm run build:app
```

### 2. 安装并启动后台服务

```bash
npm run service:install
```

这一步会：

- 生成 `launchd` 配置
- 将运行时文件复制到 `~/.xiaohaha-mcp/runtime`
- 将会话状态保存到 `~/.xiaohaha-mcp/data`
- 注册后台服务
- 立即启动服务

安装完成后可用下面命令检查状态：

```bash
npm run service:status
```

### 3. 配置 Cursor 连接本地 MCP

如果你希望所有项目都能使用 Xiaohaha，在 `~/.cursor/mcp.json` 中加入：

```json
{
  "mcpServers": {
    "xiaohaha-mcp": {
      "url": "http://127.0.0.1:13456/mcp"
    }
  }
}
```

如果你只想在某个项目里用，也可以在该项目的 `.cursor/mcp.json` 中写同样的配置。

本仓库已经自带项目级 [.cursor/mcp.json](./.cursor/mcp.json)，打开本仓库时会直接连到本机服务。

### 4. 配置 Cursor User Rules

为了让 Agent 每次回复后自动继续等待下一条消息，请把下面内容放进 Cursor 的 **User Rules**：

路径：

- Cursor Settings → Rules → User Rules

正文：

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

## 日常管理

后台服务统一通过 `launchd` 管理：

```bash
cd /path/to/xiaohaha-mcp
npm run service:status
npm run service:start
npm run service:stop
npm run service:restart
npm run service:uninstall
```

说明：

- `install`：写入并加载 `launchd` 配置，同时启动服务
- `start`：启动已安装服务
- `stop`：停止服务，但保留安装配置
- `restart`：重启服务，改代码后常用
- `status`：查看 `launchd` 加载状态和服务健康状态
- `uninstall`：卸载 `launchd` 服务

如果你不想先 `cd` 到仓库目录，也可以在任意目录执行：

```bash
node /path/to/xiaohaha-mcp/scripts/service.js status
node /path/to/xiaohaha-mcp/scripts/service.js start
node /path/to/xiaohaha-mcp/scripts/service.js stop
node /path/to/xiaohaha-mcp/scripts/service.js restart
node /path/to/xiaohaha-mcp/scripts/service.js uninstall
```

## 日常使用

1. 在 Cursor 中正常发起一次 Agent 对话
2. AI 完成回复后，它会调用 `check_messages`
3. 后续消息可以从两个入口继续发：
   - 浏览器页：`http://127.0.0.1:13456/`
   - Cursor 内嵌 Xiaohaha App
4. 如果同时存在多个会话，浏览器页顶部可以切换目标会话，再继续发送消息
5. 在 Cursor 内嵌 Xiaohaha App 输入框里输入 `@`，可以按项目相对路径搜索并引用当前工作区文件
6. 这个 `@` 文件搜索功能会优先使用 `ripgrep`（`rg`）；如果本机没装，会自动回退到内置扫描，不会因为缺少 `rg` 而不可用
7. AI 处理完后继续等待下一条指令，如此循环

## 开发与维护

### 修改前端 App 后

```bash
npm run build:app
npm run service:restart
```

### 查看日志

`launchd` 日志默认写到：

- `~/Library/Logs/xiaohaha-mcp.out.log`
- `~/Library/Logs/xiaohaha-mcp.err.log`

服务运行目录：

- `~/.xiaohaha-mcp/runtime`

服务数据目录：

- `~/.xiaohaha-mcp/data`

### 前台调试运行

如果你只是临时在当前终端里调试服务，可以直接：

```bash
npm start
```

注意：

- 如果 `launchd` 后台服务还在运行，直接 `npm start` 会因为同样占用 `127.0.0.1:13456` 而启动失败；调试前先执行 `npm run service:stop`，或改用不同端口
- `npm start` 默认把状态文件写在仓库目录下；如果你想复用 `launchd` 服务的数据目录，请先设置 `XIAOHAHA_HOME=~/.xiaohaha-mcp/data`

## 连接信息

- MCP endpoint：`http://127.0.0.1:13456/mcp`
- 浏览器聊天页：`http://127.0.0.1:13456/`
- 状态接口：`http://127.0.0.1:13456/status`
- 健康检查：`http://127.0.0.1:13456/healthz`

## 注意事项

- 需要 Node.js 22+
- 默认监听 `127.0.0.1:13456`
- 可通过环境变量 `XIAOHAHA_MCP_HOST` 和 `XIAOHAHA_MCP_PORT` 调整监听地址
- 修改 `app/mcp-chat-ui.js` 后必须重新执行 `npm run build:app`
- 只要后台服务还在，关闭任意一个 Cursor 实例都不会把 Xiaohaha 服务带停
