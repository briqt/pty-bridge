# pty-bridge

Manage interactive terminal sessions (SSH, REPLs, databases, TUI apps) via a simple CLI. Designed for AI agents that need PTY support.

Distributed as a self-contained agent skill — no compile step, no platform-specific tarballs, no npm publish. The `skill/` folder ships pre-built JS and pre-bundled native binaries for linux-x64/arm64 and darwin-x64/arm64.

## Install (end users)

Use the [skills](https://skills.sh/) CLI:

```bash
npx skills add briqt/pty-bridge -g
```

This shallow-clones the repo and copies `skill/` into `~/.agents/skills/pty-bridge/`. The skill is then visible to Claude Code, Kiro CLI, and other compatible agents.

To upgrade:

```bash
npx skills update pty-bridge
```

To remove:

```bash
npx skills remove pty-bridge
```

Requirements: Node.js 18+. Linux or macOS (Windows users: run inside WSL).

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

See [`skill/SKILL.md`](skill/SKILL.md) for the full command reference.

## Architecture

- **Daemon**: Auto-spawns on first `start`, manages PTY sessions via Unix socket
- **Client**: Thin CLI that sends commands to the daemon
- **Sessions**: Each session runs in its own PTY with xterm.js headless terminal for clean output

The daemon auto-exits after 5 minutes with no active sessions.

## Development

```bash
git clone https://github.com/briqt/pty-bridge.git
cd pty-bridge
npm install                # dev deps (typescript)
npm run prepare-skill      # tsc → skill/dist/, vendor skill/node_modules/ for all 4 platforms
```

Edit `src/*.ts`, run `npm run prepare-skill`, commit `skill/dist/` and (if deps changed) `skill/node_modules/`. Push to `main` — `npx skills update` then picks up the new revision.

There is no version tag, no GitHub Release, no `npm publish`. The repo's HEAD is the published artifact.

## License

MIT
