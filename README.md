# LLM Gateway

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: Linux](https://img.shields.io/badge/platform-Linux-informational.svg)](#requirements)
[![Electron 42.10.1](https://img.shields.io/badge/electron-42.10.1-47848f.svg)](#build-from-source)

A Linux desktop app that runs a local, Anthropic-compatible HTTP gateway and points Claude Code at
it. The gateway load-balances your requests across several providers; the app gives it a GUI —
provider management, health and cost visibility, and the `~/.claude/settings.json` wiring that
connects the two.

```
Claude Code  ──►  127.0.0.1:8080  ──►  provider A  (x-api-key)
                  (the gateway)   ├──►  provider B  (bearer)
                                  └──►  api.anthropic.com  (passthrough — your own login)
```

The gateway itself is not written here. Its TypeScript source is vendored into `gateway-src/` from
[llm-gateway-for-claude-code](https://github.com/hasnat-shohag/llm-gateway-for-claude-code) so this
repository builds standalone; see [`gateway-src/VENDOR.md`](gateway-src/VENDOR.md) for the upstream
commit and the refresh procedure. The app compiles that source, supervises it as a child process,
and reads its existing HTTP endpoints. It never modifies the gateway's request path.

## What it does

- **Providers** — add, edit, enable, disable, reorder, and delete the upstream endpoints the gateway
  routes to, and send a one-shot test request to any of them that bypasses the gateway entirely.
- **Usage** — request counts, health, latency, and token cost, overall and per provider, drawn from
  the gateway's own read-only endpoints. Daily counters roll over at 00:00 UTC.
- **Setup** — port, load-balancing strategy, log level, theme, autostart, and a plan-then-apply
  toggle that wires Claude Code to the gateway and can unwire it again.
- Lives in the system tray. Closing the window hides it; only an explicit quit exits.
- Supervises the gateway as a child process, restarting it with exponential backoff (500 ms up to
  30 s) if it dies, and rotating its log at 2 MB.

If you have an active Claude Code login, a `passthrough` provider relays it, so the gateway can sit
in front of your existing subscription rather than replacing it.

## Install

```bash
curl -fsSL https://hasnat-shohag.github.io/llm-gateway/install.sh | sh
```

That adds the signed APT repository and installs the package. If you would rather not pipe a script
to a shell, the [repository page](https://hasnat-shohag.github.io/llm-gateway) lists the same steps
to run by hand. Either way, later releases arrive through `apt upgrade` like anything else.

Both artifacts are `x86_64` only — the release workflow builds for its own architecture and nothing
else, so there is no arm64 build to install. For a non-Debian distribution, every release also ships
an AppImage on the [releases page](https://github.com/hasnat-shohag/llm-gateway/releases):
`chmod +x` it and run it, with nothing to install and no update channel.

To remove it:

```bash
sudo apt remove llm-gateway
sudo rm /etc/apt/sources.list.d/llm-gateway.sources /etc/apt/keyrings/llm-gateway.gpg
```

`apt remove` deliberately leaves `~/.config/llm-gateway-desktop/` in place, so your providers and
usage history survive a reinstall. Delete that directory for a clean reset.

## Requirements

- Linux, X11 or XWayland. Electron's Wayland backend segfaults on window creation under
  GNOME/mutter, so the app ships `--ozone-platform=x11` as a launch argument. Appending
  `--ozone-platform=wayland` opts back in, at your own risk.
- Nothing else for the `.deb` — it declares its own library dependencies. The AppImage bundles
  everything but needs FUSE to mount itself (`libfuse2` on distributions that ship FUSE 3 only);
  where that is missing, `APPIMAGE_EXTRACT_AND_RUN=1` runs it without mounting.

## First run

Onboarding replaces the three tabs until it is finished. Every step reads live state rather than a
stored cursor, so a step that is already satisfied — a provider file carried over from a previous
install, for instance — arrives done.

1. **Gateway running.** It listens on `127.0.0.1:8080` by default. If something else already holds
   that port, the step says so and offers the next free one; this is a supported state, not a
   failure.
2. **At least one provider.** Add one, or enable the `passthrough` provider if you have a Claude
   Code login for the gateway to relay.
3. **Claude Code wired.** The app shows exactly what it will change in `~/.claude/settings.json`
   before it writes anything, and backs the file up first.

Claude Code reads that file at startup, so restart any running session afterwards. Then use it as
usual — the two keys from step 3 are all it needs.

## Providers

The app owns `providers.json`; you should not have to hand-edit it. This is the shape it writes, and
[`providers.example.json`](providers.example.json) is a working sample.

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | Required, and unique across the file. Health, stats, and usage are all keyed by it, so duplicates are rejected outright. |
| `baseUrl` | URL | Required. |
| `apiKey` | string | Required, except for `authStyle: passthrough`, which injects no key. |
| `enabled` | boolean | Required. A disabled provider is never routed to. |
| `weight` | integer > 0 | Required. Only the `weighted` strategy reads it. |
| `authStyle` | `x-api-key` \| `bearer` \| `passthrough` | Defaults to `x-api-key`. |
| `sanitize` | boolean | Optional, and best left out. |

Some upstreams fingerprint the client and require Claude Code's headers and system prompt untouched;
others reject a request that carries them. There is no default that suits both, so the gateway
learns which mode works per provider and remembers it until it restarts. Setting `sanitize` pins
that decision and skips the learning entirely — useful only if you already know the answer.

## Settings

Stored in `settings.json`, all editable from the Setup tab.

| Setting | Default | Values |
| --- | --- | --- |
| `port` | `8080` | Any free port. Changing it rewrites `~/.claude/settings.json` when routing is on. |
| `strategy` | `random` | `random`, `round-robin`, `weighted`. Needs a gateway restart, which the app does for you. |
| `logLevel` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Also needs a restart. |
| `pollMs` | `5000` | How often the UI refreshes. Floored at 2000. |
| `theme` | `system` | `system`, `light`, `dark`. |

Autostart is a separate toggle that writes an XDG autostart entry — pointing at
`/usr/bin/llm-gateway` for a deb install, or at the AppImage's real path rather than its ephemeral
mount point. Linux only.

## Where your data lives

Everything the app writes is under `~/.config/llm-gateway-desktop/`:

| File | Contents |
| --- | --- |
| `providers.json` | Provider list, including API keys |
| `providers.json.bak` | The same list, written just before it, so a crash mid-write is recoverable |
| `settings.json` | Port, strategy, log level, theme, poll interval |
| `usage.db` | Request and token accounting (SQLite, WAL — so `usage.db-wal` and `-shm` appear beside it) |
| `logs/gateway.log` | Gateway output, rotated at 2 MB |

Deleting that directory is a clean factory reset. A `providers.json` at the repository root — or the
path in `GATEWAY_PROVIDERS_SEED` — is read once, as a first-run migration source, and never again.

## How it treats your credentials

- **API keys never leave the main process.** The renderer receives masked values (`sk-abc…1234`) and
  sends back a sentinel for anything it did not change; a save payload containing a mask character
  is rejected rather than written.
- **`~/.claude/.credentials.json` is never read.** Those are single-use rotating refresh tokens. The
  app checks whether a login exists and nothing more.
- **Edits to `~/.claude/settings.json` are surgical.** Only `ANTHROPIC_BASE_URL` and one credential
  key are touched, a key is removed only if it still holds the value the app wrote, a file that does
  not parse as JSON is never overwritten, and every write leaves a timestamped `.bak-…` sibling.
  That file also holds your permissions, hooks, and MCP config; none of it is the app's business.
- **The renderer makes no network requests at all.** Its content security policy sets
  `connect-src 'none'`, so there is no CORS surface to get wrong. Every byte it displays arrives
  over a fixed list of IPC channels, each re-validated in the main process.
- **The gateway binds `127.0.0.1`.** The supervisor forks it with that host hardcoded, and it has no
  authentication of its own — it is a local process for local use. There is no setting to expose it
  to a network, deliberately.

## Build from source

Node.js 22 or newer, and `binutils` + `fakeroot` on the host if you want the `.deb` (fpm shells out
to `ar` and stages ownership under `fakeroot`). The AppImage needs neither.

```bash
npm install            # postinstall rebuilds the native addon against Electron's ABI
npm start              # compiles the vendored gateway, then launches the app
```

```bash
npm test               # node --test over the main-process modules
npm run typecheck      # tsc --noEmit over gateway-src/
npm run dist           # .deb and .AppImage into release/
```

There is no bundler and no build step for the app's own code — only the vendored gateway is
compiled, and `build:gateway` is already a dependency of `start`, `test`, and `dist`, so nothing
ever runs against a stale build.

The layout, the invariants worth knowing before you change anything, and the release process are in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Troubleshooting

**The port is already in use.** Expected if you already run the gateway yourself. The app reports
the conflict instead of fighting for the port, and offers a free one; retrying could not have freed
it.

**`503 all providers failed`.** Every enabled provider is unhealthy or erroring. Three consecutive
failures put a provider in a 60-second cooldown, so a bad key can take the whole pool out for a
minute. The Providers tab's test button hits one provider directly, bypassing the gateway, which is
the fastest way to tell a bad key from a dead upstream.

**Claude Code ignores the gateway.** Check that `ANTHROPIC_BASE_URL` in `~/.claude/settings.json`
still points at the configured port, and restart Claude Code — it reads that file at startup.

**Cost looks lower than the work you did.** Usage is recorded from the SSE stream, so only streaming
requests contribute rows, and an aborted or truncated stream records nothing at all. Non-streaming
calls are proxied correctly but do not show up in the numbers.

**Provider edits appear to do nothing.** The gateway hot-reloads `providers.json` through a watch on
the file's inode, so a provider list it rejects is ignored in full — the app validates against the
gateway's own schema to keep that from happening silently. `logs/gateway.log`, reachable from the
Setup tab, is the place to confirm.

## Known limitations

- Linux only. `autostart.js` reports itself unsupported elsewhere, and no other target is packaged.
- Non-streaming requests contribute no usage rows, so token cost only reflects streaming traffic —
  the requests themselves are proxied correctly either way.
- Per-provider error counts only include non-retryable failures. A failover records a health failure
  but not an error, so a provider that fails and gets retried elsewhere looks cleaner than it was.
- Unknown paths are proxied upstream rather than rejected: `app.all('/*')` is the last route, so the
  gateway stays a faithful stand-in for the real API instead of a whitelist of the paths it knows.
- No renderer tests. The tested surface is the main process, which is where the irreversible writes
  are.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) first, particularly
the rule that gateway behaviour is fixed upstream and re-vendored, never edited in `gateway-src/`.

To report a security issue, please follow [SECURITY.md](SECURITY.md) rather than opening a public
issue.

## License

MIT — see [LICENSE](LICENSE).
