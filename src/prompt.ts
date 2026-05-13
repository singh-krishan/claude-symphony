import { Liquid } from "liquidjs";
import type { Issue } from "./types.js";

const engine = new Liquid({ strictVariables: true, strictFilters: true });

export function renderPrompt(
  template: string,
  issue: Issue,
  attempt: number | null,
): string {
  const issueData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(issue)) {
    issueData[key] = value === null ? "" : value;
  }

  const context: Record<string, unknown> = {
    issue: issueData,
    attempt: attempt ?? null,
  };

  return engine.parseAndRenderSync(template, context);
}
