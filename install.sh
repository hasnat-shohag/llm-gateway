#!/usr/bin/env sh
#
# Add the LLM Gateway APT repository, then install the app.
#
#   curl -fsSL https://hasnat-shohag.github.io/llm-gateway/install.sh | sh
#
# This writes two files and installs one package. Read it before piping it to a shell;
# everything it does is also spelled out at https://hasnat-shohag.github.io/llm-gateway if you would rather run the
# steps yourself.
set -eu

REPO_URL="https://hasnat-shohag.github.io/llm-gateway"
KEYRING_URL="$REPO_URL/llm-gateway-archive-keyring.gpg"
KEYRING_PATH="/etc/apt/keyrings/llm-gateway.gpg"
SOURCES_PATH="/etc/apt/sources.list.d/llm-gateway.sources"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

command -v apt-get >/dev/null 2>&1 || die "this installer needs apt — see $REPO_URL for the AppImage"
command -v curl >/dev/null 2>&1 || die "curl is required"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "run this as root, or install sudo"
  SUDO="sudo"
fi

arch="$(dpkg --print-architecture)"
[ "$arch" = "amd64" ] || die "only amd64 is published; this machine is $arch — see $REPO_URL for the AppImage"

say "Installing the repository signing key into $KEYRING_PATH"
$SUDO install -d -m 0755 /etc/apt/keyrings
curl -fsSL "$KEYRING_URL" | $SUDO tee "$KEYRING_PATH" >/dev/null
$SUDO chmod 0644 "$KEYRING_PATH"

say "Writing $SOURCES_PATH"
$SUDO tee "$SOURCES_PATH" >/dev/null <<EOF
Types: deb
URIs: $REPO_URL
Suites: stable
Components: main
Architectures: amd64
Signed-By: $KEYRING_PATH
EOF

say "Updating package lists"
$SUDO apt-get update

say "Installing llm-gateway"
$SUDO apt-get install -y llm-gateway

say "Done. Launch it from your application menu, or run: llm-gateway"
