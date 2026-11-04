#!/bin/bash
# Runs ON THE SERVER, started by .cpanel.yml (cPanel > Git Version Control >
# Deploy), from the repository checkout (/home/<user>/aqdi-src).
#
#   1. checks the Node.js virtual environment exists (fails loudly otherwise,
#      before anything is copied)
#   2. copies the app files to the application root (never .env, uploads,
#      backups, node_modules or runtime folders; nothing is deleted there)
#   3. npm install --omit=dev inside the application root, in that environment
#   4. touches tmp/restart.txt so Passenger restarts the app
#
# Needs DEPLOYPATH and NODEVENV_ACTIVATE (set in .cpanel.yml). No secrets.

set -euo pipefail

fail() {
  echo "AQDI DEPLOY FAILED: $*" >&2
  exit 1
}

[ -n "${DEPLOYPATH:-}" ] || fail "DEPLOYPATH is not set (see .cpanel.yml)."
[ -n "${NODEVENV_ACTIVATE:-}" ] || fail "NODEVENV_ACTIVATE is not set (see .cpanel.yml)."
# An empty HOME would give "/aqdi": refuse anything that is not at least /<dir>/<app>.
case "$DEPLOYPATH" in
  /?*/?*) ;;
  *) fail "DEPLOYPATH=$DEPLOYPATH is not an application root like /home/<user>/aqdi (is HOME set for the deploy tasks?)." ;;
esac
[ -f package.json ] && [ -f server.js ] || fail "run this from the repository root (package.json and server.js not found in $(pwd))."
[ -d "$DEPLOYPATH" ] || fail "application root $DEPLOYPATH does not exist. Create the app in cPanel > Setup Node.js App first."
[ -f "$NODEVENV_ACTIVATE" ] || fail "Node.js activate script not found: $NODEVENV_ACTIVATE
Set NODE_VERSION at the top of .cpanel.yml to the Node.js version of the app in
cPanel > Setup Node.js App (the folder name under ~/nodevenv/aqdi/), commit and deploy again.
Nothing was copied."

echo "Copying files to $DEPLOYPATH"
# No --delete: .env, uploads, backups and anything the app writes must survive.
# --checksum: compare contents, so a changed file with the same size and time is never skipped.
rsync -a --checksum \
  --exclude='.git' --exclude='.github' --exclude='.cpanel.yml' \
  --exclude='node_modules' --exclude='.env' --exclude='.env.*' \
  --exclude='tests' --exclude='docs' --exclude='reference' --exclude='*.md' \
  --exclude='uploads' --exclude='storage' --exclude='backups' --exclude='tmp' \
  --exclude='*.log' \
  ./ "$DEPLOYPATH/"

cd "$DEPLOYPATH"
echo "Installing production dependencies"
# The activate script of cPanel's Node.js environment is not written for "set -u".
set +u
# shellcheck disable=SC1090
source "$NODEVENV_ACTIVATE"
set -u
command -v npm >/dev/null 2>&1 || fail "npm not found after activating $NODEVENV_ACTIVATE."
npm install --omit=dev --no-audit --no-fund || fail "npm install failed in $DEPLOYPATH. The app was NOT restarted; the old version keeps running until the next restart."

mkdir -p tmp
touch tmp/restart.txt
# CloudLinux/LiteSpeed hosts (Namecheap) do not always pick up tmp/restart.txt,
# so restart through the Node.js selector when it is available.
if command -v cloudlinux-selector >/dev/null 2>&1; then
  APP_ROOT_REL="${DEPLOYPATH#"$HOME"/}"
  if cloudlinux-selector restart --json --interpreter nodejs --app-root "$APP_ROOT_REL" >/dev/null 2>&1; then
    echo "App restarted with cloudlinux-selector."
  else
    echo "cloudlinux-selector restart did not succeed; relying on tmp/restart.txt."
  fi
fi
echo "Deploy done: tmp/restart.txt touched, Passenger restarts the app on its next request."
