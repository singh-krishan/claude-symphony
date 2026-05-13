import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Issue } from "../types.js";
import type { IssueTracker } from "./types.js";

interface RawLocalIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  state: string;
  priority?: number | null;
  labels?: string[];
  blocked_by?: Array<{
    id?: string | null;
    identifier?: string | null;
    state?: string | null;
  }>;
  created_at?: string | null;
  updated_at?: string | null;
}

export class LocalTracker implements IssueTracker {
  constructor(
    private issuesFile: string,
    private activeStates: string[],
    private terminalStates: string[],
  ) {
    this.issuesFile = resolve(issuesFile);
  }

  private readIssues(): Issue[] {
    const raw = readFileSync(this.issuesFile, "utf-8");
    const parsed = JSON.parse(raw) as RawLocalIssue[];

    return parsed.map((r) => ({
      id: r.id,
      identifier: r.identifier,
      title: r.title,
      description: r.description ?? null,
      priority: typeof r.priority === "number" ? r.priority : null,
      state: r.state,
      branch_name: null,
      url: null,
      labels: (r.labels ?? []).map((l) => l.toLowerCase()),
      blocked_by: (r.blocked_by ?? []).map((b) => ({
        id: b.id ?? null,
        identifier: b.identifier ?? null,
        state: b.state ?? null,
      })),
      created_at: r.created_at ?? null,
      updated_at: r.updated_at ?? null,
    }));
  }

  async fetch_candidate_issues(): Promise<Issue[]> {
    const all = this.readIssues();
    const activeNorm = this.activeStates.map((s) => s.toLowerCase());
    return all.filter((i) => activeNorm.includes(i.state.toLowerCase()));
  }

  async fetch_issues_by_states(state_names: string[]): Promise<Issue[]> {
    const all = this.readIssues();
    const statesNorm = state_names.map((s) => s.toLowerCase());
    return all.filter((i) => statesNorm.includes(i.state.toLowerCase()));
  }

  async fetch_issue_states_by_ids(issue_ids: string[]): Promise<Map<string, string>> {
    const all = this.readIssues();
    const result = new Map<string, string>();
    for (const issue of all) {
      if (issue_ids.includes(issue.id)) {
        result.set(issue.id, issue.state);
      }
    }
    return result;
  }
}
