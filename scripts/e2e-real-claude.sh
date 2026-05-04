#!/usr/bin/env bash
set -euo pipefail

if [[ "${PI_CLAUDE_CLI_REAL_E2E:-}" != "1" ]]; then
  echo "e2e-real-claude: set PI_CLAUDE_CLI_REAL_E2E=1 to run live Claude Opus tests" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pi-claude-cli-real-e2e.XXXXXX")"
SKILL_E2E_DIR="$ROOT/tests/fixtures/pi-skill-e2e"
PI_MODEL="${PI_CLAUDE_CLI_REAL_MODEL:-pi-claude-cli/claude-opus-4-7}"
PI_THINKING="${PI_CLAUDE_CLI_REAL_THINKING:-low}"
PI_THINKING_LEVELS_RAW="${PI_CLAUDE_CLI_REAL_THINKING_LEVELS:-minimal low medium high xhigh}"
TIMEOUT_SECONDS="${PI_CLAUDE_CLI_REAL_TIMEOUT_SECONDS:-240}"
BAD_KEY_TIMEOUT_SECONDS="${PI_CLAUDE_CLI_REAL_BAD_KEY_TIMEOUT_SECONDS:-30}"
BAD_KEY_PROVIDER_TIMEOUT_MS="${PI_CLAUDE_CLI_REAL_BAD_KEY_PROVIDER_TIMEOUT_MS:-15000}"
RUN_OUT=""
RUN_ERR=""
RUN_STATUS=0
RUN_CASE_DIR=""
RUN_CASE_NAME=""
RUN_TRACE_DIR=""
KEEP_TMP="${PI_CLAUDE_CLI_REAL_E2E_KEEP:-0}"

cleanup() {
  if [[ "$KEEP_TMP" == "1" ]]; then
    echo "e2e-real-claude: kept temp root $TMP_ROOT" >&2
  else
    rm -rf "$TMP_ROOT"
  fi
}
trap cleanup EXIT

fail() {
  KEEP_TMP=1
  echo "e2e-real-claude: $*" >&2
  if [[ -n "${RUN_CASE_NAME:-}" ]]; then
    echo "case: $RUN_CASE_NAME" >&2
  fi
  echo "temp root: $TMP_ROOT" >&2
  if [[ -n "${RUN_OUT:-}" && -f "$RUN_OUT" ]]; then
    echo "--- stdout ---" >&2
    sed -n '1,200p' "$RUN_OUT" >&2
  fi
  if [[ -n "${RUN_ERR:-}" && -f "$RUN_ERR" ]]; then
    echo "--- stderr ---" >&2
    sed -n '1,200p' "$RUN_ERR" >&2
  fi
  if [[ -n "${RUN_TRACE_DIR:-}" && -d "$RUN_TRACE_DIR" ]]; then
    echo "--- trace files ---" >&2
    find "$RUN_TRACE_DIR" -maxdepth 2 -type f | sort >&2
    local lifecycle
    lifecycle="$(find "$RUN_TRACE_DIR" -maxdepth 2 -name lifecycle.jsonl -print -quit)"
    if [[ -n "$lifecycle" && -f "$lifecycle" ]]; then
      echo "--- lifecycle tail ---" >&2
      tail -80 "$lifecycle" >&2
    fi
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

assert_any_contains() {
  local needle="$1"
  if ! grep -Fq "$needle" "$RUN_OUT" && ! grep -Fq "$needle" "$RUN_ERR"; then
    fail "expected stdout or stderr to contain: $needle"
  fi
}

assert_any_matches() {
  local pattern="$1"
  if ! grep -Eq "$pattern" "$RUN_OUT" && ! grep -Eq "$pattern" "$RUN_ERR"; then
    fail "expected stdout or stderr to match: $pattern"
  fi
}

assert_session_contains() {
  local needle="$1"
  if ! grep -R -Fq "$needle" "$RUN_CASE_DIR/sessions"; then
    fail "expected saved session to contain: $needle"
  fi
}

assert_trace_contains() {
  local file_name="$1"
  local needle="$2"
  if ! grep -R -Fq -- "$needle" "$RUN_TRACE_DIR"/*/"$file_name"; then
    fail "expected trace $file_name to contain: $needle"
  fi
}

assert_trace_not_contains() {
  local file_name="$1"
  local needle="$2"
  if grep -R -Fq -- "$needle" "$RUN_TRACE_DIR"/*/"$file_name"; then
    fail "expected trace $file_name not to contain: $needle"
  fi
}

assert_trace_all_meta_have_tool() {
  local expected="$1"
  if ! node - "$RUN_TRACE_DIR" "$expected" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [root, expected] = process.argv.slice(2);
const dirs = fs.existsSync(root) ? fs.readdirSync(root) : [];
const files = dirs
  .map((dir) => path.join(root, dir, "meta.json"))
  .filter((file) => fs.existsSync(file));

if (files.length === 0) {
  console.error("no trace meta.json files found");
  process.exit(1);
}

for (const file of files) {
  const meta = JSON.parse(fs.readFileSync(file, "utf-8"));
  const args = Array.isArray(meta.args) ? meta.args : [];
  const toolsIndex = args.indexOf("--tools");
  if (toolsIndex < 0) {
    console.error(`${file} is missing --tools: ${JSON.stringify(args)}`);
    process.exit(1);
  }
  if (args[toolsIndex + 1] !== expected) {
    console.error(
      `${file} expected --tools ${expected}, got ${JSON.stringify(args[toolsIndex + 1])}: ${JSON.stringify(args)}`,
    );
    process.exit(1);
  }
}
NODE
  then
    fail "expected every trace meta.json to include --tools $expected"
  fi
}

assert_trace_any_meta_has_flag() {
  local flag="$1"
  if ! node - "$RUN_TRACE_DIR" "$flag" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [root, flag] = process.argv.slice(2);
const dirs = fs.existsSync(root) ? fs.readdirSync(root) : [];
const files = dirs
  .map((dir) => path.join(root, dir, "meta.json"))
  .filter((file) => fs.existsSync(file));

if (!files.some((file) => {
  const meta = JSON.parse(fs.readFileSync(file, "utf-8"));
  return Array.isArray(meta.args) && meta.args.includes(flag);
})) {
  console.error(`no trace meta.json included ${flag}`);
  process.exit(1);
}
NODE
  then
    fail "expected at least one trace meta.json to include $flag"
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
  RUN_CASE_NAME="$name"
  RUN_OUT="$case_dir/stdout.txt"
  RUN_ERR="$case_dir/stderr.txt"
  RUN_TRACE_DIR="$case_dir/claude-trace"

  set +e
  (
    cd "$cwd" &&
    PI_CODING_AGENT_DIR="$case_dir/agent" \
      PI_CODING_AGENT_SESSION_DIR="$case_dir/sessions" \
      PI_OFFLINE=1 \
      NO_COLOR=1 \
      PI_CLAUDE_CLI_EFFORT= \
      PI_CLAUDE_CLI_MAX_MODE= \
      PI_CLAUDE_CLI_TRACE_DIR="$RUN_TRACE_DIR" \
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

run_pi_bad_key_case() {
  local case_dir="$TMP_ROOT/bad-api-key"
  mkdir -p "$case_dir/agent" "$case_dir/sessions"
  RUN_CASE_DIR="$case_dir"
  RUN_CASE_NAME="bad-api-key"
  RUN_OUT="$case_dir/stdout.txt"
  RUN_ERR="$case_dir/stderr.txt"
  RUN_TRACE_DIR="$case_dir/claude-trace"

  set +e
  (
    cd "$ROOT" &&
    ANTHROPIC_API_KEY=sk-ant-invalid-for-pi-claude-cli-e2e \
      PI_CODING_AGENT_DIR="$case_dir/agent" \
      PI_CODING_AGENT_SESSION_DIR="$case_dir/sessions" \
      PI_OFFLINE=1 \
      NO_COLOR=1 \
      PI_CLAUDE_CLI_EFFORT= \
      PI_CLAUDE_CLI_MAX_MODE= \
      PI_CLAUDE_CLI_TIMEOUT_MS="$BAD_KEY_PROVIDER_TIMEOUT_MS" \
      PI_CLAUDE_CLI_TRACE_DIR="$RUN_TRACE_DIR" \
      pi \
        --offline \
        --mode json \
        --no-session \
        --no-extensions \
        --extension "$ROOT/index.ts" \
        --no-skills \
        --no-prompt-templates \
        --no-themes \
        --no-context-files \
        --no-tools \
        --model "$PI_MODEL" \
        --thinking low \
        -p "Reply exactly: PI_REAL_OPUS_BAD_KEY_SHOULD_NOT_SUCCEED" \
        >"$RUN_OUT" \
        2>"$RUN_ERR"
  ) &
  local pid=$!
  local elapsed=0
  while kill -0 "$pid" 2>/dev/null; do
    if [[ "$elapsed" -ge "$BAD_KEY_TIMEOUT_SECONDS" ]]; then
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
  RUN_CASE_NAME="$name"
  RUN_OUT="$case_dir/stdout.txt"
  RUN_ERR="$case_dir/stderr.txt"
  RUN_TRACE_DIR="$case_dir/claude-trace"

  set +e
  (
    cd "$cwd" &&
    PI_CODING_AGENT_DIR="$case_dir/agent" \
      PI_CODING_AGENT_SESSION_DIR="$case_dir/sessions" \
      PI_OFFLINE=1 \
      NO_COLOR=1 \
      PI_CLAUDE_CLI_EFFORT= \
      PI_CLAUDE_CLI_MAX_MODE=1 \
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

AUTH_OUT="$TMP_ROOT/claude-auth-status.json"
claude auth status >"$AUTH_OUT"
echo "e2e-real-claude: claude auth status" >&2
sed -n '1,80p' "$AUTH_OUT" >&2

if [[ "${PI_CLAUDE_CLI_REAL_REQUIRE_FIRST_PARTY:-1}" != "0" ]]; then
  assert_contains "$AUTH_OUT" '"authMethod": "claude.ai"'
  assert_contains "$AUTH_OUT" '"apiProvider": "firstParty"'
  assert_not_contains "$AUTH_OUT" '"apiKeySource"'
fi

run_pi_bad_key_case
assert_any_matches "Claude CLI (authentication_failed|API error( [0-9]+)?:|subprocess timed out: no output for|exited without a result event|returned success without assistant stream events)"
assert_trace_contains "meta.json" "--debug-file"
assert_trace_contains "meta.json" "--include-hook-events"
assert_trace_contains "meta.json" '"hasAnthropicApiKey": true'
assert_trace_contains "stdout.ndjson" '"apiKeySource":"ANTHROPIC_API_KEY"'
assert_trace_not_contains "stdout.ndjson" "PI_REAL_OPUS_BAD_KEY_SHOULD_NOT_SUCCEED"
assert_trace_contains "meta.json" "--setting-sources"
assert_trace_contains "meta.json" "--strict-mcp-config"

for thinking in $PI_THINKING_LEVELS_RAW; do
  marker="PI_REAL_OPUS_$(printf "%s" "$thinking" | tr '[:lower:]' '[:upper:]')_OK"
  run_pi_case \
    "text-$thinking" \
    "$thinking" \
    "$ROOT" \
    --no-session \
    --no-tools \
    -p "Reply with exactly this text and nothing else: $marker"
  assert_status 0
  assert_contains "$RUN_OUT" "$marker"
  assert_trace_contains "stdin.ndjson" "$marker"
done

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
assert_trace_contains "stdout.ndjson" '"name":"Read"'
assert_trace_contains "stdin.ndjson" "TOOL RESULT (historical Read):"
assert_trace_contains "lifecycle.jsonl" '"event":"break_early"'
assert_trace_contains "meta.json" "--tools"
assert_trace_contains "meta.json" "Read"
assert_trace_all_meta_have_tool "Read"
assert_trace_any_meta_has_flag "--resume"

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

run_pi_case \
  "skill-explicit" \
  xhigh \
  "$ROOT" \
  --no-session \
  --no-tools \
  --skill "$SKILL_E2E_DIR" \
  -p "/skill:pi-claude-skill-e2e explicit-skill-case"
assert_status 0
assert_contains "$RUN_OUT" "PI_SKILL_EXPLICIT_OK"
assert_trace_contains "stdin.ndjson" "pi-claude-skill-e2e"
assert_trace_contains "stdin.ndjson" "PI_SKILL_EXPLICIT_OK"

run_pi_case \
  "skill-auto" \
  xhigh \
  "$ROOT" \
  --session-dir "$TMP_ROOT/skill-auto/sessions" \
  --tools read \
  --skill "$SKILL_E2E_DIR" \
  -p "This is the automatic skill invocation case. Use the listed Pi skill named pi-claude-skill-e2e. Before answering, load that skill's full SKILL.md with the read tool, then obey it."
assert_status 0
assert_contains "$RUN_OUT" "PI_SKILL_AUTO_OK"
assert_session_contains '"name":"read"'
assert_session_contains '"role":"toolResult"'
assert_session_contains 'pi-skill-e2e/SKILL.md'
assert_trace_contains "system-prompt.txt" "pi-claude-skill-e2e"
assert_trace_contains "stdout.ndjson" '"name":"Read"'
assert_trace_contains "stdout.ndjson" '"tools":["Read"]'
assert_trace_all_meta_have_tool "Read"
assert_trace_any_meta_has_flag "--resume"
assert_trace_not_contains "stdout.ndjson" "superpowers"
assert_trace_not_contains "stdout.ndjson" '"name":"Glob"'
assert_trace_not_contains "stdout.ndjson" '"name":"Bash"'

if [[ "${PI_CLAUDE_CLI_REAL_E2E_MAX:-}" == "1" ]]; then
  run_pi_max_case \
    "max-mode" \
    "$ROOT" \
    -p "Reply with exactly this text and nothing else: PI_REAL_OPUS_MAX_OK"
  assert_status 0
  assert_contains "$RUN_OUT" "PI_REAL_OPUS_MAX_OK"
fi

echo "e2e-real-claude: ok"
