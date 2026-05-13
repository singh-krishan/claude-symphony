export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branch_name: string | null;
  url: string | null;
  labels: string[];
  blocked_by: BlockerRef[];
  created_at: string | null;
  updated_at: string | null;
}

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  prompt_template: string;
}

export interface ServiceConfig {
  tracker: {
    kind: string;
    endpoint: string;
    api_key: string;
    project_slug: string;
    active_states: string[];
    terminal_states: string[];
    issues_file?: string;
    email?: string;
    domain?: string;
  };
  polling: {
    interval_ms: number;
  };
  workspace: {
    root: string;
  };
  hooks: {
    after_create: string | null;
    before_run: string | null;
    after_run: string | null;
    before_remove: string | null;
    timeout_ms: number;
  };
  agent: {
    max_concurrent_agents: number;
    max_turns: number;
    max_retry_backoff_ms: number;
    max_concurrent_agents_by_state: Record<string, number>;
  };
  claude: {
    model: string;
    max_tokens: number;
  };
}

export interface Workspace {
  path: string;
  workspace_key: string;
  created_now: boolean;
}

export interface RunAttempt {
  issue_id: string;
  issue_identifier: string;
  attempt: number | null;
  workspace_path: string;
  started_at: number;
  status: RunAttemptStatus;
  error?: string;
}

export type RunAttemptStatus =
  | "preparing_workspace"
  | "building_prompt"
  | "running_agent"
  | "finishing"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "stalled"
  | "cancelled_by_reconciliation";

export interface LiveSession {
  session_id: string;
  issue_id: string;
  issue_identifier: string;
  started_at: number;
  last_activity: number;
  turn_count: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  abort_controller: AbortController;
}

export interface RetryEntry {
  issue_id: string;
  identifier: string;
  attempt: number;
  due_at_ms: number;
  timer_handle: ReturnType<typeof setTimeout>;
  error: string | null;
}

export interface RunningEntry {
  issue: Issue;
  session: LiveSession;
  promise: Promise<void>;
  attempt: number | null;
}

export interface OrchestratorState {
  running: Map<string, RunningEntry>;
  claimed: Set<string>;
  retry_attempts: Map<string, RetryEntry>;
  completed: Set<string>;
  totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    runtime_seconds: number;
    failures: number;
  };
}

export interface AgentResult {
  turns: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  elapsed_ms: number;
}
