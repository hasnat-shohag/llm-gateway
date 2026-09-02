#!/usr/bin/env bash
#
# Cut a release: bump the version, commit, tag, push, and let
# .github/workflows/release.yml build the deb, rebuild the APT repository, and publish
# both.
#
# Everything before the push is a pre-flight check, because the push is the point of no
# return: apt will never offer a version it has already indexed, so re-publishing a
# version with different contents does not correct the earlier one — it leaves clients
# with a hash mismatch instead. The checks that matter therefore run before the tag is
# public, not after.
#
# Usage:
#   scripts/release.sh <patch|minor|major|X.Y.Z> [options]
#
#   patch|minor|major  Bump the current package.json version.
#   X.Y.Z              Use an explicit version instead.
#   --dry-run          Run every check, print the plan, change nothing.
#   --yes              Do not prompt before pushing.
#   --skip-tests       Skip the local typecheck and test run. CI runs both regardless;
#                      running them here fails in seconds rather than ~12 minutes.
#   --watch            Poll the Actions API until the release run finishes.
set -euo pipefail

REMOTE=origin
BRANCH=main
REPO_SLUG=hasnat-shohag/llm-gateway
PACKAGE_NAME=llm-gateway
BASE_URL="${APT_BASE_URL:-https://hasnat-shohag.github.io/llm-gateway}"
POLL_SECONDS=30
POLL_LIMIT=60

BUMP=""
DRY_RUN=0
ASSUME_YES=0
RUN_TESTS=1
WATCH=0

die() { printf 'release: %s\n' "$1" >&2; exit 1; }
note() { printf 'release: %s\n' "$1"; }

usage() {
  sed -n '/^# Usage:/,/^set -euo/p' "${BASH_SOURCE[0]}" \
    | sed -e '$d' -e 's/^#\{1,\} \{0,1\}//' -e 's/^#$//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    patch|minor|major)          BUMP="$1" ;;
    # Validated here rather than after the git checks so a typo fails instantly instead
    # of after a fetch. A leading `v` is accepted because the tag is what gets typed.
    [0-9]*|v[0-9]*)
      candidate="${1#v}"
      [[ "$candidate" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "not a version: $1"
      BUMP="$candidate"
      ;;
    --dry-run)                  DRY_RUN=1 ;;
    --yes|-y)                   ASSUME_YES=1 ;;
    --skip-tests)               RUN_TESTS=0 ;;
    --watch)                    WATCH=1 ;;
    -h|--help)                  usage; exit 0 ;;
    *)                          die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done

[[ -n "$BUMP" ]] || die "give patch, minor, major, or an explicit X.Y.Z (try --help)"

cd "$(dirname "${BASH_SOURCE[0]}")/.."

command -v node >/dev/null || die "node is required"
command -v curl >/dev/null || die "curl is required"
# npm ci in the workflow needs the lockfile, and the version bump has to move both files
# together or the tag-versus-package.json check in CI fails on a stale lock.
[[ -f package.json && -f package-lock.json ]] \
  || die "package.json and package-lock.json must both exist"

branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "$BRANCH" ]] || die "on $branch, but releases are cut from $BRANCH"

[[ -z "$(git status --porcelain)" ]] || die "working tree is dirty; commit or stash first"

note "fetching $REMOTE"
git fetch --quiet --tags "$REMOTE"

local_head="$(git rev-parse HEAD)"
remote_head="$(git rev-parse "$REMOTE/$BRANCH")"
[[ "$local_head" == "$remote_head" ]] || die \
  "$BRANCH is at ${local_head:0:7} but $REMOTE/$BRANCH is at ${remote_head:0:7}; push or pull first"

CURRENT="$(node -p 'require("./package.json").version')"

case "$BUMP" in
  patch|minor|major)
    IFS=. read -r major minor patch <<<"$CURRENT"
    [[ "$major$minor$patch" =~ ^[0-9]+$ ]] \
      || die "cannot bump $CURRENT automatically; pass an explicit X.Y.Z"
    case "$BUMP" in
      major) major=$((major + 1)); minor=0; patch=0 ;;
      minor) minor=$((minor + 1)); patch=0 ;;
      patch) patch=$((patch + 1)) ;;
    esac
    VERSION="$major.$minor.$patch"
    ;;
  *)
    VERSION="$BUMP"
    ;;
esac

TAG="v$VERSION"

# apt compares versions, so going backwards produces a repository that offers an upgrade
# nobody can install.
newest="$(printf '%s\n%s\n' "$CURRENT" "$VERSION" | sort -V | tail -1)"
[[ "$newest" == "$VERSION" && "$VERSION" != "$CURRENT" ]] \
  || die "$VERSION does not come after the current version $CURRENT"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  die "tag $TAG already exists locally"
fi
[[ -z "$(git ls-remote --tags "$REMOTE" "refs/tags/$TAG")" ]] \
  || die "tag $TAG already exists on $REMOTE"

# The published pool is the authority on what apt has already seen. A local tag can be
# deleted; an indexed version cannot be taken back from clients that have fetched it.
packages_url="$BASE_URL/dists/stable/main/binary-amd64/Packages"
if published="$(curl -fsS --max-time 20 "$packages_url" 2>/dev/null)"; then
  if grep -qx "Version: $VERSION" <<<"$published"; then
    die "$VERSION is already in the published pool; apt will not offer it again"
  fi
  note "already published: $(grep '^Version: ' <<<"$published" \
    | sed 's/^Version: //' | sort -V | tr '\n' ' ')"
else
  note "could not read $packages_url; skipping the already-published check"
fi

if (( RUN_TESTS )); then
  note "typecheck"
  npm run --silent typecheck
  note "tests"
  npm run --silent test
else
  note "skipping the local typecheck and tests"
fi

cat <<PLAN

  current version   $CURRENT
  new version       $VERSION
  tag               $TAG
  commit            chore: release $TAG
  push              $REMOTE $BRANCH, then $REMOTE $TAG

PLAN

if (( DRY_RUN )); then
  note "dry run: every check passed, nothing was changed"
  exit 0
fi

if (( ! ASSUME_YES )); then
  echo "Pushing $TAG triggers the release workflow, which publishes the .deb to the APT"
  echo "repository at $BASE_URL and creates a public GitHub release."
  echo "Anyone who has added the repository will be offered $VERSION on their next"
  echo "apt update, and the version number cannot be reused afterwards."
  echo
  read -r -p "Continue? [y/N] " reply
  case "$reply" in
    y|Y|yes|YES) ;;
    *) die "aborted; nothing was changed" ;;
  esac
fi

# --no-git-tag-version because the commit and tag are made here, together, with a message
# that matches the repository's conventions.
npm version "$VERSION" --no-git-tag-version >/dev/null
git commit --quiet -m "chore: release $TAG" -- package.json package-lock.json
git tag -a "$TAG" -m "$TAG"
note "committed $(git rev-parse --short HEAD), tagged $TAG"
note "to undo before the push: git tag -d $TAG && git reset --hard HEAD~1"

git push --quiet "$REMOTE" "$BRANCH"
git push --quiet "$REMOTE" "$TAG"
note "pushed $BRANCH and $TAG"
note "run: https://github.com/$REPO_SLUG/actions/workflows/release.yml"

if (( WATCH )); then
  # Unauthenticated reads are enough for a public repository, and are rate limited to 60
  # an hour — which is why this polls on a 30s cadence rather than a tight loop.
  run_state() {
    curl -fsS --max-time 20 \
      "https://api.github.com/repos/$REPO_SLUG/actions/runs?event=push&per_page=20" 2>/dev/null \
      | node -e '
        let raw = ""
        process.stdin.on("data", chunk => (raw += chunk))
        process.stdin.on("end", () => {
          let runs = []
          try { runs = JSON.parse(raw).workflow_runs || [] } catch { return }
          const run = runs.find(r => r.head_branch === process.argv[1])
          if (run) console.log([run.status, run.conclusion || "", run.html_url].join("\t"))
        })
      ' "$1" 2>/dev/null
  }

  note "polling for up to $((POLL_SECONDS * POLL_LIMIT / 60)) minutes"
  status=""
  for (( attempt = 1; attempt <= POLL_LIMIT; attempt++ )); do
    IFS=$'\t' read -r status conclusion url <<<"$(run_state "$TAG" || true)"
    case "$status" in
      completed)
        note "run ${conclusion:-unknown}: $url"
        [[ "$conclusion" == success ]] || die "the release run did not succeed"
        break
        ;;
      "") note "no run for $TAG yet" ;;
      *)  note "run $status" ;;
    esac
    sleep "$POLL_SECONDS"
  done
  [[ "$status" == completed ]] || note "stopped polling; check the run in the browser"
fi

cat <<DONE

Verify the published index:

  curl -fsS $BASE_URL/dists/stable/main/binary-amd64/Packages | grep -E '^(Package|Version):'

Verify a clean install:

  docker run --rm debian:12 sh -c 'apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null && curl -fsSL $BASE_URL/install.sh | sh && apt-cache policy $PACKAGE_NAME'

Existing installs pick $VERSION up with:

  sudo apt update && sudo apt install --only-upgrade $PACKAGE_NAME

DONE
