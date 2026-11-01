#!/bin/bash
# Runs in GitHub Actions (.github/workflows/deploy.yml). Asks cPanel to pull
# main and run .cpanel.yml, then waits until the live app answers /health
# from a fresh process.
#
#   1. UAPI VersionControl/update            (pull the latest main into ~/aqdi-src)
#   2. UAPI VersionControlDeployment/create  (run .cpanel.yml)
#   3. GET $HEALTH_URL every $HEALTH_INTERVAL s, at most $HEALTH_ATTEMPTS times:
#      success = HTTP 200, status "ok" and uptimeSeconds below 180 and below
#      the seconds since step 2 (so the process started after this deploy).
#
# Env: CPANEL_HOST, CPANEL_USER, CPANEL_API_TOKEN (GitHub secrets), HEALTH_URL.
# Missing secrets = a notice and exit 0 (deploy skipped, not failed).
# The token is passed to curl through a config on stdin, never on the command
# line, and nothing here prints it. Needs curl and jq.
# CPANEL_BASE_URL overrides https://$CPANEL_HOST:2083 (tests only).

set -euo pipefail

# stderr: also readable when called inside $(...).
fail() {
  echo "::error::Deploy failed: $*" >&2
  exit 1
}

if [ -z "${CPANEL_HOST:-}" ] || [ -z "${CPANEL_USER:-}" ] || [ -z "${CPANEL_API_TOKEN:-}" ]; then
  echo "::notice::Deploy skipped: add the CPANEL_HOST, CPANEL_USER and CPANEL_API_TOKEN secrets (Settings > Secrets and variables > Actions). See docs/DEPLOY_AUTO.md."
  exit 0
fi
[ -n "${HEALTH_URL:-}" ] || fail "HEALTH_URL is not set."

# Derived values hold the user name: hide them in the log too.
REPO_ROOT="/home/${CPANEL_USER}/aqdi-src"
echo "::add-mask::${CPANEL_HOST}"
echo "::add-mask::${CPANEL_USER}"
echo "::add-mask::${REPO_ROOT}"

BASE_URL="${CPANEL_BASE_URL:-https://${CPANEL_HOST}:2083}"
ATTEMPTS="${HEALTH_ATTEMPTS:-12}"
INTERVAL="${HEALTH_INTERVAL:-10}"
MAX_UPTIME=180

# One UAPI call. $1 = Module/function, then name=value pairs (URL-encoded by curl).
uapi() {
  local fn="$1"
  shift
  local args=()
  for pair in "$@"; do args+=(--data-urlencode "$pair"); done
  local out code body
  out=$(printf 'header = "Authorization: cpanel %s:%s"\n' "$CPANEL_USER" "$CPANEL_API_TOKEN" \
    | curl -sS --max-time 60 -K - -G "${args[@]}" -w '\n%{http_code}' "${BASE_URL}/execute/${fn}") \
    || fail "${fn}: cPanel did not answer (network or TLS error). Check CPANEL_HOST and that the runner can reach port 2083."
  code="${out##*$'\n'}"
  body="${out%$'\n'*}"
  if [ "$code" = "401" ] || [ "$code" = "403" ]; then
    fail "${fn}: cPanel refused the API token (HTTP ${code}). Check CPANEL_USER and CPANEL_API_TOKEN."
  fi
  if [ "$code" != "200" ]; then
    fail "${fn}: cPanel answered HTTP ${code}."
  fi
  if [ "$(printf '%s' "$body" | jq -r '.status // 0' 2>/dev/null)" != "1" ]; then
    local errors
    errors=$(printf '%s' "$body" | jq -r '(.errors // ["no error text"]) | map(tostring) | join("; ")' 2>/dev/null || echo 'unreadable answer')
    fail "${fn}: ${errors}"
  fi
  printf '%s' "$body"
}

echo "1/3 Pulling the latest main into the cPanel repository"
uapi VersionControl/update "repository_root=${REPO_ROOT}" "branch=main" >/dev/null

echo "2/3 Starting the cPanel deployment (.cpanel.yml)"
started=$(date +%s)
deploy=$(uapi VersionControlDeployment/create "repository_root=${REPO_ROOT}")
deploy_id=$(printf '%s' "$deploy" | jq -r '.data.deploy_id // empty' 2>/dev/null || true)
echo "Deployment queued${deploy_id:+ (id ${deploy_id})}."

echo "3/3 Waiting for the app to restart (${ATTEMPTS} checks, every ${INTERVAL} s)"
last="no answer yet"
for i in $(seq 1 "$ATTEMPTS"); do
  sleep "$INTERVAL"
  elapsed=$(( $(date +%s) - started ))
  if res=$(curl -sS --max-time 15 -w '\n%{http_code}' "$HEALTH_URL" 2>/dev/null); then
    code="${res##*$'\n'}"
    body="${res%$'\n'*}"
    status=$(printf '%s' "$body" | jq -r '.status // empty' 2>/dev/null || true)
    uptime=$(printf '%s' "$body" | jq -r '.uptimeSeconds // empty' 2>/dev/null || true)
    last="HTTP ${code}, status ${status:-?}, uptime ${uptime:-?} s"
    if [ "$code" = "200" ] && [ "$status" = "ok" ] && [[ "$uptime" =~ ^[0-9]+$ ]] \
      && [ "$uptime" -lt "$MAX_UPTIME" ] && [ "$uptime" -le "$elapsed" ]; then
      echo "Check ${i}: ${last}. The app restarted after this deploy."
      echo "::notice::Deployed and restarted (${last})."
      exit 0
    fi
    if [ "$code" = "200" ] && [ "$status" = "maintenance" ]; then
      echo "Check ${i}: ${last} (the app started in maintenance mode; see /health/detail)."
    else
      echo "Check ${i}: ${last}."
    fi
  else
    last="no answer"
    echo "Check ${i}: no answer."
  fi
done

fail "the app did not confirm a restart within $(( ATTEMPTS * INTERVAL )) s (last: ${last}). Open cPanel > Git Version Control > Manage > Pull or Deploy to read the deployment log, and docs/DEPLOY_AUTO.md."
