# Security policy

## Supported versions

Fixes go into the latest release. There are no maintained branches for older versions — because
distribution is an APT repository, `apt upgrade` is the update path for everyone.

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private vulnerability reporting:

> [Report a vulnerability](https://github.com/hasnat-shohag/llm-gateway/security/advisories/new)
> — or the *Report a vulnerability* button under the repository's **Security** tab.

That opens a private thread visible only to the maintainers. Include:

- what an attacker can do, and what they need in order to do it (local user? a malicious provider
  endpoint? a crafted `providers.json`?)
- the version — `apt policy llm-gateway` for a deb install, or the AppImage's filename
- reproduction steps, and a proof of concept if you have one
- your distribution and desktop environment, if it matters

Expect an acknowledgement within a few days. This is a small project maintained in spare time, so
please allow reasonable time for a fix before disclosing publicly. Credit in the advisory is yours
unless you would rather not have it.

**Never include a real API key, an `~/.claude/.credentials.json`, or an unredacted `providers.json`
in a report.** If a key has been exposed in the course of finding the bug, rotate it with the
provider first.

## What is in scope

The app's own code: `main/`, `preload/`, `renderer/`, `scripts/`, the packaging under `packaging/`,
and the release workflow. Concretely, the things most worth attacking:

- an API key reaching the renderer, a log file, a crash dump, or the network
- anything that reads `~/.claude/.credentials.json` — nothing here is allowed to
- a write to `~/.claude/settings.json` that damages keys the app does not own, or that leaves the
  subscription-passthrough case silently broken
- escaping the `app://` protocol handler's containment check to read a file outside `renderer/`
- reaching a privileged IPC channel from renderer content, or bypassing the payload re-validation in
  `main/ipc.js`
- a path traversal or injection in `scripts/build-apt-repo.sh` or `install.sh`, both of which run as
  root on a user's machine
- anything that causes the app to start the gateway on an address other than `127.0.0.1`

## What is not

- **The gateway's own request path.** `gateway-src/` is vendored, not authored here. Report those to
  [llm-gateway-for-claude-code](https://github.com/hasnat-shohag/llm-gateway-for-claude-code) —
  though if you are unsure which side owns the bug, report it here and it will be routed.
- **The gateway having no authentication of its own.** The supervisor forks it with `HOST=127.0.0.1`
  hardcoded, and the app exposes no setting to change that; it is a local process for local use.
  Running the gateway yourself on a routable address is your configuration, not a vulnerability.
  Anything that makes the app's own child bind non-loopback is in scope, and very much wanted.
- **A malicious provider you added yourself.** Adding an endpoint is an explicit act of trust: you
  are handing it your requests. A provider *escalating* beyond that — reading local files, executing
  code, extracting another provider's key — is in scope.
- **Anyone with your user account.** `providers.json` is an ordinary file in your home directory,
  not a vault; a process running as you can read it, exactly as it can read your SSH keys. An OS
  keyring would be a reasonable feature request, not a vulnerability report.
- Findings from automated scanners with no demonstrated impact, and vulnerabilities in Electron or
  Chromium themselves — those belong upstream, though a report that this app is pinned to a version
  carrying a known exploitable CVE is welcome and useful.

## What the app already guarantees

Worth knowing before you start, because these are enforced deliberately and a break in any of them
is a genuine finding:

- Full API keys never leave the main process. The renderer receives masks and returns a sentinel for
  unchanged values; a save payload containing a mask character is rejected rather than written.
- `~/.claude/.credentials.json` is never read — presence of a login is checked, nothing more.
- `~/.claude/settings.json` writes touch only the two keys the app owns, remove a key only when it
  still holds the value the app wrote, refuse to overwrite a file that does not parse, and leave a
  timestamped backup.
- The renderer makes no network requests: its CSP sets `connect-src 'none'` and forbids inline
  styles and scripts. It is served over `app://` with a containment check on every path.
- `preload/preload.js` exposes a fixed list of named channels and no generic `invoke`, and every
  payload is re-validated in the main process regardless.
- The gateway runs as a child process and binds `127.0.0.1`.
