import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { ServiceConfig, WorkflowDefinition } from "./types.js";

function resolveEnvVar(value: string): string {
  if (value.startsWith("$")) {
    const varName = value.slice(1);
    return process.env[varName] ?? "";
  }
  return value;
}

function expandPath(p: string): string {
  if (p.startsWith("~")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return resolve(home, p.slice(2));
  }
  if (p.includes("/") || p.includes("\\")) {
    return resolve(p);
  }
  return p;
}

function getStr(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  if (val === undefined || val === null) return undefined;
  return String(val);
}

function getNum(obj: Record<string, unknown>, key: string): number | undefined {
  const val = obj[key];
  if (val === undefined || val === null) return undefined;
  const n = Number(val);
  return Number.isNaN(n) ? undefined : n;
}

function getStrArray(obj: Record<string, unknown>, key: string): string[] | undefined {
  const val = obj[key];
  if (!Array.isArray(val)) return undefined;
  return val.map(String);
}

function getObj(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const val = obj[key];
  if (val && typeof val === "object" && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return {};
}

export function buildConfig(workflow: WorkflowDefinition): ServiceConfig {
  const c = workflow.config;
  const tracker = getObj(c, "tracker");
  const polling = getObj(c, "polling");
  const workspace = getObj(c, "workspace");
  const hooks = getObj(c, "hooks");
  const agent = getObj(c, "agent");
  const claude = getObj(c, "claude");

  const trackerKind = getStr(tracker, "kind") ?? "local";

  const concurrencyByState: Record<string, number> = {};
  const byStateRaw = getObj(agent, "max_concurrent_agents_by_state");
  for (const [state, val] of Object.entries(byStateRaw)) {
    const n = Number(val);
    if (n > 0) {
      concurrencyByState[state.toLowerCase()] = n;
    }
  }

  const workspaceRoot = expandPath(
    getStr(workspace, "root") ?? `${tmpdir()}/symphony_workspaces`,
  );

  const apiKey = resolveEnvVar(getStr(tracker, "api_key") ?? "$LINEAR_API_KEY");

  return {
    tracker: {
      kind: trackerKind,
      endpoint:
        getStr(tracker, "endpoint") ??
        (trackerKind === "linear"
          ? "https://api.linear.app/graphql"
          : ""),
      api_key: apiKey,
      project_slug: getStr(tracker, "project_slug") ?? "",
      active_states: getStrArray(tracker, "active_states") ?? [
        "Todo",
        "In Progress",
      ],
      terminal_states: getStrArray(tracker, "terminal_states") ?? [
        "Closed",
        "Cancelled",
        "Canceled",
        "Duplicate",
        "Done",
      ],
      issues_file: getStr(tracker, "issues_file"),
    },
    polling: {
      interval_ms: getNum(polling, "interval_ms") ?? 30000,
    },
    workspace: {
      root: workspaceRoot,
    },
    hooks: {
      after_create: getStr(hooks, "after_create") ?? null,
      before_run: getStr(hooks, "before_run") ?? null,
      after_run: getStr(hooks, "after_run") ?? null,
      before_remove: getStr(hooks, "before_remove") ?? null,
      timeout_ms: getNum(hooks, "timeout_ms") ?? 60000,
    },
    agent: {
      max_concurrent_agents: getNum(agent, "max_concurrent_agents") ?? 10,
      max_turns: getNum(agent, "max_turns") ?? 20,
      max_retry_backoff_ms: getNum(agent, "max_retry_backoff_ms") ?? 300000,
      max_concurrent_agents_by_state: concurrencyByState,
    },
    claude: {
      model: getStr(claude, "model") ?? "claude-sonnet-4-6",
      max_tokens: getNum(claude, "max_tokens") ?? 8096,
    },
  };
}

export function validateConfig(config: ServiceConfig): string[] {
  const errors: string[] = [];

  if (!config.tracker.kind) {
    errors.push("tracker.kind is required");
  }

  if (config.tracker.kind === "linear") {
    if (!config.tracker.api_key) {
      errors.push(
        "tracker.api_key is required (set LINEAR_API_KEY env var or provide in WORKFLOW.md)",
      );
    }
    if (!config.tracker.project_slug) {
      errors.push("tracker.project_slug is required when tracker.kind is 'linear'");
    }
  }

  if (config.tracker.kind === "local") {
    if (!config.tracker.issues_file) {
      errors.push("tracker.issues_file is required when tracker.kind is 'local'");
    }
  }

  if (config.polling.interval_ms <= 0) {
    errors.push("polling.interval_ms must be positive");
  }

  if (config.agent.max_concurrent_agents <= 0) {
    errors.push("agent.max_concurrent_agents must be positive");
  }

  return errors;
}
