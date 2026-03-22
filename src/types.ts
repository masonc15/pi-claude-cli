// Wire protocol types for Claude CLI stream-json NDJSON communication

// NDJSON message types from Claude CLI stdout

export interface ClaudeStreamEventMessage {
  type: "stream_event";
  event: ClaudeApiEvent;
  parent_tool_use_id?: string | null;
  uuid?: string;
  session_id?: string;
}

export interface ClaudeResultMessage {
  type: "result";
  subtype:
    | "success"
    | "error"
    | "error_during_execution"
    | "error_max_turns"
    | "error_max_budget_usd";
  result?: string;
  error?: string;
  is_error?: boolean;
  errors?: string[];
  session_id?: string;
  total_cost_usd?: number;
  usage?: ClaudeUsage;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
}

export interface ClaudeSystemMessage {
  type: "system";
  subtype: string;
  session_id?: string;
  tools?: unknown[];
}

export interface ClaudeControlRequest {
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool";
    tool_name: string;
    input: Record<string, unknown>;
  };
}

// Error category from the Claude CLI assistant message
export type AssistantMessageError =
  | "authentication_failed"
  | "billing_error"
  | "rate_limit"
  | "invalid_request"
  | "server_error"
  | "unknown";

export interface ClaudeAssistantMessage {
  type: "assistant";
  message?: {
    content?: unknown[];
    model?: string;
    stop_reason?: string;
    usage?: ClaudeUsage;
  };
  error?: AssistantMessageError;
  parent_tool_use_id?: string | null;
  uuid?: string;
  session_id?: string;
}

export type NdjsonMessage =
  | ClaudeStreamEventMessage
  | ClaudeResultMessage
  | ClaudeSystemMessage
  | ClaudeControlRequest
  | ClaudeAssistantMessage;

// Claude API event types (inside stream_event wrapper)

export interface ClaudeApiEvent {
  type: string; // message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
  index?: number;
  message?: {
    id?: string;
    type?: string;
    role?: string;
    content?: unknown[];
    model?: string;
    usage?: ClaudeUsage;
  };
  content_block?: {
    type: string; // "text", "tool_use", "thinking"
    text?: string;
    id?: string;
    name?: string;
    input?: string;
  };
  delta?: {
    type?: string; // "text_delta", "input_json_delta", "thinking_delta", "signature_delta"
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: string;
  };
  usage?: ClaudeUsage;
}

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// Content block tracking during stream processing

export interface TrackedContentBlock {
  type: "text" | "thinking";
  text: string;
  index?: number; // Claude's content_block index, deleted after block_stop
}
