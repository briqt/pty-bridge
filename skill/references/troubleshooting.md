# pty-bridge troubleshooting

Start with `pty-bridge doctor --json`. It reports CLI and Node paths, native PTY availability, the socket and the running daemon's version, and it never starts a daemon.

| Symptom | Cause | Action |
|---|---|---|
| `command not found: pty-bridge` | CLI not installed | `npm i -g github:briqt/pty-bridge --install-links` |
| `Cannot find module @lydell/node-pty-…` | Native binary not linked | Reinstall with `--install-links` (linux/darwin/win32 × x64/arm64) |
| `connect ENOENT` / daemon start error | Daemon not running | `pty-bridge status`; the next `start` respawns it. Check `list` for lost sessions |
| `Session not found` + lost warning | Daemon restarted; in-memory sessions are gone | Start a new session; old ids and names are not reusable. Remote `nohup` jobs may still run |
| `Session … is owned by` | Session is locked to another owner | Use your own session or pass your own `--owner`; `--force` only for an explicit takeover |
| `Session name … is already used` | A live session holds that name | Use that session if it is yours; otherwise pick another name |
| `Warning: the running daemon predates session names` | CLI upgraded, older daemon still running | Use the id; names work once that daemon exits |
| `status=still_running` / RPC timeout | Wait budget or RPC limit reached; input **already sent** | Do not resend. `read <session> --from-exec` or `wait-for` |
| `wait-for` timeout | Pattern not in the last 200 lines + new output | `--from-now` for new output only, `--from 0` for the whole buffer |
| Output wrapped mid-word | Rendered at the current width | `read --raw`, or `resize` if changing the child's TTY size is acceptable |
| Empty-looking `snapshot` | Screen cleared or alternate screen | `read --last N` or `read --raw` |
| `unknown option` | Typo or unsupported flag (flags are never ignored) | `pty-bridge <command> --help` |
| Windows: `ENOENT` on a `.lock` path | Pre-1.5.1 lock handling | Upgrade the CLI |

## Timeouts

- `--rpc-timeout-ms <ms>` (before or after the subcommand) bounds the client's wait for the daemon. The legacy `--timeout <ms>` means the same, except on `wait-for`.
- `exec --wait <ms>` is the command's own wait budget; the RPC timeout extends to `max(30000, wait + 5000)` automatically.
- `wait-for --timeout` is in **seconds**.

## Output details

- Rendered cursors are `line` or `line:byte-column`; raw cursors (`--raw`) are absolute UTF-8 byte offsets that stay valid after eviction. Pass cursors back unchanged.
- The default payload cap is 256000 bytes (`--max-bytes`, 0 = unlimited). A bounded read never skips past bytes it did not return.
- `exec` does not move the incremental `read` cursor.
- Terminal size defaults to 120x40; `resize` changes the child's TTY size (SIGWINCH).
- `list` / `status` may warn `daemon restarted at <time>, N session(s) lost`. Those PTYs are gone. Do not adopt another session from `list` to replace yours.
