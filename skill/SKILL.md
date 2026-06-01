---
name: pty-bridge
description: Manage interactive terminal sessions (SSH, REPLs, databases, TUI apps) via the pty-bridge CLI. Use whenever the standard Bash tool can't handle a program that needs a real PTY — SSH logins, interactive REPLs (python, psql, mysql, node), commands that prompt for a password or confirmation, or TUI apps (vim, htop, less). Reach for this skill any time a command hangs, ignores piped input, or misbehaves under plain Bash.
---

# pty-bridge

`pty-bridge` is a CLI that manages interactive terminal sessions with full PTY support. Use it when the standard Bash tool can't handle interactive programs — SSH, REPLs, database CLIs, TUI apps, or any command that expects a real terminal.

## Setup

If `pty-bridge` is not available, install it from GitHub:

```bash
npm i -g github:briqt/pty-bridge --install-links
```

Requirements: Node.js 18+. Supported on macOS, Linux, and Windows.

## When to Use

- SSH into remote servers
- Interactive REPLs (python, node, irb, psql, mysql, etc.)
- Programs that prompt for passwords or confirmations
- TUI applications (htop, vim, less, etc.)
- Any command that hangs or misbehaves with the regular Bash tool

## Commands

```bash
pty-bridge [--timeout <ms>] <command> [options]

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

### Global Options

```bash
pty-bridge --timeout 60000 exec <id> "slow-command"   # Override client socket timeout (default: 30000ms)
```

### Start Options

```bash
pty-bridge start ssh user@host --keepalive 30    # Send keepalive every 30s (prevents SSH timeout)
pty-bridge start cmd --wait 1000                 # Wait 1000ms before returning initial output (default: 500ms)
pty-bridge start cmd --cols 200 --rows 50        # Custom terminal dimensions (default: 120x40)
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

## Output Format Convention

- **stdout**: command output (the actual PTY content)
- **stderr**: metadata line in `[key=value ...]` format, e.g. `[lines=42 alive=true buffer=normal exitCode=0]`
- `read` returns output on stdout, session metadata on stderr — parse stderr for session state
- `exec` returns command output on stdout — check `isAlive` and `exitCode` in the stderr line or JSON response
- `snapshot` prints a header line `[buffer=... cursor=... size=...]` then the screen content
- `status` output is human-readable text (parse with regex if needed)

## Error Recovery

| Symptom | Cause | Action |
|---------|-------|--------|
| `command not found: pty-bridge` | Not installed | `npm i -g github:briqt/pty-bridge --install-links` |
| `connect ENOENT` or socket timeout | Daemon died or not started | `pty-bridge status`; daemon auto-starts on next `start` |
| SSH password prompt | Interactive auth required | Use `pty-bridge write <id> "password" --stdin` then `sendkey enter` |
| `wait-for` timeout | Pattern never appeared | Check the partial output returned; pattern may have a typo or the command failed silently |
| `Cannot find module @lydell/node-pty-…` | No prebuilt binary for this platform | Supported: linux/darwin/win32 × x64/arm64. Reinstall with `--install-links` |
| PTY output is empty/garbled | TUI app in alternate screen | Use `snapshot <id>` instead of `read`; or `read <id> --buffer alternate` |

## Important Notes

1. **Prefer `exec` over `write` + `sendkey enter`** — `exec` combines write, enter, wait, and read into one call, returning only the new output.
2. **`read` is incremental by default** — it returns only output since the last read. Use `read <id> --full` to get the entire buffer.
3. **`exec` does NOT advance the `read` cursor** — if you call `exec` then `read`, the `read` will include the same output that `exec` already returned. This is by design: `exec` is a self-contained operation that doesn't interfere with incremental `read` state.
4. **Use `wait-for` for long operations** — instead of `sleep N && read`, use `wait-for <id> "pattern" --timeout N` to block until specific output appears.
5. `write` sends text as-is — use `sendkey enter` afterward to submit (or just use `exec`).
6. For secrets, pipe via stdin: `echo -n "password" | pty-bridge write <id> --stdin`
7. Always `kill` sessions when done to free resources.
8. The daemon auto-exits after 5 minutes when no alive sessions remain.
9. Use `ctrl-c` via sendkey to interrupt stuck commands.
10. Terminal defaults to 120x40. Use `--cols`/`--rows` on `start` or `resize` for TUI apps that need specific dimensions.
11. Use `--timeout <ms>` (global flag, before the command) to override the default 30s client socket timeout for slow operations.
