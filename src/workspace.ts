import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, normalize } from "node:path";
import { execSync } from "node:child_process";
import type { ServiceConfig, Workspace } from "./types.js";
import { log } from "./logger.js";

function sanitizeKey(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

function assertInsideRoot(workspacePath: string, rootPath: string): void {
  const normalizedWs = normalize(resolve(workspacePath));
  const normalizedRoot = normalize(resolve(rootPath));
  if (!normalizedWs.startsWith(normalizedRoot)) {
    throw new Error(
      `Workspace path ${normalizedWs} is outside workspace root ${normalizedRoot}`,
    );
  }
}

export class WorkspaceManager {
  private root: string;
  private hooks: ServiceConfig["hooks"];

  constructor(config: ServiceConfig) {
    this.root = resolve(config.workspace.root);
    this.hooks = config.hooks;
  }

  updateConfig(config: ServiceConfig): void {
    this.root = resolve(config.workspace.root);
    this.hooks = config.hooks;
  }

  ensure(issueIdentifier: string): Workspace {
    const key = sanitizeKey(issueIdentifier);
    const wsPath = resolve(this.root, key);

    assertInsideRoot(wsPath, this.root);

    let createdNow = false;
    if (!existsSync(wsPath)) {
      mkdirSync(wsPath, { recursive: true });
      createdNow = true;

      if (this.hooks.after_create) {
        log.info({
          event: "hook",
          hook: "after_create",
          issue_identifier: issueIdentifier,
        });
        try {
          this.runHook(this.hooks.after_create, wsPath);
        } catch (e) {
          rmSync(wsPath, { recursive: true, force: true });
          throw new Error(
            `after_create hook failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    return { path: wsPath, workspace_key: key, created_now: createdNow };
  }

  remove(issueIdentifier: string): void {
    const key = sanitizeKey(issueIdentifier);
    const wsPath = resolve(this.root, key);

    assertInsideRoot(wsPath, this.root);

    if (!existsSync(wsPath)) return;

    if (this.hooks.before_remove) {
      log.info({
        event: "hook",
        hook: "before_remove",
        issue_identifier: issueIdentifier,
      });
      try {
        this.runHook(this.hooks.before_remove, wsPath);
      } catch (e) {
        log.warn({
          event: "hook_failed",
          hook: "before_remove",
          issue_identifier: issueIdentifier,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    rmSync(wsPath, { recursive: true, force: true });
  }

  runBeforeRun(issueIdentifier: string, wsPath: string): void {
    if (!this.hooks.before_run) return;
    log.info({
      event: "hook",
      hook: "before_run",
      issue_identifier: issueIdentifier,
    });
    this.runHook(this.hooks.before_run, wsPath);
  }

  runAfterRun(issueIdentifier: string, wsPath: string): void {
    if (!this.hooks.after_run) return;
    log.info({
      event: "hook",
      hook: "after_run",
      issue_identifier: issueIdentifier,
    });
    try {
      this.runHook(this.hooks.after_run, wsPath);
    } catch (e) {
      log.warn({
        event: "hook_failed",
        hook: "after_run",
        issue_identifier: issueIdentifier,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private runHook(script: string, cwd: string): void {
    const timeout = this.hooks.timeout_ms > 0 ? this.hooks.timeout_ms : 60000;
    execSync(script, {
      cwd,
      shell: "/bin/bash",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
  }
}
