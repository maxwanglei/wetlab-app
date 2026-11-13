#!/usr/bin/env bash
# Fail if a private value from .env appears in a tracked or committable file, or anywhere in git
# history. The values live only in .env, so this script names none of them.
#   Usage: scripts/check-public.sh
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "no .env here, so there is nothing to check against" >&2; exit 2; }

PRIVATE="PROJECT_ID INSTANCE VM_NAME ADDRESS_NAME DB_OWNER APP_DB_USER SITE_HOST SITE_ALIASES STATIC_IP ACCOUNT_EMAIL"
MIN_LENGTH=6

files="$(mktemp)"; history="$(mktemp)"
trap 'rm -f "$files" "$history"' EXIT
git ls-files --cached --others --exclude-standard -z > "$files"
git log --all -p --format='%an <%ae> %cn <%ce>%n%B' > "$history" 2>/dev/null || true

failures=0
check() {
  local name="$1" value="$2"
  [ "${#value}" -lt "$MIN_LENGTH" ] && return
  local hits
  hits="$(xargs -0 grep -I -i -l -F -e "$value" -- < "$files" 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    echo "FAIL: the value of $name appears in:"; echo "$hits" | sed 's/^/  /'; failures=$((failures + 1))
  fi
  if grep -q -i -F -e "$value" "$history"; then
    echo "FAIL: the value of $name appears in git history"; failures=$((failures + 1))
  fi
}

while IFS= read -r line; do
  name="${line%%=*}"; value="${line#*=}"
  value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
  [ -z "$value" ] && continue
  case "$name" in
    *PASSWORD*|*SECRET*|*TOKEN*) check "$name" "$value" ;;
    SITE_ALIASES) for alias in $value; do check "$name" "$alias"; done ;;
    *) case " $PRIVATE " in *" $name "*) check "$name" "$value" ;; esac ;;
  esac
done < <(grep -E '^[A-Z_][A-Z0-9_]*=' .env)

if [ "$failures" -gt 0 ]; then
  echo "check-public: $failures problem(s); nothing private may be committed" >&2
  exit 1
fi
echo "check-public: no private value from .env in the files or the history"
