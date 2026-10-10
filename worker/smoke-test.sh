#!/bin/sh
set -eu

ORIGIN="${1:-${PUBLIC_ORIGIN:-}}"
if [ -z "$ORIGIN" ]; then
  echo "Usage: PUBLIC_ORIGIN=https://worker.example.com sh smoke-test.sh" >&2
  exit 2
fi
ORIGIN="${ORIGIN%/}"
TMP="${TMPDIR:-/tmp}/cloud-mail-smoke-$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

request() {
  name="$1"
  expected="$2"
  shift 2
  status="$(curl -sS -o "$TMP/$name.body" -D "$TMP/$name.headers" -w '%{http_code}' "$@")"
  if [ "$status" != "$expected" ]; then
    echo "FAIL $name: expected HTTP $expected, got $status" >&2
    cat "$TMP/$name.body" >&2
    exit 1
  fi
  echo "PASS $name: HTTP $status"
}

request health 200 "$ORIGIN/health"
grep -qx 'ok' "$TMP/health.body"

request google_callback 302 "$ORIGIN/oauth/google/callback?error=access_denied&state=smoke-test"
grep -qi '^location: scripting://oauth_callback/gmail-cloud-mail-manager?error=access_denied&state=smoke-test' "$TMP/google_callback.headers"

request microsoft_callback 302 "$ORIGIN/oauth/microsoft/callback?error=access_denied&state=smoke-test"
grep -qi '^location: scripting://oauth_callback/microsoft-cloud-mail-manager?error=access_denied&state=smoke-test' "$TMP/microsoft_callback.headers"

request v1_unauthorized 401 -X POST "$ORIGIN/v1/mail/messages/list" -H 'Content-Type: application/json' --data '{}'
request v1_wrong_method 405 "$ORIGIN/v1/mail/messages/list"
request push_unauthorized 401 "$ORIGIN/v1/push/config"
request push_wrong_method_unauthorized 401 -X POST "$ORIGIN/v1/push/config" -H 'Content-Type: application/json' --data '{}'

if [ -n "${RELAY_CLIENT_SECRET:-}" ]; then
  AUTH="Authorization: Bearer $RELAY_CLIENT_SECRET"
  request v1_content_type 415 -X POST "$ORIGIN/v1/mail/messages/list" -H "$AUTH" -H 'Content-Type: text/plain' --data '{}'
  request v1_truncated_json 400 -X POST "$ORIGIN/v1/mail/messages/list" -H "$AUTH" -H 'Content-Type: application/json' --data '{'
  request v1_invalid_operation 400 -X POST "$ORIGIN/v1/mail/messages/modify" -H "$AUTH" -H 'Content-Type: application/json' --data '{"operation":"archive"}'
else
  echo "SKIP authenticated malformed-request tests: RELAY_CLIENT_SECRET is not set"
fi

if [ -n "${MAIL_PUSH_ADMIN_TOKEN:-}" ]; then
  PUSH_AUTH="Authorization: Bearer $MAIL_PUSH_ADMIN_TOKEN"
  request push_status 200 "$ORIGIN/v1/push/config" -H "$PUSH_AUTH"
else
  echo "SKIP authenticated push status test: MAIL_PUSH_ADMIN_TOKEN is not set"
fi

echo "Unified mail gateway smoke tests passed."
