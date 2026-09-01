#!/usr/bin/env bash
#
# Regenerate a signed APT repository from the .deb files in its pool.
#
# Indexes are rebuilt from scratch on every run: apt-ftparchive scans the pool rather
# than consulting a database, so the pool is the only state that has to survive between
# releases. That is what makes a git branch a viable host — there is no database to
# corrupt, and nothing that can fall out of step with the files actually present.
#
# Usage:
#   scripts/build-apt-repo.sh --repo <dir> [--add <deb>...] [--key <keyid>] [--unsigned]
#                             [--base-url <url>]
#
#   --repo      Repository root. Created if missing. This is what gets published.
#   --add       .deb files to copy into the pool before reindexing. Repeatable.
#   --key       GPG key id or uid to sign with. Defaults to $APT_SIGNING_KEY.
#   --unsigned  Skip signing. For local inspection only — apt refuses an unsigned repo.
#   --base-url  Public URL of the published repository, baked into install.sh.
set -euo pipefail

SUITE=stable
COMPONENT=main
ARCH=amd64
PACKAGE_NAME=llm-gateway
KEYRING_NAME=llm-gateway-archive-keyring.gpg

REPO_DIR=""
KEY_ID="${APT_SIGNING_KEY:-}"
BASE_URL="${APT_BASE_URL:-https://hasnat-shohag.github.io/llm-gateway}"
SIGN=1
ADD=()

here() { cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd; }
SRC_ROOT="$(here)"
CONF="$SRC_ROOT/packaging/apt/apt-ftparchive.conf"

die() { printf 'build-apt-repo: %s\n' "$1" >&2; exit 1; }
note() { printf 'build-apt-repo: %s\n' "$1"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)     REPO_DIR="${2:-}"; shift 2 ;;
    --key)      KEY_ID="${2:-}"; shift 2 ;;
    --base-url) BASE_URL="${2:-}"; shift 2 ;;
    --unsigned) SIGN=0; shift ;;
    --add)
      shift
      while [[ $# -gt 0 && "$1" != --* ]]; do ADD+=("$1"); shift; done
      ;;
    -h|--help)  sed -n '3,17p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)          die "unknown argument: $1" ;;
  esac
done

[[ -n "$REPO_DIR" ]] || die "--repo is required"
command -v apt-ftparchive >/dev/null || die "apt-ftparchive not found — install apt-utils"
command -v dpkg-deb >/dev/null || die "dpkg-deb not found — install dpkg"
[[ -f "$CONF" ]] || die "missing $CONF"
if (( SIGN )); then
  command -v gpg >/dev/null || die "gpg not found"
  [[ -n "$KEY_ID" ]] || die "signing requires --key or \$APT_SIGNING_KEY (or pass --unsigned)"
fi

POOL_REL="pool/$COMPONENT"
DIST_REL="dists/$SUITE"
BINARY_REL="$DIST_REL/$COMPONENT/binary-$ARCH"

mkdir -p "$REPO_DIR/$POOL_REL" "$REPO_DIR/$BINARY_REL"
REPO_DIR="$(cd "$REPO_DIR" && pwd)"

# Copy in new packages, refusing any whose control fields would not answer to
# `apt install llm-gateway`. A wrong Package field produces no error anywhere in the
# publishing pipeline; it only shows up as "Unable to locate package" on a user's
# machine, long after the fact.
for deb in "${ADD[@]:-}"; do
  [[ -n "$deb" ]] || continue
  [[ -f "$deb" ]] || die "no such file: $deb"

  actual="$(dpkg-deb -f "$deb" Package)"
  [[ "$actual" == "$PACKAGE_NAME" ]] \
    || die "$deb has Package: $actual, expected $PACKAGE_NAME — check deb.packageName in electron-builder.yml"

  arch="$(dpkg-deb -f "$deb" Architecture)"
  [[ "$arch" == "$ARCH" ]] \
    || die "$deb is Architecture: $arch, but this repository indexes $ARCH only"

  version="$(dpkg-deb -f "$deb" Version)"
  note "adding $PACKAGE_NAME $version ($arch)"
  install -m 0644 "$deb" "$REPO_DIR/$POOL_REL/$(basename "$deb")"
done

shopt -s nullglob
pooled=("$REPO_DIR/$POOL_REL"/*.deb)
shopt -u nullglob
(( ${#pooled[@]} )) || die "pool is empty — pass --add <deb>"

cd "$REPO_DIR"

# Filename fields in Packages are written relative to the process's cwd, and apt resolves
# them against the repository root, so this must run from the root and name a relative path.
apt-ftparchive --arch "$ARCH" packages "$POOL_REL" > "$BINARY_REL/Packages"
gzip -9cn "$BINARY_REL/Packages" > "$BINARY_REL/Packages.gz"

# Delete the previous Release trio first: apt-ftparchive checksums everything it finds
# under the suite directory, and a stale Release would otherwise be hashed into its own
# replacement.
rm -f "$DIST_REL/Release" "$DIST_REL/Release.gpg" "$DIST_REL/InRelease"
apt-ftparchive -c="$CONF" release "$DIST_REL" > "$DIST_REL/Release.tmp"
mv "$DIST_REL/Release.tmp" "$DIST_REL/Release"

if (( SIGN )); then
  gpg_opts=(--batch --yes --local-user "$KEY_ID")
  if [[ -n "${GPG_PASSPHRASE:-}" ]]; then
    gpg_opts+=(--pinentry-mode loopback --passphrase "$GPG_PASSPHRASE")
  fi
  # Both forms: InRelease for apt >= 1.1, detached Release.gpg for older clients.
  gpg "${gpg_opts[@]}" --clearsign -o "$DIST_REL/InRelease" "$DIST_REL/Release"
  gpg "${gpg_opts[@]}" --detach-sign --armor -o "$DIST_REL/Release.gpg" "$DIST_REL/Release"
  # Dearmored, because that is the form `Signed-By:` expects on disk.
  gpg --batch --yes --export "$KEY_ID" > "$KEYRING_NAME"
  note "signed with $KEY_ID"
else
  note "UNSIGNED — apt will refuse this repository; for local inspection only"
fi

# Static files served alongside the indexes. .nojekyll keeps GitHub Pages from
# rewriting the tree it is asked to serve verbatim.
touch .nojekyll
sed -e "s|@BASE_URL@|$BASE_URL|g" -e "s|@KEYRING@|$KEYRING_NAME|g" -e "s|@SUITE@|$SUITE|g" \
  -e "s|@COMPONENT@|$COMPONENT|g" -e "s|@ARCH@|$ARCH|g" -e "s|@PACKAGE@|$PACKAGE_NAME|g" \
  "$SRC_ROOT/packaging/apt/install.sh.in" > install.sh
chmod 0755 install.sh
sed -e "s|@BASE_URL@|$BASE_URL|g" -e "s|@KEYRING@|$KEYRING_NAME|g" -e "s|@SUITE@|$SUITE|g" \
  -e "s|@COMPONENT@|$COMPONENT|g" -e "s|@ARCH@|$ARCH|g" -e "s|@PACKAGE@|$PACKAGE_NAME|g" \
  "$SRC_ROOT/packaging/apt/index.html.in" > index.html

note "repository ready at $REPO_DIR (${#pooled[@]} package(s) in pool)"
