---
name: pty-bridge
description: Manage interactive terminal sessions (SSH, REPLs, databases, TUI apps) via the pty-bridge CLI. Use whenever the standard Bash tool can't handle a program that needs a real PTY — SSH logins, interactive REPLs (python, psql, mysql, node), commands that prompt for a password or confirmation, or TUI apps (vim, htop, less). Reach for this skill any time a command hangs, ignores piped input, or misbehaves under plain Bash.
---

# pty-bridge

`pty-bridge` is a CLI that manages interactive terminal sessions with full PTY support. Use it when the standard Bash tool can't handle interactive programs — SSH, REPLs, database CLIs, TUI apps, or any command that expects a real terminal.

This manual requires **pty-bridge 1.5.0+**. Skill files and the CLI are installed separately:

```bash
pty-bridge --version
pty-bridge doctor --json    # inspects an existing daemon; never starts one
npm i -g github:briqt/pty-bridge --install-links
npx skills add briqt/pty-bridge -g -y
```

The doctor reports CLI/Node paths, native PTY availability, the socket and the running
daemon's version. Installing a new CLI does not replace an existing daemon or its sessions.
A legacy daemon without a version field needs to drain/exit before new runtime features apply.

## Setup

If `pty-bridge` is not available, install it from GitHub (not the npm registry):

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

## Isolation (required)

All agents on the same OS user share one daemon. **Never pick a session from `list` unless the user asked you to take it over.**

1. Set a stable owner for this conversation, then pass it on **every mutating call** (tool calls may use fresh shells):
   ```bash
   export PTY_BRIDGE_OWNER="agent-$(uuidgen | cut -c1-8)"
   pty-bridge start ssh user@host --keepalive 30 --owner "$PTY_BRIDGE_OWNER" --json
   # Store sessionId and owner from the JSON response.
   pty-bridge exec <id> "pwd" --owner <stored-owner> --wait-exit
   ```
2. Use **only** the `sessionId` (`--json`) or `Session: <id>` returned by your `start`. Store both the id and owner.
3. Mutating another owner's session (`write` / `exec` / `sendkey` / `kill` / `resize`) is rejected. Use `--force` only when the user explicitly wants to take over.
4. `list` shows `owner=` so you can see which sessions are yours.

## Commands

```bash
pty-bridge [--timeout <ms>] <command> [options]

pty-bridge start <command> [args...]                # Start a PTY session
pty-bridge read <id> [options]                      # Read output (see Read options)
pty-bridge write <id> <input>                       # Send input (or pipe via stdin)
pty-bridge exec <id> <command> [options]            # Execute command and return new output
pty-bridge sendkey <id> <key>                       # Send special key
pty-bridge wait-for <id> <pattern> [--timeout <s>]  # Block until pattern appears (default: 30s)
pty-bridge snapshot <id>                            # Capture current visible screen
pty-bridge list                                     # Active sessions + lost-session tombstones
pty-bridge kill <id>                                # Terminate a session
pty-bridge resize <id> <cols> <rows>                # Resize terminal (sends SIGWINCH to the child)
pty-bridge status                                   # Daemon PID, memory, lost sessions
```

### Global Options

```bash
pty-bridge --timeout 60000 exec <id> "slow-command"   # Client RPC timeout in ms (must be BEFORE the subcommand)
```

Use `--rpc-timeout-ms` for the RPC budget (before or after a subcommand); legacy
`--timeout` still works, but `wait-for --timeout` means **seconds**. Use `exec --wait`
for the command wait budget. RPC timeout auto-extends to `max(30000, waitMs+5000)`.
`read --help`, `exec --help`, and other subcommand help calls are supported.

### Start Options

```bash
pty-bridge start ssh user@host --keepalive 30 --owner "$PTY_BRIDGE_OWNER"
pty-bridge start cmd --wait 1000
pty-bridge start cmd --cols 200 --rows 50
```

### Read Options

Unknown flags error out (they are not swallowed). `--full`, `--from`, `--from-exec`, and `--last`/`--lines` are mutually exclusive.

```bash
pty-bridge read <id>                      # Incremental new output (advances cursor)
pty-bridge read <id> --full               # Entire rendered buffer (does not advance cursor)
pty-bridge read <id> --from 12:40          # Rendered line 12, UTF-8 byte column 40
pty-bridge read <id> --from 12            # From line 12 (resume cursor from exec metadata)
pty-bridge read <id> --from-exec          # From last exec start (after an RPC timeout)
pty-bridge read <id> --last 60            # Last 60 lines
pty-bridge read <id> --lines 60           # Alias of --last
pty-bridge read <id> --raw [--full]       # Unwrapped PTY bytes (no xterm line wrapping)
pty-bridge read <id> --max-bytes 100000   # Truncate; 0 = unlimited (default 256000)
pty-bridge read <id> --buffer normal      # normal | alternate | active (default)
```

`snapshot` is the current **visible screen** (cols×rows), not a log tail. Empty-looking snapshots usually mean a clear/alternate screen — use `read --last` or `read --raw`.

### Exec Options

```bash
pty-bridge exec <id> "ls -la"                                    # wait 200ms, then return output so far --owner "$PTY_BRIDGE_OWNER"
pty-bridge exec <id> "make build" --wait-for-idle 500            # poll until output idle (max 5s unless --wait) --owner "$PTY_BRIDGE_OWNER"
pty-bridge exec <id> "make build" --wait-exit --wait 120000      # shell only: wait until command exits --owner "$PTY_BRIDGE_OWNER"
pty-bridge exec <id> "dmesg" --max-bytes 100000 --owner "$PTY_BRIDGE_OWNER"
```

`--wait-exit` appends a sentinel (`cmd; echo PTYBRIDGE_DONE_<token>:$?`). Use it only in a **shell** (bash/ssh). Do not use it inside python/mysql/vim.

### Wait-for Options

```bash
pty-bridge wait-for <id> "Uvicorn running" --timeout 120
pty-bridge wait-for <id> "Started" --from-now --timeout 60   # ignore history
pty-bridge wait-for <id> "Started" --from 0                  # full buffer (legacy)
```

Default search window is the **last 200 lines plus new output**, so an old `Started` from hours ago will not match.

## Special Keys

enter, tab, escape, space, backspace, delete, up, down, left, right, home, end, pageup, pagedown, ctrl-a through ctrl-z, ctrl-\\, ctrl-]

## Workflow Patterns

### SSH Session (recommended)

```bash
export PTY_BRIDGE_OWNER="agent-<unique-conversation-id>"
# Retain this literal owner between tool calls, and pass it again each time.
pty-bridge start ssh user@host --keepalive 30 --owner "$PTY_BRIDGE_OWNER"
# If password / MFA prompt:
echo -n "password" | pty-bridge write <id> --stdin --owner "$PTY_BRIDGE_OWNER"
pty-bridge sendkey <id> enter --owner "$PTY_BRIDGE_OWNER"
pty-bridge read <id>
# Prefer --wait-exit for shell commands so you get done/failed + exitCode:
pty-bridge exec <id> "ls -la" --wait-exit --wait 15000 --owner "$PTY_BRIDGE_OWNER"
pty-bridge exec <id> "apt update" --wait-exit --wait 120000 --owner "$PTY_BRIDGE_OWNER"
pty-bridge exec <id> "exit" --wait-exit --wait 5000 --owner "$PTY_BRIDGE_OWNER"
```

### Wait for Service Startup

```bash
pty-bridge exec <id> "docker compose up -d" --wait-exit --wait 60000 --owner "$PTY_BRIDGE_OWNER"
pty-bridge exec <id> "docker logs -f myservice" --wait 1000 --owner "$PTY_BRIDGE_OWNER"
pty-bridge wait-for <id> "Uvicorn running" --from-now --timeout 120
```

### Interactive REPL

```bash
pty-bridge start python3
pty-bridge exec <id> "print('hello')"          # no --wait-exit (not a shell) --owner "$PTY_BRIDGE_OWNER"
pty-bridge sendkey <id> ctrl-d
```

## Output Format Convention

- **stdout**: PTY content
- **stderr**: one metadata line `[key=value ...]`, e.g. `[status=still_running cursor=42 startCursor=10 alive=true truncated=false totalBytes=1200 returnedBytes=1200]`
- `status` is `done` | `still_running` | `failed`. **`still_running` is not a failure** — the command was accepted. Do not resend.
- `cursor` is the next `--from` value: a rendered line or `line:byte-column`; with `--raw` it is an absolute UTF-8 byte offset, stable across buffer eviction.
- Raw `lostBytes>0` means old output was evicted; report the gap instead of treating the output as complete. A bounded read never advances past bytes actually returned.
- If `truncated=true`, continue with `read <id> --from <cursor>` (or `--from-exec`).
- `list` / `status` may print `Warning: daemon restarted at <iso>, N session(s) lost`. Those PTYs are gone; remote `nohup` jobs may still be running. Re-login; do not guess another agent's session from `list`.

## Error Recovery

| Symptom | Cause | Action |
|---------|-------|--------|
| `command not found: pty-bridge` | Not installed | `npm i -g github:briqt/pty-bridge --install-links` |
| `connect ENOENT` or daemon start error | Daemon died | `pty-bridge status`; next `start` respawns it. Check `list` for **lost** tombstones. |
| `Session not found` + lost warning | Daemon restarted and dropped in-memory sessions | Re-`start`. Do not reuse the old id. |
| `Session ... is owned by` | Owner mismatch | Use your own id, or `--force` only if asked to take over |
| RPC timeout / `status=still_running` | Wait budget or RPC limit hit; command **already sent** | **Do not exec again.** `read <id> --from-exec` or `wait-for` |
| SSH password prompt | Interactive auth | `write --stdin` then `sendkey enter` |
| `wait-for` timeout | Pattern not in last 200 lines + new output | `--from-now` / `--from 0`; check the returned output |
| `Cannot find module @lydell/node-pty-…` | No prebuilt binary | linux/darwin/win32 × x64/arm64. Reinstall with `--install-links` |
| Output wrapped (`S\nYS`) | xterm render at current cols | `read --raw` (do not `resize` if you need the remote TTY unchanged) |
| Unknown option | Typo / unsupported flag | Flags are not ignored; fix the flag name |

## Important Notes

1. **Prefer `--wait-exit` in shells** over guessing `--wait`. For REPLs/TUIs, use `exec`/`write` without `--wait-exit`.
2. **`read` is incremental by default.** `--full` / `--from` / `--last` do not advance the incremental cursor.
3. **`exec` does not advance the `read` cursor.**
4. **Timeout ≠ failed.** Never resend an `exec` because of `still_running` or RPC timeout.
5. `write` sends text as-is — use `sendkey enter` afterward (or `exec` / `--wait-exit`).
6. Secrets: `echo -n "password" | pty-bridge write <id> --stdin --owner "$PTY_BRIDGE_OWNER"`
7. `kill` your sessions when done. Daemon auto-exits after 5 minutes with no alive sessions (graceful exit clears tombstones).
8. `ctrl-c` via sendkey interrupts stuck commands.
9. Terminal defaults to 120x40. `resize` **does** change the child's TTY size.
10. Prefer `--rpc-timeout-ms` to disambiguate RPC milliseconds from `wait-for --timeout` seconds.
11. Default read/exec payload cap is 256000 bytes; metadata tells you if more remains.

## Machine-readable sessions and filtering

```bash
pty-bridge start bash --owner <conversation-owner> --json
pty-bridge list --owner <conversation-owner> --alive-only --json
pty-bridge exec <id> "pwd" --owner <conversation-owner> --wait-exit
pty-bridge kill <id> --owner <conversation-owner>
```

A filtered list does not authorize taking over any session. Retain the id and owner
from your own start response. `snapshot` shows a screen; use `read --last 30` for a log tail.
For scripts, large exports, or file transfer over SSH, prefer a file/SFTP channel over
base64 in a PTY. RPC timeout means a submitted command may still be running: resume
with a read rather than submitting it again.
