import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { WorkflowDefinition } from "./types.js";

export class WorkflowError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

export function loadWorkflow(filePath: string): WorkflowDefinition {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    throw new WorkflowError(
      "missing_workflow_file",
      `Cannot read workflow file: ${filePath}`,
    );
  }

  return parseWorkflowContent(raw);
}

export function parseWorkflowContent(raw: string): WorkflowDefinition {
  const trimmed = raw.trim();

  if (!trimmed.startsWith("---")) {
    return { config: {}, prompt_template: trimmed };
  }

  const endIndex = trimmed.indexOf("---", 3);
  if (endIndex === -1) {
    throw new WorkflowError(
      "workflow_parse_error",
      "YAML front matter opening '---' found but no closing '---'",
    );
  }

  const yamlBlock = trimmed.slice(3, endIndex).trim();
  const promptBody = trimmed.slice(endIndex + 3).trim();

  let config: unknown;
  try {
    config = parseYaml(yamlBlock);
  } catch (e) {
    throw new WorkflowError(
      "workflow_parse_error",
      `Failed to parse YAML front matter: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (config === null || config === undefined) {
    return { config: {}, prompt_template: promptBody };
  }

  if (typeof config !== "object" || Array.isArray(config)) {
    throw new WorkflowError(
      "workflow_front_matter_not_a_map",
      "YAML front matter must be a map/object",
    );
  }

  return {
    config: config as Record<string, unknown>,
    prompt_template: promptBody,
  };
}
