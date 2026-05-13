import type {
  ServiceConfig,
  Issue,
  OrchestratorState,
  RunningEntry,
  RetryEntry,
  LiveSession,
} from "./types.js";
import type { IssueTracker } from "./tracker/index.js";
import { WorkspaceManager } from "./workspace.js";
import { renderPrompt } from "./prompt.js";
import { runAgent } from "./agent.js";
import { log } from "./logger.js";

export class Orchestrator {
  private state: OrchestratorState;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private tracker: IssueTracker;
  private workspaceManager: WorkspaceManager;
  private config: ServiceConfig;
  private promptTemplate: string;
  private dryRun: boolean;
  private shuttingDown = false;

  constructor(
    config: ServiceConfig,
    promptTemplate: string,
    tracker: IssueTracker,
    dryRun: boolean = false,
  ) {
    this.config = config;
    this.promptTemplate = promptTemplate;
    this.tracker = tracker;
    this.workspaceManager = new WorkspaceManager(config);
    this.dryRun = dryRun;

    this.state = {
      running: new Map(),
      claimed: new Set(),
      retry_attempts: new Map(),
      completed: new Set(),
      totals: { input_tokens: 0, output_tokens: 0, total_tokens: 0, runtime_seconds: 0, failures: 0 },
    };
  }

  reloadConfig(config: ServiceConfig, promptTemplate: string): void {
    this.config = config;
    this.promptTemplate = promptTemplate;
    this.workspaceManager.updateConfig(config);
    log.info({ event: "config_reloaded" });
  }

  async start(): Promise<void> {
    log.info({
      event: "startup",
      tracker: this.config.tracker.kind,
      poll_interval_ms: this.config.polling.interval_ms,
      max_agents: this.config.agent.max_concurrent_agents,
      dry_run: this.dryRun,
    });

    await this.startupCleanup();
    await this.tick();

    this.pollTimer = setInterval(() => {
      this.tick().catch((e) => {
        log.error({
          event: "tick_error",
          error: e instanceof Error ? e.message : String(e),
        });
      });
    }, this.config.polling.interval_ms);
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    const now = Date.now();

    // Collect running agents info before aborting
    const runningAgents = Array.from(this.state.running.values()).map((entry) => ({
      identifier: entry.issue.identifier,
      turnCount: entry.session.turn_count,
      elapsedSeconds: Math.round((now - entry.session.started_at) / 1000),
    }));

    // Collect pending retries info before clearing
    const pendingRetries = Array.from(this.state.retry_attempts.values()).map((retry) => ({
      identifier: retry.identifier,
      attempt: retry.attempt,
      dueInSeconds: Math.max(0, Math.round((retry.due_at_ms - now) / 1000)),
    }));

    // Cancel all pending retries
    for (const [, retry] of this.state.retry_attempts) {
      clearTimeout(retry.timer_handle);
    }
    this.state.retry_attempts.clear();

    // Abort all running agents
    for (const [, entry] of this.state.running) {
      entry.session.abort_controller.abort();
    }

    // Wait for all running agents to finish
    const promises = Array.from(this.state.running.values()).map((e) =>
      e.promise.catch(() => {}),
    );
    await Promise.allSettled(promises);

    // Print human-readable shutdown summary
    const lines: string[] = [];
    lines.push("Claude Symphony shutting down...");

    if (runningAgents.length > 0) {
      const agentList = runningAgents
        .map((a) => `${a.identifier} (turn ${a.turnCount}, ${this.formatDuration(a.elapsedSeconds)})`)
        .join(", ");
      const plural = runningAgents.length === 1 ? "agent" : "agents";
      lines.push(`  Stopping ${runningAgents.length} running ${plural}: ${agentList}`);
    }

    if (pendingRetries.length > 0) {
      const retryList = pendingRetries
        .map((r) => `${r.identifier} (attempt ${r.attempt}, due in ${this.formatDuration(r.dueInSeconds)})`)
        .join(", ");
      const plural = pendingRetries.length === 1 ? "retry" : "retries";
      lines.push(`  Cancelling ${pendingRetries.length} pending ${plural}: ${retryList}`);
    }

    const totals = this.state.totals;
    const successCount = this.state.completed.size;
    const failureCount = totals.failures;
    const issuesProcessed = successCount + failureCount;
    const totalRuntimeSeconds = Math.round(totals.runtime_seconds);

    lines.push("  Session summary:");
    lines.push(`    Issues processed: ${issuesProcessed}`);
    lines.push(`    Successful: ${successCount}`);
    lines.push(`    Failed: ${failureCount}`);
    lines.push(`    Total tokens: ${totals.total_tokens.toLocaleString()}`);
    lines.push(`    Total runtime: ${this.formatDuration(totalRuntimeSeconds)}`);

    process.stderr.write(lines.join("\n") + "\n");

    log.info({
      event: "shutdown_complete",
      issues_processed: issuesProcessed,
      successful: successCount,
      failed: failureCount,
      total_tokens: totals.total_tokens,
      runtime_seconds: totalRuntimeSeconds,
    });
  }

  private formatDuration(seconds: number): string {
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    if (remainingSeconds === 0) {
      return `${minutes}m`;
    }
    return `${minutes}m ${remainingSeconds}s`;
  }

  getSnapshot(): {
    running: Array<{
      issue_identifier: string;
      turn_count: number;
      tokens: number;
      elapsed_s: number;
    }>;
    retrying: Array<{ identifier: string; attempt: number; due_in_s: number }>;
    totals: OrchestratorState["totals"];
  } {
    const now = Date.now();
    return {
      running: Array.from(this.state.running.values()).map((e) => ({
        issue_identifier: e.issue.identifier,
        turn_count: e.session.turn_count,
        tokens: e.session.total_tokens,
        elapsed_s: Math.round((now - e.session.started_at) / 1000),
      })),
      retrying: Array.from(this.state.retry_attempts.values()).map((r) => ({
        identifier: r.identifier,
        attempt: r.attempt,
        due_in_s: Math.max(0, Math.round((r.due_at_ms - now) / 1000)),
      })),
      totals: this.state.totals,
    };
  }

  // --- Startup cleanup ---

  private async startupCleanup(): Promise<void> {
    try {
      const terminalIssues = await this.tracker.fetch_issues_by_states(
        this.config.tracker.terminal_states,
      );
      let cleaned = 0;
      for (const issue of terminalIssues) {
        try {
          this.workspaceManager.remove(issue.identifier);
          cleaned++;
        } catch {
          // ignore individual cleanup failures
        }
      }
      if (cleaned > 0) {
        log.info({ event: "startup_cleanup", workspaces_removed: cleaned });
      }
    } catch (e) {
      log.warn({
        event: "startup_cleanup_failed",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // --- Poll tick ---

  private async tick(): Promise<void> {
    if (this.shuttingDown) return;

    await this.reconcile();

    const validationErrors = this.validateForDispatch();
    if (validationErrors.length > 0) {
      log.warn({
        event: "dispatch_skipped",
        reason: "validation_failed",
        errors: validationErrors.join("; "),
      });
      return;
    }

    let candidates: Issue[];
    try {
      candidates = await this.tracker.fetch_candidate_issues();
    } catch (e) {
      log.error({
        event: "fetch_candidates_failed",
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    const eligible = this.filterAndSort(candidates);
    let availableSlots = this.availableSlots();

    log.info({
      event: "poll",
      candidates: candidates.length,
      eligible: eligible.length,
      running: this.state.running.size,
      available_slots: availableSlots,
    });

    for (const issue of eligible) {
      if (availableSlots <= 0) break;
      if (this.state.claimed.has(issue.id)) continue;
      if (this.state.running.has(issue.id)) continue;

      if (!this.hasPerStateSlot(issue.state)) continue;

      this.dispatch(issue, null);
      availableSlots--;
    }
  }

  // --- Reconciliation ---

  private async reconcile(): Promise<void> {
    if (this.state.running.size === 0) return;

    // Part A: stall detection
    const now = Date.now();
    const stallTimeout = 300000; // 5 minutes
    for (const [id, entry] of this.state.running) {
      const elapsed = now - entry.session.last_activity;
      if (stallTimeout > 0 && elapsed > stallTimeout) {
        log.warn({
          event: "stall_detected",
          issue_identifier: entry.issue.identifier,
          elapsed_ms: elapsed,
        });
        entry.session.abort_controller.abort();
      }
    }

    // Part B: tracker state refresh
    const runningIds = Array.from(this.state.running.keys());
    try {
      const currentStates =
        await this.tracker.fetch_issue_states_by_ids(runningIds);

      for (const [id, entry] of this.state.running) {
        const currentState = currentStates.get(id);
        if (!currentState) {
          log.info({
            event: "reconcile_missing",
            issue_identifier: entry.issue.identifier,
          });
          entry.session.abort_controller.abort();
          continue;
        }

        const normalizedState = currentState.toLowerCase();
        const isTerminal = this.config.tracker.terminal_states.some(
          (s) => s.toLowerCase() === normalizedState,
        );
        if (isTerminal) {
          log.info({
            event: "reconcile_terminal",
            issue_identifier: entry.issue.identifier,
            new_state: currentState,
          });
          entry.session.abort_controller.abort();
          this.workspaceManager.remove(entry.issue.identifier);
        }

        const isActive = this.config.tracker.active_states.some(
          (s) => s.toLowerCase() === normalizedState,
        );
        if (!isActive && !isTerminal) {
          log.info({
            event: "reconcile_inactive",
            issue_identifier: entry.issue.identifier,
            new_state: currentState,
          });
          entry.session.abort_controller.abort();
        }
      }
    } catch (e) {
      log.warn({
        event: "reconcile_fetch_failed",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // --- Dispatch ---

  private dispatch(issue: Issue, attempt: number | null): void {
    this.state.claimed.add(issue.id);

    const session: LiveSession = {
      session_id: `${issue.id}-${Date.now()}`,
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      started_at: Date.now(),
      last_activity: Date.now(),
      turn_count: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      abort_controller: new AbortController(),
    };

    log.info({
      event: "dispatch",
      issue_id: issue.id,
      issue_identifier: issue.identifier,
      title: issue.title,
      attempt,
    });

    const promise = this.executeWorker(issue, session, attempt).then(
      () => this.handleWorkerExit(issue, session, null),
      (error) => this.handleWorkerExit(issue, session, error),
    );

    this.state.running.set(issue.id, { issue, session, promise, attempt });
  }

  private async executeWorker(
    issue: Issue,
    session: LiveSession,
    attempt: number | null,
  ): Promise<void> {
    const workspace = this.workspaceManager.ensure(issue.identifier);

    this.workspaceManager.runBeforeRun(issue.identifier, workspace.path);

    let prompt: string;
    try {
      prompt = renderPrompt(this.promptTemplate, issue, attempt);
    } catch (e) {
      throw new Error(
        `Prompt render failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    await runAgent(prompt, workspace.path, this.config, session, this.dryRun);

    this.workspaceManager.runAfterRun(issue.identifier, workspace.path);
  }

  private handleWorkerExit(
    issue: Issue,
    session: LiveSession,
    error: unknown,
  ): void {
    this.state.running.delete(issue.id);

    const elapsed = (Date.now() - session.started_at) / 1000;
    this.state.totals.input_tokens += session.input_tokens;
    this.state.totals.output_tokens += session.output_tokens;
    this.state.totals.total_tokens += session.total_tokens;
    this.state.totals.runtime_seconds += elapsed;

    if (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.state.totals.failures++;
      log.error({
        event: "worker_failed",
        issue_identifier: issue.identifier,
        error: errMsg,
        turns: session.turn_count,
        elapsed_s: Math.round(elapsed),
      });
      this.scheduleRetry(issue, errMsg, true);
    } else {
      log.info({
        event: "worker_succeeded",
        issue_identifier: issue.identifier,
        turns: session.turn_count,
        tokens: session.total_tokens,
        elapsed_s: Math.round(elapsed),
      });
      this.state.completed.add(issue.id);
      if (!this.dryRun) {
        this.scheduleContinuationCheck(issue);
      }
      // In dry-run mode, keep the claim so the issue isn't re-dispatched
      // (since the tracker state never changes in dry-run)
    }
  }

  // --- Retry & continuation ---

  private scheduleContinuationCheck(issue: Issue): void {
    this.scheduleRetry(issue, null, false);
  }

  private scheduleRetry(
    issue: Issue,
    error: string | null,
    isFailure: boolean,
  ): void {
    if (this.shuttingDown) {
      this.releaseClaim(issue.id);
      return;
    }

    const existing = this.state.retry_attempts.get(issue.id);
    if (existing) {
      clearTimeout(existing.timer_handle);
    }

    const prevAttempt = existing?.attempt ?? 0;
    const attempt = isFailure ? prevAttempt + 1 : 1;
    const delay = isFailure
      ? Math.min(
          10000 * Math.pow(2, attempt - 1),
          this.config.agent.max_retry_backoff_ms,
        )
      : 1000;

    const dueAt = Date.now() + delay;

    log.info({
      event: isFailure ? "retry_scheduled" : "continuation_scheduled",
      issue_identifier: issue.identifier,
      attempt,
      delay_ms: delay,
      error,
    });

    const timer = setTimeout(() => {
      this.handleRetryFired(issue.id).catch((e) => {
        log.error({
          event: "retry_handler_error",
          issue_id: issue.id,
          error: e instanceof Error ? e.message : String(e),
        });
      });
    }, delay);

    this.state.retry_attempts.set(issue.id, {
      issue_id: issue.id,
      identifier: issue.identifier,
      attempt,
      due_at_ms: dueAt,
      timer_handle: timer,
      error,
    });
  }

  private async handleRetryFired(issueId: string): Promise<void> {
    const retry = this.state.retry_attempts.get(issueId);
    if (!retry) return;
    this.state.retry_attempts.delete(issueId);

    if (this.shuttingDown) {
      this.releaseClaim(issueId);
      return;
    }

    let candidates: Issue[];
    try {
      candidates = await this.tracker.fetch_candidate_issues();
    } catch {
      this.releaseClaim(issueId);
      return;
    }

    const issue = candidates.find((c) => c.id === issueId);
    if (!issue) {
      log.info({
        event: "retry_released",
        issue_id: issueId,
        reason: "not_found_or_inactive",
      });
      this.releaseClaim(issueId);
      return;
    }

    if (this.availableSlots() <= 0) {
      log.warn({
        event: "retry_requeued",
        issue_identifier: issue.identifier,
        reason: "no_slots",
      });
      this.scheduleRetry(issue, "no available orchestrator slots", true);
      return;
    }

    this.dispatch(issue, retry.attempt);
  }

  private releaseClaim(issueId: string): void {
    this.state.claimed.delete(issueId);
  }

  // --- Candidate selection ---

  private filterAndSort(candidates: Issue[]): Issue[] {
    const eligible = candidates.filter((issue) => {
      if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
        return false;
      }

      const stateNorm = issue.state.toLowerCase();
      const isActive = this.config.tracker.active_states.some(
        (s) => s.toLowerCase() === stateNorm,
      );
      const isTerminal = this.config.tracker.terminal_states.some(
        (s) => s.toLowerCase() === stateNorm,
      );
      if (!isActive || isTerminal) return false;

      if (this.state.running.has(issue.id)) return false;
      if (this.state.claimed.has(issue.id)) return false;

      if (stateNorm === "todo" && issue.blocked_by.length > 0) {
        const allBlockersTerminal = issue.blocked_by.every((b) => {
          if (!b.state) return false;
          return this.config.tracker.terminal_states.some(
            (s) => s.toLowerCase() === b.state!.toLowerCase(),
          );
        });
        if (!allBlockersTerminal) return false;
      }

      return true;
    });

    eligible.sort((a, b) => {
      const pa = a.priority ?? 999;
      const pb = b.priority ?? 999;
      if (pa !== pb) return pa - pb;

      const ca = a.created_at ?? "";
      const cb = b.created_at ?? "";
      if (ca !== cb) return ca < cb ? -1 : 1;

      return a.identifier.localeCompare(b.identifier);
    });

    return eligible;
  }

  // --- Concurrency ---

  private availableSlots(): number {
    return Math.max(
      this.config.agent.max_concurrent_agents - this.state.running.size,
      0,
    );
  }

  private hasPerStateSlot(state: string): boolean {
    const limit =
      this.config.agent.max_concurrent_agents_by_state[state.toLowerCase()];
    if (limit === undefined) return true;

    let count = 0;
    for (const [, entry] of this.state.running) {
      if (entry.issue.state.toLowerCase() === state.toLowerCase()) {
        count++;
      }
    }
    return count < limit;
  }

  private validateForDispatch(): string[] {
    const errors: string[] = [];
    if (!this.promptTemplate && !this.dryRun) {
      errors.push("No prompt template loaded");
    }
    return errors;
  }
}
