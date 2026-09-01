# LLM Gateway

A Linux desktop app that runs a local, Anthropic-compatible HTTP gateway and points Claude Code at
it. The gateway load-balances your requests across several providers; the app gives it a GUI —
provider management, health and cost visibility, and the `~/.claude/settings.json` wiring that
connects the two.

The gateway itself is not written here. Its TypeScript source is vendored into `gateway-src/` from
[llm-gateway-for-claude-code](https://github.com/hasnat-shohag/llm-gateway-for-claude-code) so this
repository builds standalone; see [`gateway-src/VENDOR.md`](gateway-src/VENDOR.md) for the upstream
commit and the refresh procedure.

## What it does

- **Providers** — add, edit, enable, disable, and reorder the upstream endpoints the gateway routes
  to. Keys are stored outside the repository and never rendered in full.
- **Usage** — request counts, health, latency, and token cost per provider, from the gateway's own
  read-only endpoints.
- **Setup** — port, load-balancing strategy (`random`, `round-robin`, `weighted`), log level, theme,
  autostart, and a plan-then-apply toggle that wires Claude Code to the gateway.
- Runs in the background from the system tray. Closing the window hides it; only an explicit quit
  exits.
- Supervises the gateway as a child process, restarting it with exponential backoff if it dies.

If you have an active Claude Code login, a `passthrough` provider relays it, so the gateway can sit
in front of your existing subscription rather than replacing it.

## Install

```bash
curl -fsSL https://hasnat-shohag.github.io/llm-gateway/install.sh | sh
```

That adds the APT repository and installs the package. To do it by hand instead — or to see exactly
what the script does — the steps are on the
[repository page](https://hasnat-shohag.github.io/llm-gateway). Updates then arrive through
`apt upgrade` like anything else.

For other architectures or non-Debian distributions, every release also ships an AppImage on the
[releases page](https://github.com/hasnat-shohag/llm-gateway/releases).

## Requirements

- Linux (X11 or XWayland). Only Linux targets are packaged; the Wayland backend is not used.
- Node.js 22 or newer.
- `binutils` and `fakeroot` on the build host if you want to build the `.deb`. The AppImage builds
  without them.

## Build and run from source

```bash
npm install            # postinstall rebuilds the native addon against Electron's ABI
npm start              # compiles the vendored gateway, then launches the app
```

Other tasks:

```bash
npm test               # node --test over the main-process modules
npm run typecheck      # tsc --noEmit over gateway-src/
npm run dist           # .deb and .AppImage into release/
```

Starting the app while another process already holds the configured port is a supported state, not a
failure: the supervisor reports the conflict and the UI offers the next free port.

## Where your data lives

Everything the app writes is under `~/.config/llm-gateway-desktop/`:

| File | Contents |
| --- | --- |
| `providers.json` | Provider list, including API keys |
| `settings.json` | Port, strategy, log level, theme, poll interval |
| `usage.db` | Request and token accounting |
| `logs/gateway.log` | Gateway output, rotated at 2 MB |

Deleting that directory is a clean factory reset. A `providers.json` at the repository root is only
ever read once, as a first-run migration source — see
[`providers.example.json`](providers.example.json) for the shape.

## How it treats your credentials

- API keys stay in the main process. The renderer only ever receives masked values, and a save
  payload containing a mask is rejected rather than written.
- `~/.claude/.credentials.json` is never read. The app checks only whether a login exists.
- Edits to `~/.claude/settings.json` touch only the two keys the app owns, remove a key only if it
  still holds the value the app wrote, and leave a timestamped backup beside the file on every write.
- The renderer makes no network requests of its own; its content security policy forbids them
  outright.

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — process model, module map, request lifecycle, telemetry,
  packaging, and runbook.
- [`PLAN.md`](PLAN.md) — design rationale and roadmap.
- [`EXECUTION.md`](EXECUTION.md) — what has been verified by running it, and what has not.
- [`CLAUDE.md`](CLAUDE.md) — orientation for AI coding agents, including the invariants that fail
  silently when broken.

## License

MIT — see [LICENSE](LICENSE).
