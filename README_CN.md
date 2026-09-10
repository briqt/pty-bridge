# pty-bridge

[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20macOS%20%7C%20Windows-blue)]()

通过 CLI 管理交互式终端会话（SSH、REPL、数据库、TUI 应用），专为需要 PTY 能力的 AI Agent 设计。

发布为 npm 包，通过 `@lydell/node-pty` 按平台自动选择预编译的原生二进制——无需编译，无需手动处理平台差异。

**[English](README.md)**

## 相对于直接操作 shell 或自己拼 PTY，本项目多了什么

### 真正的 PTY 会话

- SSH、vim、mysql、python REPL、htop 这些交互式工具都能正常交互
- Agent 拿到的是 xterm.js 解析后的干净文本，没有乱码和控制字符
- 每个会话独立 PTY，互不干扰

### Daemon 后台常驻

- 首次 `start` 自动启动 daemon，通过 Unix socket（macOS/Linux）或 Named Pipe（Windows）通信
- 会话跑在后台进程里，Agent 断了会话不丢，重连继续读输出
- 后台跑长任务也不怕
- 5 分钟无活跃会话自动退出

### 双缓冲区支持

- 自动追踪 normal 和 alternate buffer 的读取游标
- vim、htop 这类 TUI 切换 buffer 不丢内容
- `read` 支持指定 `--buffer normal/alternate/active`

### Snapshot 截屏

- Agent 能拿到当前屏幕的完整快照：每行内容、光标位置、当前 buffer 类型
- 操作 TUI 应用的时候看一眼就知道当前状态

### Smart Exec

- `exec` 命令组合 write + enter + wait + read 为一步
- `--wait-for-idle` 等输出稳定再返回，不用硬猜该等多久
- `waitFor` 支持等特定字符串出现，增量匹配（200ms 轮询）

### 其他

- SSH keepalive 长连接自动保活
- 完整的按键映射：enter、tab、escape、方向键、ctrl-a 到 ctrl-z 等
- 跨平台：macOS、Linux、Windows 原生都支持

## 安装

直接运行，无需安装：

```bash
npx -y pty-bridge status
```

或全局安装：

```bash
npm i -g pty-bridge
```

要求：Node.js 18+。支持 macOS、Linux、Windows。

## 作为 Agent Skill 使用

[`skill/SKILL.md`](skill/SKILL.md) 是一个 Agent skill 文件，为 Claude Code、Kiro CLI 等 Agent 提供 CLI 使用指南。它基于已发布的 npm 包（通过 `npx -y pty-bridge` 或全局二进制调用），不包含任何运行时。

```bash
npx skills add briqt/pty-bridge -g
```

## 快速开始

```bash
export PTY_BRIDGE_OWNER="my-agent"

# 开一个 SSH 会话
pty-bridge start ssh user@host --keepalive 30 --owner "$PTY_BRIDGE_OWNER"

# 执行命令并等到退出
pty-bridge exec <id> "ls -la" --wait-exit

# 开一个 Python REPL（不要用 --wait-exit）
pty-bridge start python3
pty-bridge exec <id> "print('hello')"

# 用完销毁
pty-bridge kill <id>
```

完整命令参考见 [`skill/SKILL.md`](skill/SKILL.md)（owner、`--raw`、截断续读、daemon 重启丢失声明）。

## 架构

- **Daemon**：首次 `start` 自动启动，通过 Unix socket / Named Pipe 管理 PTY 会话
- **Client**：轻量 CLI，向 daemon 发送命令
- **Sessions**：每个会话独立 PTY + xterm.js headless terminal 解析输出
- **Owner**：会话带所有者；写别人的会话默认拒绝，需 `--force`
- **Tombstone**：daemon 崩溃后 `list` / `status` 会声明丢失了哪些会话

daemon 在 5 分钟无活跃会话后自动退出。

## 开发

```bash
git clone https://github.com/briqt/pty-bridge.git
cd pty-bridge
npm install      # 安装依赖 + 开发依赖
npm test         # tsc → dist/ 后跑 integration 测试
```

编辑 `src/*.ts`，运行 `npm run build`，本地测试（如 `node dist/cli.js status`）。

### 发布

```bash
npm publish      # prepublishOnly 会跑测试（含构建）；files: ["dist"] 只发布编译后的 JS
```

原生二进制不在仓库里——npm 通过 optional dependencies 按平台解析对应的 `@lydell/node-pty-<platform>` 包。

## License

MIT

## 社区

分享于 [LINUX DO](https://linux.do/)
