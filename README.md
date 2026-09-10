# pty-bridge

[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20macOS%20%7C%20Windows-blue)]()

Manage interactive terminal sessions (SSH, REPLs, databases, TUI apps) via a simple CLI. Designed for AI agents that need PTY support.

Published as an npm package. The matching prebuilt native binary (via `@lydell/node-pty`) is selected automatically per platform — no compile step, no manual platform handling.

**[中文文档](README_CN.md)**

## Install

Run it directly with no install:

```bash
npx -y pty-bridge status
```

Or install globally so the bare `pty-bridge` command is on PATH:

```bash
npm i -g pty-bridge
```

Requirements: Node.js 18+. Linux or macOS (Windows users: run inside WSL).

## Use as an agent skill

The [`skill/SKILL.md`](skill/SKILL.md) file is a thin agent skill that documents the CLI for Claude Code, Kiro CLI, and other compatible agents. It rides on the published npm package (it invokes `npx -y pty-bridge` / the global binary) rather than vendoring any runtime.

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
npm install      # installs deps + dev deps
npm test         # tsc → dist/, then integration tests
```

Edit `src/*.ts`, run `npm run build`, and test locally (e.g. `node dist/cli.js status`).

### Publishing

```bash
npm publish      # prepublishOnly runs tests (and the build); files: ["dist"] ships only compiled JS
```

The native binaries are not vendored — npm resolves the correct `@lydell/node-pty-<platform>` package at install time via optional dependencies.

## License

MIT

## Community

Shared on [LINUX DO](https://linux.do/)
