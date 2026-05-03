#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAKE_DIR="$ROOT/tests/fixtures/fake-claude"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pi-claude-cli-e2e.XXXXXX")"
PI_MODEL="pi-claude-cli/claude-sonnet-4-5-20250929"
RUN_OUT=""
RUN_ERR=""
RUN_STATUS=0
RUN_TRACE_DIR=""

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
  if [[ -n "${RUN_TRACE_DIR:-}" && -d "$RUN_TRACE_DIR" ]]; then
    echo "--- trace files ---" >&2
    find "$RUN_TRACE_DIR" -maxdepth 2 -type f | sort >&2
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

assert_trace_contains() {
  local file_name="$1"
  local needle="$2"
  if ! grep -R -Fq -- "$needle" "$RUN_TRACE_DIR"/*/"$file_name"; then
    fail "expected trace $file_name to contain: $needle"
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
  RUN_TRACE_DIR="$case_dir/claude-trace"
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
      PI_CLAUDE_CLI_TRACE_DIR="$RUN_TRACE_DIR" \
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
assert_trace_contains "stdin.ndjson" "say hello"
assert_trace_contains "stdout.ndjson" "fake text response"
assert_trace_contains "meta.json" "--include-hook-events"
assert_trace_contains "meta.json" "--debug-file"
assert_trace_contains "meta.json" "--setting-sources"
assert_trace_contains "meta.json" "--strict-mcp-config"
assert_trace_contains "meta.json" "--tools"
assert_trace_contains "meta.json" "Read"

run_pi_case "result-error" "error" "fail visibly"
assert_status_nonzero
assert_contains "$RUN_ERR" "fake rate limit"

run_pi_case "no-result" "no-result" "fail when claude stream ends early"
assert_status_nonzero
assert_contains "$RUN_ERR" "Claude CLI exited without a result event"

run_pi_case "success-no-message" "success-no-message" "fail on empty success"
assert_status_nonzero
assert_contains "$RUN_ERR" "Claude CLI returned success without assistant stream events"

run_pi_case "crash" "crash" "crash visibly"
assert_status_nonzero
assert_contains "$RUN_ERR" "fake crash from claude"

run_pi_case "tool-once" "tool-once" "read package.json"
assert_status 0
assert_contains "$RUN_OUT" "fake tool followup"
assert_not_contains "$RUN_OUT" "fake tool was not intercepted"

echo "e2e-fake-claude: ok"
