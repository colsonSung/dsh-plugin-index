#!/usr/bin/env bash
# Publish index.json to the gh-pages branch that GitHub Pages serves.
#
#   npm run build && npm run validate && ./scripts/publish-pages.sh
#
# Override the target with DSH_INDEX_REPO=owner/name.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${DSH_INDEX_REPO:-colsonSung/dsh-plugin-index}"
BRANCH="gh-pages"

cd "$ROOT"
if [[ ! -f index.json ]]; then
  echo "index.json not found — run 'npm run build' first." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if git ls-remote --exit-code --heads "https://github.com/${REPO}.git" "$BRANCH" >/dev/null 2>&1; then
  git clone --quiet --depth 1 --branch "$BRANCH" "https://github.com/${REPO}.git" "$WORK"
else
  git init --quiet -b "$BRANCH" "$WORK"
  git -C "$WORK" remote add origin "https://github.com/${REPO}.git"
fi

cp index.json "$WORK/index.json"
touch "$WORK/.nojekyll"
git -C "$WORK" add index.json .nojekyll
git -C "$WORK" \
  -c user.name="${GIT_AUTHOR_NAME:-dsh-index}" \
  -c user.email="${GIT_AUTHOR_EMAIL:-dsh-index@users.noreply.github.com}" \
  commit --quiet -m "Publish index.json $(date -u +%Y-%m-%dT%H:%M:%SZ)" || echo "(index.json unchanged)"

git -C "$WORK" push --quiet origin "$BRANCH"
echo "Pushed index.json to ${REPO}@${BRANCH}"
echo "Index URL: https://${REPO%%/*}.github.io/${REPO##*/}/index.json"
