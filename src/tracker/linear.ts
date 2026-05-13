import type { Issue } from "../types.js";
import type { IssueTracker } from "./types.js";
import { log } from "../logger.js";

interface LinearGraphQLResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
}

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority: number;
  branchName?: string | null;
  url?: string | null;
  state: { name: string };
  labels: { nodes: Array<{ name: string }> };
  relations: {
    nodes: Array<{
      type: string;
      relatedIssue: {
        id: string;
        identifier: string;
        state: { name: string };
      };
    }>;
  };
  createdAt: string;
  updatedAt: string;
}

const CANDIDATE_ISSUES_QUERY = `
  query CandidateIssues($projectSlug: String!, $states: [String!]!, $after: String) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $states } }
      }
      first: 50
      after: $after
      orderBy: priority
    ) {
      nodes {
        id
        identifier
        title
        description
        priority
        branchName
        url
        state { name }
        labels { nodes { name } }
        relations {
          nodes {
            type
            relatedIssue {
              id
              identifier
              state { name }
            }
          }
        }
        createdAt
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const ISSUES_BY_STATES_QUERY = `
  query IssuesByStates($projectSlug: String!, $states: [String!]!, $after: String) {
    issues(
      filter: {
        project: { slugId: { eq: $projectSlug } }
        state: { name: { in: $states } }
      }
      first: 50
      after: $after
    ) {
      nodes {
        id
        identifier
        title
        state { name }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const ISSUE_STATES_QUERY = `
  query IssueStates($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Issue {
        id
        state { name }
      }
    }
  }
`;

export class LinearTracker implements IssueTracker {
  private endpoint: string;
  private apiKey: string;
  private projectSlug: string;
  private activeStates: string[];
  private terminalStates: string[];

  constructor(
    endpoint: string,
    apiKey: string,
    projectSlug: string,
    activeStates: string[],
    terminalStates: string[],
  ) {
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.projectSlug = projectSlug;
    this.activeStates = activeStates;
    this.terminalStates = terminalStates;
  }

  async fetch_candidate_issues(): Promise<Issue[]> {
    const allIssues: Issue[] = [];
    let after: string | null = null;

    while (true) {
      const variables: Record<string, unknown> = {
        projectSlug: this.projectSlug,
        states: this.activeStates,
      };
      if (after) variables.after = after;

      const result = await this.query(CANDIDATE_ISSUES_QUERY, variables);
      const issues = result.data?.issues as {
        nodes: LinearIssueNode[];
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };

      if (!issues?.nodes) break;

      for (const node of issues.nodes) {
        allIssues.push(this.normalize(node));
      }

      if (!issues.pageInfo.hasNextPage || !issues.pageInfo.endCursor) break;
      after = issues.pageInfo.endCursor;
    }

    return allIssues;
  }

  async fetch_issues_by_states(state_names: string[]): Promise<Issue[]> {
    const allIssues: Issue[] = [];
    let after: string | null = null;

    while (true) {
      const variables: Record<string, unknown> = {
        projectSlug: this.projectSlug,
        states: state_names,
      };
      if (after) variables.after = after;

      const result = await this.query(ISSUES_BY_STATES_QUERY, variables);
      const issues = result.data?.issues as {
        nodes: Array<{
          id: string;
          identifier: string;
          title: string;
          state: { name: string };
        }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };

      if (!issues?.nodes) break;

      for (const node of issues.nodes) {
        allIssues.push({
          id: node.id,
          identifier: node.identifier,
          title: node.title,
          description: null,
          priority: null,
          state: node.state.name,
          branch_name: null,
          url: null,
          labels: [],
          blocked_by: [],
          created_at: null,
          updated_at: null,
        });
      }

      if (!issues.pageInfo.hasNextPage || !issues.pageInfo.endCursor) break;
      after = issues.pageInfo.endCursor;
    }

    return allIssues;
  }

  async fetch_issue_states_by_ids(
    issue_ids: string[],
  ): Promise<Map<string, string>> {
    const result = await this.query(ISSUE_STATES_QUERY, { ids: issue_ids });
    const nodes = (result.data?.nodes ?? []) as Array<{
      id: string;
      state?: { name: string };
    }>;

    const stateMap = new Map<string, string>();
    for (const node of nodes) {
      if (node.id && node.state) {
        stateMap.set(node.id, node.state.name);
      }
    }
    return stateMap;
  }

  private normalize(node: LinearIssueNode): Issue {
    const blockers = (node.relations?.nodes ?? [])
      .filter((r) => r.type === "blocks")
      .map((r) => ({
        id: r.relatedIssue.id,
        identifier: r.relatedIssue.identifier,
        state: r.relatedIssue.state.name,
      }));

    return {
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      description: node.description ?? null,
      priority: typeof node.priority === "number" ? node.priority : null,
      state: node.state.name,
      branch_name: node.branchName ?? null,
      url: node.url ?? null,
      labels: (node.labels?.nodes ?? []).map((l) => l.name.toLowerCase()),
      blocked_by: blockers,
      created_at: node.createdAt ?? null,
      updated_at: node.updatedAt ?? null,
    };
  }

  private async query(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<LinearGraphQLResponse> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.apiKey,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`Linear API returned ${response.status}: ${response.statusText}`);
    }

    const body = (await response.json()) as LinearGraphQLResponse;

    if (body.errors && body.errors.length > 0) {
      const messages = body.errors.map((e) => e.message).join("; ");
      log.warn({ event: "linear_graphql_errors", errors: messages });
    }

    return body;
  }
}
