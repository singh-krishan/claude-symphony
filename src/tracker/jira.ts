import type { Issue } from "../types.js";
import type { IssueTracker } from "./types.js";
import { log } from "../logger.js";

interface JiraSearchResponse {
  issues: JiraIssue[];
  total: number;
  startAt: number;
  maxResults: number;
}

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description: string | null;
    status: { name: string; id: string };
    priority?: { name: string; id: string } | null;
    labels?: string[];
    created: string;
    updated: string;
    issuelinks?: JiraIssueLink[];
  };
}

interface JiraIssueLink {
  type: { name: string; inward: string; outward: string };
  inwardIssue?: {
    id: string;
    key: string;
    fields: { status: { name: string } };
  };
  outwardIssue?: {
    id: string;
    key: string;
    fields: { status: { name: string } };
  };
}

const JIRA_PRIORITY_MAP: Record<string, number> = {
  highest: 1,
  high: 2,
  medium: 3,
  low: 4,
  lowest: 5,
};

export class JiraTracker implements IssueTracker {
  private baseUrl: string;
  private authHeader: string;
  private projectKey: string;
  private activeStates: string[];
  private terminalStates: string[];

  constructor(
    domain: string,
    email: string,
    apiToken: string,
    projectKey: string,
    activeStates: string[],
    terminalStates: string[],
  ) {
    this.baseUrl = domain.startsWith("http")
      ? domain.replace(/\/$/, "")
      : `https://${domain}`;
    this.authHeader =
      "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");
    this.projectKey = projectKey;
    this.activeStates = activeStates;
    this.terminalStates = terminalStates;
  }

  async fetch_candidate_issues(): Promise<Issue[]> {
    const statusList = this.activeStates
      .map((s) => `"${s}"`)
      .join(", ");
    const jql = `project = "${this.projectKey}" AND status IN (${statusList}) ORDER BY priority ASC, created ASC`;
    return this.searchAll(jql);
  }

  async fetch_issues_by_states(state_names: string[]): Promise<Issue[]> {
    const statusList = state_names.map((s) => `"${s}"`).join(", ");
    const jql = `project = "${this.projectKey}" AND status IN (${statusList})`;
    return this.searchAll(jql);
  }

  async fetch_issue_states_by_ids(
    issue_ids: string[],
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (issue_ids.length === 0) return result;

    const idList = issue_ids.map((id) => `"${id}"`).join(", ");
    const jql = `id IN (${idList})`;

    const issues = await this.searchAll(jql);
    for (const issue of issues) {
      result.set(issue.id, issue.state);
    }
    return result;
  }

  private async searchAll(jql: string): Promise<Issue[]> {
    const allIssues: Issue[] = [];
    let startAt = 0;
    const maxResults = 50;

    while (true) {
      const response = await this.search(jql, startAt, maxResults);
      for (const jiraIssue of response.issues) {
        allIssues.push(this.normalize(jiraIssue));
      }

      if (startAt + response.issues.length >= response.total) break;
      startAt += response.issues.length;
    }

    return allIssues;
  }

  private async search(
    jql: string,
    startAt: number,
    maxResults: number,
  ): Promise<JiraSearchResponse> {
    const url = `${this.baseUrl}/rest/api/3/search`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        jql,
        startAt,
        maxResults,
        fields: [
          "summary",
          "description",
          "status",
          "priority",
          "labels",
          "created",
          "updated",
          "issuelinks",
        ],
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Jira API returned ${response.status}: ${response.statusText} — ${body.slice(0, 200)}`,
      );
    }

    return (await response.json()) as JiraSearchResponse;
  }

  private normalize(jira: JiraIssue): Issue {
    const blockers = (jira.fields.issuelinks ?? [])
      .filter((link) => {
        const typeName = link.type.name.toLowerCase();
        return (
          (typeName === "blocks" || typeName === "blocker") &&
          link.inwardIssue !== undefined
        );
      })
      .map((link) => ({
        id: link.inwardIssue!.id,
        identifier: link.inwardIssue!.key,
        state: link.inwardIssue!.fields.status.name,
      }));

    const priorityName = jira.fields.priority?.name?.toLowerCase() ?? "";
    const priority = JIRA_PRIORITY_MAP[priorityName] ?? null;

    let description = jira.fields.description;
    if (description && typeof description === "object") {
      description = this.extractTextFromAdf(
        description as unknown as AdfNode,
      );
    }

    return {
      id: jira.id,
      identifier: jira.key,
      title: jira.fields.summary,
      description: description,
      priority,
      state: jira.fields.status.name,
      branch_name: null,
      url: `${this.baseUrl}/browse/${jira.key}`,
      labels: (jira.fields.labels ?? []).map((l) => l.toLowerCase()),
      blocked_by: blockers,
      created_at: jira.fields.created ?? null,
      updated_at: jira.fields.updated ?? null,
    };
  }

  private extractTextFromAdf(node: AdfNode): string {
    if (!node) return "";

    if (node.type === "text") {
      return node.text ?? "";
    }

    if (node.content && Array.isArray(node.content)) {
      const parts: string[] = [];
      for (const child of node.content) {
        const text = this.extractTextFromAdf(child);
        if (text) parts.push(text);
      }

      if (
        node.type === "paragraph" ||
        node.type === "heading" ||
        node.type === "bulletList" ||
        node.type === "orderedList" ||
        node.type === "listItem" ||
        node.type === "blockquote"
      ) {
        return parts.join("") + "\n";
      }

      return parts.join("");
    }

    return "";
  }
}

interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
}
