#!/usr/bin/env node

import { resolve } from "node:path";
import { watchFile } from "node:fs";
import { loadWorkflow } from "./workflow.js";
import { buildConfig, validateConfig } from "./config.js";
import { createTracker } from "./tracker/index.js";
import { Orchestrator } from "./orchestrator.js";
import { startStatusServer } from "./status.js";
import { log, setLogLevel } from "./logger.js";

function parseArgs(argv: string[]): {
  workflow: string;
  port: number | null;
  dryRun: boolean;
  verbose: boolean;
} {
  const args = argv.slice(2);
  let workflow = "./WORKFLOW.md";
  let port: number | null = null;
  let dryRun = false;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--workflow":
        workflow = args[++i];
        break;
      case "--port":
        port = parseInt(args[++i], 10);
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--verbose":
        verbose = true;
        break;
      case "--help":
        printHelp();
        process.exit(0);
    }
  }

  return { workflow, port, dryRun, verbose };
}

function printHelp(): void {
  const help = `
Claude Symphony — Autonomous coding agent orchestrator

Usage: claude-symphony [options]

Options:
  --workflow <path>    Path to WORKFLOW.md (default: ./WORKFLOW.md)
  --port <number>      Enable HTTP status server on this port
  --dry-run            Run orchestrator without calling Claude API
  --verbose            Enable debug logging
  --help               Show this help message

Environment:
  ANTHROPIC_API_KEY    Anthropic API key for Claude
  LINEAR_API_KEY       Linear API token (when using tracker.kind: linear)

Examples:
  # Local testing with dry-run
  claude-symphony --workflow ./WORKFLOW.md --dry-run

  # Local testing with real Claude
  claude-symphony --workflow ./WORKFLOW.md

  # Production with status server
  claude-symphony --workflow ./WORKFLOW.md --port 8080
`.trim();

  console.log(help);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  if (opts.verbose) {
    setLogLevel("debug");
  }

  const workflowPath = resolve(opts.workflow);

  // Load and validate workflow
  log.info({ event: "loading_workflow", path: workflowPath });
  const workflow = loadWorkflow(workflowPath);
  const config = buildConfig(workflow);

  const errors = validateConfig(config);
  if (errors.length > 0) {
    for (const err of errors) {
      log.error({ event: "config_error", error: err });
    }
    process.exit(1);
  }

  if (!opts.dryRun && !process.env.ANTHROPIC_API_KEY) {
    log.error({
      event: "config_error",
      error: "ANTHROPIC_API_KEY environment variable is required (or use --dry-run)",
    });
    process.exit(1);
  }

  // Create tracker
  const tracker = createTracker(config);

  // Create orchestrator
  const orchestrator = new Orchestrator(
    config,
    workflow.prompt_template,
    tracker,
    opts.dryRun,
  );

  // Start status server if requested
  if (opts.port) {
    startStatusServer(orchestrator, opts.port);
  }

  // Watch WORKFLOW.md for changes (dynamic reload)
  watchFile(workflowPath, { interval: 2000 }, () => {
    log.info({ event: "workflow_file_changed", path: workflowPath });
    try {
      const updated = loadWorkflow(workflowPath);
      const updatedConfig = buildConfig(updated);
      const errs = validateConfig(updatedConfig);
      if (errs.length > 0) {
        log.warn({
          event: "reload_validation_failed",
          errors: errs.join("; "),
        });
        return;
      }
      orchestrator.reloadConfig(updatedConfig, updated.prompt_template);
    } catch (e) {
      log.warn({
        event: "reload_failed",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    await orchestrator.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start orchestrating
  await orchestrator.start();

  log.info({
    event: "running",
    message: "Claude Symphony is running. Press Ctrl+C to stop.",
  });
}

main().catch((e) => {
  log.error({
    event: "fatal",
    error: e instanceof Error ? e.message : String(e),
  });
  process.exit(1);
});
