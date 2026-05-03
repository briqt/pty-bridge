# pty-bridge

Manage interactive terminal sessions (SSH, REPLs, databases, TUI apps) via a simple CLI. Designed for AI agents that need PTY support.

## Install

```bash
npm i -g github:briqt/pty-bridge-cli
```

Requires Node.js 18+ and a C++ build toolchain for the native `node-pty` dependency:

```bash
# Debian/Ubuntu
apt install build-essential python3
```

## Quick Start

```bash
# Start an SSH session
pty-bridge start ssh user@host --keepalive 30

# Run a command and get output
pty-bridge exec <id> "ls -la"

# Start a Python REPL
pty-bridge start python3
pty-bridge exec <id> "print('hello')"

# Kill session when done
pty-bridge kill <id>
```

## Commands

| Command | Description |
|---------|-------------|
| `start <cmd> [args...]` | Start a PTY session |
| `read <id> [--full] [--buffer <type>]` | Read new output (incremental by default) |
| `write <id> <input>` | Send input text |
| `exec <id> <cmd> [--wait <ms>] [--wait-for-idle <ms>]` | Execute command and return output |
| `sendkey <id> <key>` | Send special key (enter, ctrl-c, etc.) |
| `wait-for <id> <pattern> [--timeout <s>]` | Block until pattern appears |
| `snapshot <id>` | Capture current visible screen |
| `list` | List active sessions |
| `kill <id>` | Terminate a session |
| `resize <id> <cols> <rows>` | Resize terminal |
| `status` | Show daemon status |

## Architecture

- **Daemon**: Auto-spawns on first `start`, manages PTY sessions via Unix socket
- **Client**: Thin CLI that sends commands to the daemon
- **Sessions**: Each session runs in its own PTY with xterm.js headless terminal for clean output

The daemon auto-exits after 5 minutes with no active sessions.

## License

MIT
