#!/usr/bin/env bash
set -euo pipefail

if [[ "${PI_CLAUDE_CLI_REAL_E2E:-}" != "1" ]]; then
  echo "e2e-real-claude: set PI_CLAUDE_CLI_REAL_E2E=1 to run live Claude Opus tests" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pi-claude-cli-real-e2e.XXXXXX")"
PI_MODEL="${PI_CLAUDE_CLI_REAL_MODEL:-pi-claude-cli/claude-opus-4-7}"
PI_THINKING="${PI_CLAUDE_CLI_REAL_THINKING:-low}"
TIMEOUT_SECONDS="${PI_CLAUDE_CLI_REAL_TIMEOUT_SECONDS:-240}"
RUN_OUT=""
RUN_ERR=""
RUN_STATUS=0
RUN_CASE_DIR=""

cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  echo "e2e-real-claude: $*" >&2
  if [[ -n "${RUN_OUT:-}" && -f "$RUN_OUT" ]]; then
    echo "--- stdout ---" >&2
    sed -n '1,200p' "$RUN_OUT" >&2
  fi
  if [[ -n "${RUN_ERR:-}" && -f "$RUN_ERR" ]]; then
    echo "--- stderr ---" >&2
    sed -n '1,200p' "$RUN_ERR" >&2
  fi
  exit 1
}

assert_status() {
  local expected="$1"
  if [[ "$RUN_STATUS" -ne "$expected" ]]; then
    fail "expected exit status $expected, got $RUN_STATUS"
  fi
}

assert_contains() {
  local file="$1"
  local needle="$2"
  if ! grep -Fq "$needle" "$file"; then
    fail "expected $file to contain: $needle"
  fi
}

assert_session_contains() {
  local needle="$1"
  if ! grep -R -Fq "$needle" "$RUN_CASE_DIR/sessions"; then
    fail "expected saved session to contain: $needle"
  fi
}

run_pi_case() {
  local name="$1"
  local thinking="$2"
  local cwd="$3"
  shift 3

  local case_dir="$TMP_ROOT/$name"
  mkdir -p "$case_dir/agent" "$case_dir/sessions"
  RUN_CASE_DIR="$case_dir"
  RUN_OUT="$case_dir/stdout.txt"
  RUN_ERR="$case_dir/stderr.txt"

  set +e
  (
    cd "$cwd" &&
    PI_CODING_AGENT_DIR="$case_dir/agent" \
      PI_CODING_AGENT_SESSION_DIR="$case_dir/sessions" \
      PI_OFFLINE=1 \
      NO_COLOR=1 \
      PI_CLAUDE_CLI_EFFORT= \
      PI_CLAUDE_CLI_MAX_MODE= \
      pi \
        --offline \
        --no-extensions \
        --extension "$ROOT/index.ts" \
        --no-skills \
        --no-prompt-templates \
        --no-themes \
        --no-context-files \
        --model "$PI_MODEL" \
        --thinking "$thinking" \
        "$@" \
        >"$RUN_OUT" \
        2>"$RUN_ERR"
  ) &
  local pid=$!
  local elapsed=0
  while kill -0 "$pid" 2>/dev/null; do
    if [[ "$elapsed" -ge "$TIMEOUT_SECONDS" ]]; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null
      RUN_STATUS=124
      set -e
      return
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  wait "$pid"
  RUN_STATUS=$?
  set -e
}

run_pi_max_case() {
  local name="$1"
  local cwd="$2"
  shift 2

  local case_dir="$TMP_ROOT/$name"
  mkdir -p "$case_dir/agent" "$case_dir/sessions"
  RUN_CASE_DIR="$case_dir"
  RUN_OUT="$case_dir/stdout.txt"
  RUN_ERR="$case_dir/stderr.txt"

  set +e
  (
    cd "$cwd" &&
    PI_CODING_AGENT_DIR="$case_dir/agent" \
      PI_CODING_AGENT_SESSION_DIR="$case_dir/sessions" \
      PI_OFFLINE=1 \
      NO_COLOR=1 \
      PI_CLAUDE_CLI_EFFORT= \
      PI_CLAUDE_CLI_MAX_MODE=1 \
      pi \
        --offline \
        --no-session \
        --no-extensions \
        --extension "$ROOT/index.ts" \
        --no-skills \
        --no-prompt-templates \
        --no-themes \
        --no-context-files \
        --no-tools \
        --model "$PI_MODEL" \
        --thinking xhigh \
        "$@" \
        >"$RUN_OUT" \
        2>"$RUN_ERR"
  ) &
  local pid=$!
  local elapsed=0
  while kill -0 "$pid" 2>/dev/null; do
    if [[ "$elapsed" -ge "$TIMEOUT_SECONDS" ]]; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null
      RUN_STATUS=124
      set -e
      return
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
  wait "$pid"
  RUN_STATUS=$?
  set -e
}

claude auth status >/dev/null

run_pi_case \
  "text-low" \
  "$PI_THINKING" \
  "$ROOT" \
  --no-session \
  --no-tools \
  -p "Reply with exactly this text and nothing else: PI_REAL_OPUS_TEXT_OK"
assert_status 0
assert_contains "$RUN_OUT" "PI_REAL_OPUS_TEXT_OK"

run_pi_case \
  "read-tool-low" \
  "$PI_THINKING" \
  "$ROOT" \
  --session-dir "$TMP_ROOT/read-tool-low/sessions" \
  --tools read \
  -p "Use the read tool to read package.json in the current directory. Then answer exactly: PACKAGE_NAME=<the package name from package.json>"
assert_status 0
assert_contains "$RUN_OUT" "PACKAGE_NAME=pi-claude-cli"
assert_session_contains '"name":"read"'
assert_session_contains '"role":"toolResult"'

run_pi_case \
  "memory-first" \
  "$PI_THINKING" \
  "$ROOT" \
  --session-dir "$TMP_ROOT/memory-first/sessions" \
  --no-tools \
  -p "Remember this codeword for the next turn: orchid. Reply exactly: MEMORY_SET"
assert_status 0
assert_contains "$RUN_OUT" "MEMORY_SET"

run_pi_case \
  "memory-second" \
  "$PI_THINKING" \
  "$ROOT" \
  --session-dir "$TMP_ROOT/memory-first/sessions" \
  --continue \
  --no-tools \
  -p "What codeword did I ask you to remember? Reply exactly: CODEWORD=<codeword>"
assert_status 0
assert_contains "$RUN_OUT" "CODEWORD=orchid"

if [[ "${PI_CLAUDE_CLI_REAL_E2E_MAX:-}" == "1" ]]; then
  run_pi_max_case \
    "max-mode" \
    "$ROOT" \
    -p "Reply with exactly this text and nothing else: PI_REAL_OPUS_MAX_OK"
  assert_status 0
  assert_contains "$RUN_OUT" "PI_REAL_OPUS_MAX_OK"
fi

echo "e2e-real-claude: ok"
