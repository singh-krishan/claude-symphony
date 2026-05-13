import type { ServiceConfig } from "../types.js";
import type { IssueTracker } from "./types.js";
import { LocalTracker } from "./local.js";
import { LinearTracker } from "./linear.js";

export type { IssueTracker } from "./types.js";

export function createTracker(config: ServiceConfig): IssueTracker {
  switch (config.tracker.kind) {
    case "local":
      if (!config.tracker.issues_file) {
        throw new Error("tracker.issues_file is required for local tracker");
      }
      return new LocalTracker(
        config.tracker.issues_file,
        config.tracker.active_states,
        config.tracker.terminal_states,
      );

    case "linear":
      return new LinearTracker(
        config.tracker.endpoint,
        config.tracker.api_key,
        config.tracker.project_slug,
        config.tracker.active_states,
        config.tracker.terminal_states,
      );

    default:
      throw new Error(`Unsupported tracker kind: ${config.tracker.kind}`);
  }
}
