# pty-bridge

[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20macOS%20%7C%20Windows-blue)]()

通过 CLI 管理交互式终端会话（SSH、REPL、数据库、TUI 应用），专为需要 PTY 能力的 AI Agent 设计。

从 GitHub 安装。`@lydell/node-pty` 会按平台自动选择预编译原生二进制——无需编译，无需手动处理平台差异。

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

- `exec` 命令组合 write + enter + wait + read 为一步；`--wait-exit` 只返回命令本身的输出（去掉回显、sentinel 和提示符）
- `--wait-for-idle` 等输出稳定再返回，不用硬猜该等多久
- `waitFor` 支持等特定字符串出现，增量匹配（200ms 轮询）

### 其他

- SSH keepalive 长连接自动保活
- 完整的按键映射：enter、tab、escape、方向键、ctrl-a 到 ctrl-z 等
- 跨平台：macOS、Linux、Windows 原生都支持

## 安装

```bash
npm i -g github:briqt/pty-bridge --install-links
```

必须带 `--install-links`，否则平台对应的 `@lydell/node-pty-*` 二进制不会被正确链接。

要求：Node.js 18+。支持 macOS、Linux、Windows。

## 作为 Agent Skill 使用

[`skill/SKILL.md`](skill/SKILL.md) 为 Claude Code、Cursor 等 Agent 提供 CLI 用法。它调用 PATH 上的 `pty-bridge` 二进制（即上面的 GitHub 全局安装），不内置运行时。

```bash
npx skills add briqt/pty-bridge -g
```

## 快速开始

```bash
# 开一个 SSH 会话，起个名字代替 id
pty-bridge start ssh user@host --keepalive 30 --name remote

# 执行命令并等到退出（只返回命令输出）
pty-bridge exec remote "ls -la" --wait-exit

# 开一个 Python REPL（不要用 --wait-exit）
pty-bridge start python3 --name py
pty-bridge exec py "print('hello')"

# 用完销毁
pty-bridge kill remote
pty-bridge kill py
```

Agent 用法见 [`skill/SKILL.md`](skill/SKILL.md)，全部选项见 `pty-bridge <command> --help`。

## 架构

- **Daemon**：首次 `start` 自动启动，通过 Unix socket / Named Pipe 管理 PTY 会话
- **Client**：轻量 CLI，向 daemon 发送命令
- **Sessions**：每个会话独立 PTY + xterm.js headless terminal 解析输出
- **Name**：可选的稳定名字（`start --name`），凡是能写 id 的地方都能用
- **Owner**：可选的锁（`start --owner`）；修改加锁的会话需要对应 owner 或 `--force`
- **Tombstone**：daemon 崩溃后 `list` / `status` 会声明丢失了哪些会话

daemon 在 5 分钟无活跃会话后自动退出。

## 开发

```bash
git clone https://github.com/briqt/pty-bridge.git
cd pty-bridge
npm install
npm test
```

编辑 `src/*.ts`，运行 `npm run build`，本地测试（`node dist/cli.js status`）。请提交 `dist/`——从 GitHub 安装用的是编译后的 JS，没有单独的发布步骤。

## License

MIT

## 社区

分享于 [LINUX DO](https://linux.do/)


## 1.5.0 diagnostics and reliable continuation

```bash
npm i -g github:briqt/pty-bridge --install-links
npx skills add briqt/pty-bridge -g -y
pty-bridge --version
pty-bridge doctor --json
```

Raw cursors are absolute UTF-8 byte offsets; bounded reads preserve every returned
byte and report eviction through `lostBytes`. Rendered cursors may include a byte
column (`line:column`). Pass the returned cursor unchanged to `read --from`.
Subcommand help, `start --json`, and `list --owner NAME --alive-only --json` are supported.
Keep the session id or name across agent tool calls; repeat the owner only for locked sessions. A CLI update preserves
active daemons/sessions; doctor exposes the running daemon version separately.


### Dependency review (2026-11-22)

- `@xterm/headless` 6.0.0 and TypeScript 7.0.2 are already the latest stable releases.
- Upgrade `@types/node` to stable 26.6.6; compiled runtime targets remain ES2022.
- Keep `@lydell/node-pty` exactly at npm's current latest 1.2.0-beta.18. This is an
  intentional exception to the stable-only preference: the maintainer explains
  that the older stable-labelled 1.1.0 was based on node-pty 1.1.0-beta14, and that
  the later 1.2 beta repackaging fixed problems in the official 1.1.0 prebuilds.
  Do not downgrade based only on the absence of a beta suffix. The pinned package
  ships matching prebuilt binaries for Linux/macOS/Windows, x64/arm64.

Source: [maintainer's versioning explanation](https://github.com/lydell/node-pty/releases/tag/v1.2.0-beta.3).


Version 1.5.1 fixes native Windows daemon startup: lock files are stored beside the
state file, outside the named-pipe namespace. RPC streams also preserve UTF-8 when
transport chunks split within a character. Windows users should use 1.5.1 or later.

## 版本检查（1.6.0+）

`pty-bridge check-update --json` 显式查询最新稳定 Release，不启动 daemon。
成功的 `start`、`list`、`status` 最多每小时自动检查一次，网络预算 2 秒，失败
5 分钟后重试，同一版本的提醒间隔 24 小时。自动通知仅写 stderr，不改变业务
输出和退出码。帮助、版本、doctor 和高频终端 I/O 不自动联网。

可通过子命令前的 `--no-update-check`、`PTY_BRIDGE_NO_UPDATE_CHECK=1`，或
`~/.config/agent-skills/pty-bridge/config.json` 中的
`{"disable_update_check":true}` 禁用；任一禁用设置生效，显式检查同样遵守。
配置缺失使用默认值，配置无效时自动检查静默跳过、显式检查报告错误。

CLI 和 Skill 分别更新；运行中的 daemon 不会被安装操作重启。升级后运行
`pty-bridge --version` 和 `pty-bridge doctor --json` 核对，不为升级中断其他
会话。完整说明见 [skill/references/updates.md](skill/references/updates.md)。

## Exec 输出、会话名与可选锁（1.7.0+）

```bash
pty-bridge start bash --name build
pty-bridge exec build "make test" --wait-exit     # stdout：只有 make 的输出
# stderr：[status=done exitCode=0]
```

- `exec --wait-exit` 只返回命令本身的输出：命令回显（包括折成多行的长命令）、sentinel
  和随后重绘的提示符都会去掉；末尾不带换行的输出会保留。窄终端里被折行的 sentinel
  能立即识别，不再空等到超时。1.7.1 起输出的首尾边界都由 shell 自己打印，命令包在
  `{ …\n}` 中执行：行尾注释、结尾的 `;`/`&`、heredoc 都能原样使用。
- 元数据只输出有用的字段：还有内容可读时给 cursor，截断时给字节数，进程退出时给
  `alive=false`，输出被淘汰时给 `lostBytes`。
- `start --name <name>` 给会话一个稳定的名字，凡是能写 id 的地方都能写名字。名字在
  存活会话中唯一，且不能长得像 id。
- 会话默认不加锁；只有用 `--owner` 或 `PTY_BRIDGE_OWNER` 启动时才加锁，加锁的会话
  每次修改操作仍需带 owner（或 `--force`）。旧版 CLI 默认锁给系统用户的会话，无需额外
  参数即可继续使用。
