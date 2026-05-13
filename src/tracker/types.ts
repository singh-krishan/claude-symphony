import type { Issue } from "../types.js";

export interface IssueTracker {
  fetch_candidate_issues(): Promise<Issue[]>;
  fetch_issues_by_states(state_names: string[]): Promise<Issue[]>;
  fetch_issue_states_by_ids(issue_ids: string[]): Promise<Map<string, string>>;
}
