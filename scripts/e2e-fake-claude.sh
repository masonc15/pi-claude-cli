#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAKE_DIR="$ROOT/tests/fixtures/fake-claude"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pi-claude-cli-e2e.XXXXXX")"
PI_MODEL="pi-claude-cli/claude-sonnet-4-5-20250929"
RUN_OUT=""
RUN_ERR=""
RUN_STATUS=0

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  echo "e2e-fake-claude: $*" >&2
  if [[ -n "${RUN_OUT:-}" && -f "$RUN_OUT" ]]; then
    echo "--- stdout ---" >&2
    sed -n '1,160p' "$RUN_OUT" >&2
  fi
  if [[ -n "${RUN_ERR:-}" && -f "$RUN_ERR" ]]; then
    echo "--- stderr ---" >&2
    sed -n '1,160p' "$RUN_ERR" >&2
  fi
  exit 1
}

assert_status() {
  local expected="$1"
  if [[ "$RUN_STATUS" -ne "$expected" ]]; then
    fail "expected exit status $expected, got $RUN_STATUS"
  fi
}

assert_status_nonzero() {
  if [[ "$RUN_STATUS" -eq 0 ]]; then
    fail "expected non-zero exit status"
  fi
}

assert_contains() {
  local file="$1"
  local needle="$2"
  if ! grep -Fq "$needle" "$file"; then
    fail "expected $file to contain: $needle"
  fi
}

assert_not_contains() {
  local file="$1"
  local needle="$2"
  if grep -Fq "$needle" "$file"; then
    fail "expected $file not to contain: $needle"
  fi
}

run_pi_case() {
  local name="$1"
  local mode="$2"
  local prompt="$3"
  local case_dir="$TMP_ROOT/$name"
  mkdir -p "$case_dir/agent" "$case_dir/sessions"
  RUN_OUT="$case_dir/stdout.txt"
  RUN_ERR="$case_dir/stderr.txt"
  local state_file="$case_dir/fake-state.txt"
  local arg_log="$case_dir/fake-args.jsonl"

  set +e
  (
    PATH="$FAKE_DIR:$PATH" \
      PI_CODING_AGENT_DIR="$case_dir/agent" \
      PI_CODING_AGENT_SESSION_DIR="$case_dir/sessions" \
      PI_OFFLINE=1 \
      NO_COLOR=1 \
      PI_CLAUDE_CLI_FAKE_MODE="$mode" \
      PI_CLAUDE_CLI_FAKE_STATE_FILE="$state_file" \
      PI_CLAUDE_CLI_FAKE_ARG_LOG="$arg_log" \
      pi \
        --offline \
        --no-session \
        --no-extensions \
        --extension "$ROOT/index.ts" \
        --no-skills \
        --no-prompt-templates \
        --no-themes \
        --no-context-files \
        --tools read \
        --model "$PI_MODEL" \
        -p "$prompt" \
        >"$RUN_OUT" \
        2>"$RUN_ERR"
  ) &
  local pid=$!
  local elapsed_tenths=0
  local max_tenths=200
  while kill -0 "$pid" 2>/dev/null; do
    if [[ "$elapsed_tenths" -ge "$max_tenths" ]]; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null
      RUN_STATUS=124
      set -e
      return
    fi
    sleep 0.1
    elapsed_tenths=$((elapsed_tenths + 1))
  done
  wait "$pid"
  RUN_STATUS=$?
  set -e
}

run_pi_case "text" "text" "say hello"
assert_status 0
assert_contains "$RUN_OUT" "fake text response"
assert_not_contains "$RUN_ERR" "fake rate limit"

run_pi_case "result-error" "error" "fail visibly"
assert_status_nonzero
assert_contains "$RUN_ERR" "fake rate limit"

run_pi_case "crash" "crash" "crash visibly"
assert_status_nonzero
assert_contains "$RUN_ERR" "fake crash from claude"

run_pi_case "tool-once" "tool-once" "read package.json"
assert_status 0
assert_contains "$RUN_OUT" "fake tool followup"
assert_not_contains "$RUN_OUT" "fake tool was not intercepted"

echo "e2e-fake-claude: ok"
