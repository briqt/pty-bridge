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

[`skill/SKILL.md`](skill/SKILL.md) documents the CLI for compatible terminal-capable assistants. It calls the `pty-bridge` binary from PATH (the GitHub global install above). It does not vendor a runtime.

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
Keep both the session id and owner across agent tool calls. A CLI update preserves
active daemons/sessions; doctor exposes the running daemon version separately.


### Dependency review (2026-10-20)

- `@xterm/headless` 6.0.0 and TypeScript 7.0.2 are already the latest stable releases.
- Upgrade `@types/node` to stable 26.6.5; compiled runtime targets remain ES2022.
- Keep `@lydell/node-pty` exactly at npm's current latest 1.2.0-beta.15. This is an
  intentional exception to the stable-only preference: the maintainer explains
  that the older stable-labelled 1.1.0 was based on node-pty 1.1.0-beta14, and that
  the later 1.2 beta repackaging fixed problems in the official 1.1.0 prebuilds.
  Do not downgrade based only on the absence of a beta suffix. The pinned package
  ships matching prebuilt binaries for Linux/macOS/Windows, x64/arm64.

Source: [maintainer's versioning explanation](https://github.com/lydell/node-pty/releases/tag/v1.2.0-beta.3).


Version 1.5.1 fixes native Windows daemon startup: lock files are stored beside the
state file, outside the named-pipe namespace. RPC streams also preserve UTF-8 when
transport chunks split within a character. Windows users should use 1.5.1 or later.

## Release checks (1.6.0+)

```bash
pty-bridge check-update --json
pty-bridge --no-update-check start bash
```

The checker uses the latest published stable release, not the main branch version.
Successful `start`, `list`, and `status` commands check at most hourly, with a
2-second network budget, 5-minute failure retry and 24-hour same-version reminder
cooldown. Automatic notices use stderr; failures never change the PTY result.
Help, version, doctor and high-frequency I/O remain offline.

Disable with `PTY_BRIDGE_NO_UPDATE_CHECK=1`, the leading `--no-update-check` flag,
or `{"disable_update_check":true}` in
`~/.config/agent-skills/pty-bridge/config.json`. Explicit checks respect disabling
and report errors with exit code 1. Cache files are separate from daemon state.
See the [skill](skill/SKILL.md#versions-and-update-checks) for configuration and
CLI/skill/daemon upgrade handling. Upgrade notifications do not install anything.
