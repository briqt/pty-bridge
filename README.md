# pty-bridge

[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20macOS%20%7C%20Windows-blue)]()

Manage interactive terminal sessions (SSH, REPLs, databases, TUI apps) via a simple CLI. Designed for AI agents that need PTY support.

Install from GitHub. The matching prebuilt native binary (via `@lydell/node-pty`) is selected automatically per platform — no compile step, no manual platform handling.

**[中文文档](README_CN.md)**

## Install

```bash
npm i -g github:briqt/pty-bridge --install-links
```

`--install-links` is required so the platform-specific `@lydell/node-pty-*` binary is actually linked.

Requirements: Node.js 18+. macOS, Linux, and Windows.

## Use as an agent skill

[`skill/SKILL.md`](skill/SKILL.md) documents the CLI for Claude Code, Cursor, and other compatible agents. It calls the `pty-bridge` binary from PATH (the GitHub global install above). It does not vendor a runtime.

```bash
npx skills add briqt/pty-bridge -g
```

## Quick Start

```bash
export PTY_BRIDGE_OWNER="my-agent"

# Start an SSH session
pty-bridge start ssh user@host --keepalive 30 --owner "$PTY_BRIDGE_OWNER"

# Run a shell command and wait until it exits
pty-bridge exec <id> "ls -la" --wait-exit

# Start a Python REPL (no --wait-exit)
pty-bridge start python3
pty-bridge exec <id> "print('hello')"

# Kill session when done
pty-bridge kill <id>
```

See [`skill/SKILL.md`](skill/SKILL.md) for the full command reference (owners, `--raw`, truncated reads, lost-session tombstones).

## Architecture

- **Daemon**: Auto-spawns on first `start`, manages PTY sessions via Unix socket
- **Client**: Thin CLI that sends commands to the daemon
- **Sessions**: Each session runs in its own PTY with xterm.js headless terminal for clean output
- **Owners**: Sessions are tagged; writes to another owner's session require `--force`
- **Tombstones**: If the daemon crashes, `list` / `status` report which sessions were lost

The daemon auto-exits after 5 minutes with no active sessions.

## Development

```bash
git clone https://github.com/briqt/pty-bridge.git
cd pty-bridge
npm install
npm test
```

Edit `src/*.ts`, run `npm run build`, and test locally (`node dist/cli.js status`). Commit `dist/` — GitHub installs use the compiled JS, not a publish step.

## License

MIT

## Community

Shared on [LINUX DO](https://linux.do/)
