# Contributing

Thanks for looking. This is a small, deliberately unfashionable codebase — CommonJS in the main
process, vanilla ES modules in the renderer, no bundler, no framework, and no build step for the
app's own code. Only the vendored gateway is compiled. Please keep it that way unless there is a
concrete reason not to.

## Getting set up

```bash
npm install                  # postinstall runs electron-builder install-app-deps
npm start                    # build:gateway, then electron . --ozone-platform=x11
npm test                     # build:gateway, then node --test test/*.test.js
npm run typecheck            # tsc --noEmit over gateway-src/
npm run dist                 # deb + AppImage into release/
```

`build:gateway` is a dependency of `start`, `test`, and `dist`, so nothing runs against a stale
`build/gateway/`. The tests need it because `main/schema.js` imports the compiled gateway's schema.

One file, or one test by name:

```bash
node --test test/providers-store.test.js
node --test --test-name-pattern 'masks' test/providers-store.test.js
```

You need Node.js 22+, and `binutils` + `fakeroot` if you intend to build the `.deb`. Nothing in the
repository can work around their absence; the AppImage target does not need them.

## The shape of it

```
main (CommonJS, Node)  ──IPC──  preload (allowlist)  ──  renderer (vanilla ESM, app:// scheme)
      │
      └── utilityProcess.fork → build/gateway/index.js (ESM) → 127.0.0.1:<port>
```

The boundaries between those three are the design, not an accident of Electron. The main process is
the only place with filesystem, network, or credential access.

**`main/`** — `main.js` (window, tray, lifecycle), `supervisor.js` (forks the gateway, backoff
restarts, port probing, log rotation), `paths.js` (every absolute path in one place, handed to the
child as env vars), `providers-store.js` (read/mask/merge/validate/write), `schema.js` (dynamic
`import()` of the gateway's own zod schema), `settings-store.js`, `claude-settings.js` (the
`~/.claude/settings.json` merge, as plan-then-apply), `claude-account.js` (login presence only),
`provider-probe.js` (one direct request, bypassing the gateway), `gateway-client.js` (HTTP client
with a 2 s memo), `autostart.js`, `theme.js`, `ipc.js` (the named channels, re-validating every
payload).

**`renderer/`** — plain functions over one shared `state` object. `store.js` owns a single poll loop
for every view and pauses it while the window is hidden. `app.js` owns the frameless titlebar, tab
routing, the banner, and the status bar; `providers.js` / `dashboard.js` / `settings.js` are the
tabs (labelled Providers / Usage / Setup); `onboarding.js` replaces all three on first run;
`charts.js` draws inline SVG; `icons.js` is the authored 16px set; `dom.js` is the element helper.

**`gateway-src/`** — vendored, not authored here. See below.

`scripts/cdp-shot.js` screenshots the running window over CDP, which is the only honest way to look
at the real renderer with real data in it:

```bash
node scripts/cdp-shot.js <ws-url> out.png [providers|dashboard|settings] [dark|light] [scrollY]
```

## The vendored gateway

`gateway-src/` is copied from
[llm-gateway-for-claude-code](https://github.com/hasnat-shohag/llm-gateway-for-claude-code). **Do
not edit it to change gateway behaviour.** Fix it upstream and re-vendor;
[`gateway-src/VENDOR.md`](gateway-src/VENDOR.md) records the commit and the procedure.

This is not bookkeeping fussiness. The app validates `providers.json` with the gateway's *own* zod
schema, imported from the compiled output, precisely so the two cannot disagree. A local edit here
turns that guarantee into a lie, and the failure mode is a UI that shows a provider list the gateway
never adopted.

## Invariants that fail silently

Each of these prevents a specific bug that produces no error message anywhere. If a change trips
one, the tests will not necessarily catch it.

| Rule | Where | Why |
| --- | --- | --- |
| Write `providers.json` in place — never temp-file-plus-rename | `providers-store.js` | The gateway's `fs.watch` binds to the inode; a rename makes hot reload go deaf. |
| Validate with the gateway's schema, never a copy | `schema.js` | The gateway ignores a file it rejects. |
| Full API keys never leave the main process | `providers-store.js`, `preload.js` | The renderer sees masks and returns `__UNCHANGED__`; a payload containing the mask character is rejected. |
| Write no gateway credential when a login exists **and** an enabled `passthrough` provider can use it | `claude-settings.js` | The *absence* of `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` is what keeps the subscription alive. A login alone is not enough to withhold it: with a custom base URL and no credential, Claude Code runs its login flow instead of using the gateway. |
| A provider save rewrites `~/.claude/settings.json` when routing is on | `ipc.js` | Enabling or disabling a `passthrough` provider flips whether the placeholder credential belongs there. |
| A port change rewrites it too | `ipc.js` | The port is stored there as a literal. |
| Touch only the two keys we own, and remove one only if it still holds the value we wrote | `claude-settings.js` | That file also holds permissions, hooks, and MCP config. |
| Never read `~/.claude/.credentials.json` | `claude-account.js` | Single-use rotating refresh tokens, and Anthropic's terms. Presence only. |
| Run the gateway as a child process, never in-process | `supervisor.js` | It calls `process.exit(1)` on bad config or a failed listen. |
| `exclusive: true` on the port probe | `supervisor.js` | Node sets `SO_REUSEADDR` by default, so without it the probe succeeds against a live listener and the supervisor forks into a restart loop. |
| `port-in-use` deliberately does not retry | `supervisor.js` | Retrying cannot free a port. |
| The renderer makes no network request | `index.html` CSP | `connect-src 'none'` removes the CORS surface entirely. |
| The renderer is served over `app://`, not `file://` | `main.js` | Chromium gives `file://` an opaque origin, which blocks ES module imports outright. |
| `preload.js` exposes named channels, never a generic `invoke` | `preload/preload.js` | The preload boundary is not a trust boundary; `ipc.js` re-validates regardless. |

And three in the renderer that are pure CSP and CSS mechanics:

- **No inline `style=""`.** `style-src 'self'` with no `'unsafe-inline'`. Runtime colours go through
  `style.setProperty` or SVG presentation attributes.
- **Every element hidden by the `hidden` attribute needs its own `[hidden] { display: none }`
  rule**, because any author `display` beats the UA sheet. `.tabs`, `.field`, `.view`, `.banner`,
  and `.notice` each opt out explicitly; without it the element simply stays on screen.
- **`ResizeObserver` hosts must be unobserved when detached.** `observe()` holds a strong reference
  and the dashboard rebuilds its charts on every tick.

Theming is `nativeTheme.themeSource` and nothing else: the stylesheet has one `:root` block and one
`prefers-color-scheme` query, no `[data-theme]` selector, so a stored `light` / `dark` preference
works by making Chromium lie about the OS preference. Charts measure their container and draw at 1:1
rather than scaling a fixed `viewBox`, which would scale the 10px tick text with it.

## Platform pins, and why they are not negotiable

- **Electron is pinned to `42.10.1` exactly.** `better-sqlite3` 12.11.1 ships Electron prebuilds up
  to ABI 146 (Electron 42). Electron 43 is ABI 148, so `install-app-deps` falls back to `node-gyp`
  and fails on any host without `make`. Bumping means waiting for a prebuild, or accepting
  `make` + `g++` + `python3` as build requirements for everyone.
- **`--ozone-platform=x11` has to be a real command-line argument.** Ozone is selected before the
  app's JS runs, so `app.commandLine.appendSwitch`, `--ozone-platform-hint`, and
  `ELECTRON_OZONE_PLATFORM_HINT` are all too late — measured, not assumed. It lives in the `start`
  script and in `linux.executableArgs`.
- **`asarUnpack` for `*.node`** — `process.dlopen` cannot load a native addon from inside an asar.
- **Verify the native addon by opening a database, not by requiring the module.**
  `require('better-sqlite3')` alone does not load the binding. Under plain Node,
  `new (require('better-sqlite3'))(':memory:')` must *fail* with a `NODE_MODULE_VERSION` error when
  the Electron build is correct. `@electron/rebuild` also caches in `build/Release/.forge-meta`, so
  deleting a `.node` without that marker makes `install-app-deps` a silent no-op.
- **`name` in `package.json` cannot change.** Electron derives the userData directory from it, so a
  rename orphans every existing install's `providers.json` and `usage.db`. That is why the deb's
  `Package:` is set separately via `deb.packageName`, and why `linux.executableName` — load-bearing
  for the `/usr/bin` symlink, the installed icon name, and window/tray association — is set too.
- **`deb.fpm: [--deb-compression-level, '9']` is the single biggest lever on download size.**
  electron-builder picks xz but leaves the level to fpm, whose default is `-3`: a 4 MiB dictionary
  against a 322 MB tree containing one 210 MB Chromium binary. `-9` (64 MiB) took the 0.1.1 payload
  from 96.6 MiB to 84.4 MiB with byte-identical contents. It costs the build host ~700 MB of RAM.
- **`electronLanguages: [en-US]` drops 54 of Chromium's 55 locale `.pak` files** — 46 MB installed,
  7.6 MiB compressed — and is safe because `ui::ResourceBundle` falls back to the default locale
  when the requested `.pak` is absent. Below ~75 MiB the remaining weight is all Chromium, so going
  lower means a different shell, not a packaging option.

## Tests

`node --test` over the main-process modules that own files or make irreversible changes. Electron is
stubbed by injecting a fake `app` into `require.cache` *before* the first `require('electron')`
(`test/helpers/electron-stub.js`), each install getting a fresh `mkdtemp` root, and `~/.claude` is
sandboxed through `CLAUDE_CONFIG_DIR`. The `providers-store` tests seed the temporary
`userData/providers.json` first, so the first-run migration can never copy your real keys into the
sandbox. One test is skipped off-Linux by design. There are no renderer tests.

If you touch anything under `main/`, add or extend a test. If you touch `renderer/`, say in the pull
request what you actually looked at — a `cdp-shot.js` screenshot is the expected evidence.

## Pull requests

- Branch off `main`. Keep the diff to one concern.
- `npm test` and `npm run typecheck` both clean.
- Match the surrounding code: its naming, its idiom, and in particular its comment density —
  comments here explain *why*, and usually cite the specific failure they prevent. A comment
  restating the code is worse than none.
- Say what you ran. "Tests pass" is enough for a main-process change; a renderer change wants a
  screenshot; a packaging change wants the artifact size before and after.

## Releasing

Maintainers only, and there is one way to do it:

```bash
scripts/release.sh patch --dry-run     # every check, changes nothing
scripts/release.sh patch --watch       # for real, then poll the run
```

Accepts `patch`, `minor`, `major`, or an explicit `X.Y.Z`. The script refuses a dirty tree, a branch
other than `main`, a version that is not an increase, a tag that already exists, and a version the
published pool already carries — apt will not offer an upgrade for a version it has already indexed.
Then `.github/workflows/release.yml` fires on the `v*` tag, builds both artifacts, rebuilds the APT
repository, and publishes it to `gh-pages`, which GitHub Pages serves.

**The pushed tag is the point of no return.** A version that has been indexed cannot be corrected by
re-publishing it: clients that already fetched the old `Packages` file see a hash mismatch instead
of an upgrade. This is why every check in `release.sh` runs *before* the push and none after.

Three repository secrets are required: `APT_GPG_PRIVATE_KEY` (armored), `APT_GPG_KEY_ID`
(fingerprint), and `APT_GPG_PASSPHRASE` (empty if the key has none).

`scripts/build-apt-repo.sh` rebuilds the indexes from the pool and never from a database, which is
what lets a git branch host a repository — the `.deb` files are the only state. Consequently
`keep_files: true` on the publish step is load-bearing: dropping the pool would strip every older
version out of the repository. The script also asserts each deb's `Package:` field before pooling
it, because a wrong value breaks nothing until a user runs `apt install`. To rebuild a repository by
hand:

```bash
scripts/build-apt-repo.sh --repo <dir> --add release/*.deb --unsigned
```

## Reporting bugs

Include your distribution and desktop environment, whether you installed the deb or the AppImage,
and the relevant part of `~/.config/llm-gateway-desktop/logs/gateway.log`. **Redact your API
keys** — the log should not contain them, but read what you paste.

Security issues go through [SECURITY.md](SECURITY.md), not the issue tracker.



