---
name: pty-bridge
description: Manage interactive terminal sessions (SSH, REPLs, databases, TUI apps) via pty-bridge CLI. Use when the standard Bash tool cannot handle interactive programs that require a PTY.
---

# pty-bridge

You have access to `pty-bridge`, a CLI tool that manages interactive terminal sessions with full PTY support. Use it when the standard Bash tool cannot handle interactive programs — SSH, REPLs, database CLIs, TUI apps, or any command that expects terminal input.

## Installation

```bash
npm i -g github:briqt/pty-bridge
```

> Requires Node.js 18+ and C++ build toolchain (`apt install build-essential python3` on Debian/Ubuntu).

## When to Use

- SSH into remote servers
- Interactive REPLs (python, node, irb, psql, mysql, etc.)
- Programs that prompt for passwords or confirmations
- TUI applications (htop, vim, less, etc.)
- Any command that hangs or misbehaves with the regular Bash tool

## Commands

```bash
pty-bridge start <command> [args...]                # Start a PTY session
pty-bridge read <id> [--full] [--buffer <type>]     # Read new output (incremental by default, --full for all)
pty-bridge write <id> <input>                       # Send input (or pipe via stdin)
pty-bridge exec <id> <command> [--wait <ms>]        # Execute command and return new output (default wait: 200ms)
                               [--wait-for-idle <ms>]
pty-bridge sendkey <id> <key>                       # Send special key
pty-bridge wait-for <id> <pattern> [--timeout <s>]  # Block until pattern appears (default: 30s)
pty-bridge snapshot <id>                            # Capture current visible screen content
pty-bridge list                                     # List active sessions with uptime, buffer type, and details
pty-bridge kill <id>                                # Terminate a session
pty-bridge resize <id> <cols> <rows>                # Resize terminal
pty-bridge status                                   # Show daemon status (PID, memory, sessions)
```

### Start Options

```bash
pty-bridge start ssh user@host --keepalive 30    # Send keepalive every 30s (prevents SSH timeout)
pty-bridge start cmd --wait 1000                 # Wait 1000ms before returning initial output (default: 500ms)
```

### Read Options

```bash
pty-bridge read <id> --buffer normal      # Read from normal buffer (even if alternate is active)
pty-bridge read <id> --buffer alternate   # Read from alternate buffer
pty-bridge read <id> --buffer active      # Read from whichever buffer is active (default)
```

### Exec Options

```bash
pty-bridge exec <id> "make build" --wait-for-idle 500          # Poll every 500ms, return when output stabilizes (max 5s)
pty-bridge exec <id> "make build" --wait-for-idle 500 --wait 10000  # Same but max wait 10s
```

### Snapshot

```bash
pty-bridge snapshot <id>    # Returns current visible screen: lines, cursor position, buffer type, dimensions
```

## Special Keys

enter, tab, escape, space, backspace, delete, up, down, left, right, home, end, pageup, pagedown, ctrl-a through ctrl-z, ctrl-\\, ctrl-]

## Workflow Patterns

### SSH Session (recommended)

```bash
pty-bridge start ssh user@host --keepalive 30
pty-bridge read <id>
# If password prompt:
echo -n "password" | pty-bridge write <id> --stdin
pty-bridge sendkey <id> enter
pty-bridge read <id>
# Run commands (exec = write + enter + wait + read, one step):
pty-bridge exec <id> "ls -la"
pty-bridge exec <id> "df -h"
# For slow commands, increase wait time:
pty-bridge exec <id> "apt update" --wait 5000
# Disconnect:
pty-bridge exec <id> "exit"
```

### Wait for Service Startup

```bash
pty-bridge start ssh user@host --keepalive 30
pty-bridge exec <id> "docker compose up -d"
pty-bridge exec <id> "docker logs -f myservice" --wait 1000
# Block until service is ready:
pty-bridge wait-for <id> "Uvicorn running" --timeout 120
# Or wait for model loading:
pty-bridge wait-for <id> "Started" --timeout 300
```

### Interactive REPL

```bash
pty-bridge start python3
pty-bridge exec <id> "print('hello')"
pty-bridge exec <id> "2 + 2"
pty-bridge sendkey <id> ctrl-d
```

### Handling Prompts

```bash
pty-bridge start some-installer
pty-bridge read <id>
pty-bridge write <id> "yes"
pty-bridge sendkey <id> enter
pty-bridge read <id>
```

## Important Notes

1. **Prefer `exec` over `write` + `sendkey enter`** — `exec` combines write, enter, wait, and read into one call, returning only the new output.
2. **`read` is incremental by default** — it returns only output since the last read. Use `read <id> --full` to get the entire buffer.
3. **Use `wait-for` for long operations** — instead of `sleep N && read`, use `wait-for <id> "pattern" --timeout N` to block until specific output appears.
4. `write` sends text as-is — use `sendkey enter` afterward to submit (or just use `exec`).
5. For secrets, pipe via stdin: `echo -n "password" | pty-bridge write <id> --stdin`
6. Always `kill` sessions when done to free resources.
7. The daemon auto-exits after 5 minutes when no alive sessions remain.
8. Use `ctrl-c` via sendkey to interrupt stuck commands.
9. Terminal defaults to 120x40. Use `resize` for TUI apps that need specific dimensions.
10. Client socket timeout is configurable via `PTY_BRIDGE_TIMEOUT` environment variable (ms, default: 30000).
