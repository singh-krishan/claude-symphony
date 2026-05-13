# Claude Symphony — Implementation Plan & How-To Guide

## What Is This?

Claude Symphony is a long-running automation service that:

1. Polls an issue tracker (Linear) for work
2. Creates an isolated workspace directory for each issue
3. Runs a Claude coding agent inside that workspace to complete the work
4. Manages concurrency, retries, and lifecycle — hands-free

It is a Claude-powered reimplementation of OpenAI's Symphony/Codex orchestrator.

---

## How It Works (End-to-End Flow)

```
┌─────────────────────────────────────────────────────────────┐
│                     CLAUDE SYMPHONY                         │
│                                                             │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────────┐   │
│  │  Linear   │───▶│ Orchestrator │───▶│  Agent Runner    │   │
│  │  Tracker  │◀──│              │    │  (Claude API)    │   │
│  └──────────┘    │  - Poll loop │    │  - Tool use      │   │
│                  │  - Dispatch  │    │  - Multi-turn    │   │
│  ┌──────────┐    │  - Retry     │    │  - Bash/Files    │   │
│  │WORKFLOW  │───▶│  - Reconcile │    └──────────────────┘   │
│  │  .md     │    └──────────────┘             │              │
│  └──────────┘           │                     ▼              │
│                  ┌──────────────┐    ┌──────────────────┐   │
│                  │  Workspace   │    │  Per-Issue        │   │
│                  │  Manager     │───▶│  Workspace Dirs   │   │
│                  └──────────────┘    │  /tmp/symphony/   │   │
│                                     │    ABC-123/        │   │
│                                     │    ABC-124/        │   │
│                                     └──────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Step-by-step:

1. **Startup**: Symphony reads `WORKFLOW.md` from your repo, validates config, cleans up stale workspaces.

2. **Poll Tick** (every 30s by default):
   - Reconcile: check all running agents — kill stalled ones, stop ones whose issues moved to terminal states.
   - Fetch candidate issues from Linear (issues in "Todo" or "In Progress" states).
   - Sort by priority, then creation date.
   - Dispatch eligible issues (up to concurrency limit) to available agent slots.

3. **Dispatch** (for each eligible issue):
   - Claim the issue (prevent duplicate dispatch).
   - Create or reuse a workspace directory at `<workspace_root>/<issue_identifier>/`.
   - Run `after_create` hook if workspace is brand new (e.g., `git clone`).
   - Run `before_run` hook (e.g., `git pull`, `npm install`).
   - Render the prompt template with issue data.
   - Launch a Claude agent session in that workspace.

4. **Agent Execution**:
   - Claude receives the rendered prompt describing the issue.
   - Claude uses tools (bash, read_file, write_file, edit_file) to work on the code.
   - Multi-turn: Claude can take up to `max_turns` (default 20) actions.
   - Each turn: Claude thinks, picks a tool, executes, sees result, continues.
   - On completion: run `after_run` hook (e.g., `git commit && git push`).

5. **After Completion**:
   - Normal exit → schedule continuation check (1s delay) to see if issue is still active.
   - Failure → exponential backoff retry (10s, 20s, 40s... capped at 5min).
   - Issue moved to terminal state → release claim, clean workspace.

---

## Architecture — Components

### 1. Workflow Loader (`src/workflow.ts`)

Reads and parses `WORKFLOW.md` — a Markdown file with YAML front matter.

```markdown
---
tracker:
  kind: linear
  project_slug: my-project
  api_key: $LINEAR_API_KEY

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony_workspaces

hooks:
  after_create: |
    git clone git@github.com:myorg/myrepo.git .
  before_run: |
    git checkout main && git pull
  after_run: |
    git add -A && git commit -m "fix: {{issue.identifier}} — {{issue.title}}" && git push

agent:
  max_concurrent_agents: 5
  max_turns: 20

claude:
  model: claude-sonnet-4-6
  max_tokens: 8096
---

You are a senior software engineer. You are working on issue {{issue.identifier}}.

## Issue Details
- **Title**: {{issue.title}}
- **Description**: {{issue.description}}

## Instructions
1. Read the codebase to understand the relevant code.
2. Implement the fix or feature described in the issue.
3. Write or update tests as needed.
4. Ensure the code builds and tests pass.

{% if attempt %}
This is retry attempt #{{attempt}}. A previous attempt failed.
Review what was done before and continue from where it left off.
{% endif %}
```

**Output**: `{ config: <parsed YAML>, prompt_template: <markdown body> }`

### 2. Config Layer (`src/config.ts`)

Typed getters over the raw YAML config with:
- Environment variable resolution (`$VAR_NAME` → `process.env.VAR_NAME`)
- Default values for every field
- Validation before dispatch

Key config fields:

| Field | Type | Default |
|-------|------|---------|
| `tracker.kind` | string | `"linear"` (required) |
| `tracker.api_key` | string | `$LINEAR_API_KEY` |
| `tracker.project_slug` | string | (required) |
| `tracker.active_states` | string[] | `["Todo", "In Progress"]` |
| `tracker.terminal_states` | string[] | `["Done", "Closed", "Cancelled", "Canceled", "Duplicate"]` |
| `polling.interval_ms` | number | `30000` |
| `workspace.root` | string | `<tmpdir>/symphony_workspaces` |
| `hooks.after_create` | string? | `null` |
| `hooks.before_run` | string? | `null` |
| `hooks.after_run` | string? | `null` |
| `hooks.before_remove` | string? | `null` |
| `hooks.timeout_ms` | number | `60000` |
| `agent.max_concurrent_agents` | number | `10` |
| `agent.max_turns` | number | `20` |
| `agent.max_retry_backoff_ms` | number | `300000` |
| `agent.max_concurrent_agents_by_state` | map | `{}` |
| `claude.model` | string | `"claude-sonnet-4-6"` |
| `claude.max_tokens` | number | `8096` |

### 3. Issue Tracker Client (`src/tracker/linear.ts`)

GraphQL client for Linear with three operations:

```
fetch_candidate_issues()
  → Issues in active_states for the configured project
  → Paginated, normalized to our Issue type

fetch_issues_by_states(state_names)
  → Used for startup terminal cleanup

fetch_issue_states_by_ids(issue_ids)
  → Used for active-run reconciliation
```

**Normalization**: Linear API responses → our `Issue` type:
- `labels` → lowercase strings
- `blocked_by` → derived from inverse relations
- `priority` → integer only
- `created_at`/`updated_at` → ISO-8601 parsed

### 4. Workspace Manager (`src/workspace.ts`)

Maps issue identifiers to filesystem paths.

```
Workspace key: issue.identifier with non-[A-Za-z0-9._-] replaced by _
Workspace path: <workspace.root>/<workspace_key>/
```

Operations:
- `ensure(issue_identifier)` → create dir if needed, run `after_create` hook, return `{ path, created_now }`
- `remove(issue_identifier)` → run `before_remove` hook, delete directory
- `runHook(name, workspace_path)` → execute shell script with cwd=workspace, timeout enforced

Safety invariants:
- Workspace path must be inside workspace root (no path traversal)
- Agent cwd is always the workspace path
- Workspace key is sanitized

### 5. Prompt Renderer (`src/prompt.ts`)

Uses Liquid template engine to render `prompt_template` with:
- `issue` object (all normalized fields)
- `attempt` integer (null on first run)

Strict mode: unknown variables and filters cause errors.

### 6. Agent Runner (`src/agent.ts`)

**This is where Codex is replaced with Claude.**

Instead of launching `codex app-server` as a subprocess, we use the Anthropic SDK directly:

```typescript
// Pseudocode for one agent session
async function runAgent(prompt, workspacePath, config) {
  const anthropic = new Anthropic();
  const messages = [{ role: "user", content: prompt }];

  for (let turn = 0; turn < config.agent.max_turns; turn++) {
    const response = await anthropic.messages.create({
      model: config.claude.model,
      max_tokens: config.claude.max_tokens,
      system: "You are a coding agent. Use the provided tools to complete the task.",
      tools: AGENT_TOOLS,
      messages,
    });

    // If Claude is done (no tool use), break
    if (response.stop_reason === "end_turn") break;

    // Execute tool calls, append results, continue
    messages.push({ role: "assistant", content: response.content });
    const toolResults = await executeTools(response.content, workspacePath);
    messages.push({ role: "user", content: toolResults });
  }
}
```

**Tools provided to Claude:**

| Tool | Description |
|------|-------------|
| `bash` | Execute a shell command in the workspace directory. Returns stdout/stderr. |
| `read_file` | Read a file's contents (with optional line range). |
| `write_file` | Create or overwrite a file. |
| `edit_file` | Search-and-replace within a file. |
| `list_directory` | List files/directories at a path. |

All tool executions are **sandboxed to the workspace directory** — paths are resolved relative to it, and traversal outside is rejected.

**Key differences from Codex app-server:**
- No subprocess / JSON-RPC protocol — direct API calls
- No approval flow needed — tools auto-execute (high-trust mode)
- Token tracking via API response `usage` field
- Stall detection via timestamp of last API response

### 7. Orchestrator (`src/orchestrator.ts`)

The central state machine. Owns:

**In-memory state:**
```typescript
{
  running: Map<issue_id, RunningEntry>,  // active agent sessions
  claimed: Set<issue_id>,                // reserved IDs
  retry_attempts: Map<issue_id, RetryEntry>,
  completed: Set<issue_id>,             // bookkeeping
  codex_totals: { input_tokens, output_tokens, runtime_seconds },
}
```

**Issue orchestration states** (internal, not tracker states):
1. `Unclaimed` — not running, no retry scheduled
2. `Claimed` — reserved for dispatch
3. `Running` — agent session active
4. `RetryQueued` — waiting for retry timer
5. `Released` — claim removed (terminal/completed)

**Poll tick sequence:**
1. Reconcile active runs (stall detection + tracker state refresh)
2. Validate config (skip dispatch if invalid)
3. Fetch candidate issues from tracker
4. Sort by priority (ascending), then created_at (oldest first), then identifier
5. Dispatch eligible issues while slots remain
6. Log state changes

**Dispatch eligibility** (all must be true):
- Issue has id, identifier, title, state
- State is in active_states and not in terminal_states
- Not already running or claimed
- Global concurrency slots available
- Per-state concurrency slots available (if configured)
- Blocker rule: if state is "Todo", all blockers must be terminal

**Concurrency:**
- Global: `available_slots = max(max_concurrent_agents - running_count, 0)`
- Per-state: `max_concurrent_agents_by_state[state]` if set

**Retry & backoff:**
- Normal continuation (clean exit): 1000ms fixed delay
- Failure retry: `min(10000 * 2^(attempt - 1), max_retry_backoff_ms)`

**Reconciliation (every tick):**
- Part A — Stall detection: if no agent event for > `stall_timeout_ms` (default 5min), kill and retry
- Part B — Tracker refresh: fetch current state for all running issues; stop if terminal

### 8. Logger (`src/logger.ts`)

Structured key=value logging to stderr.

```
level=info event=dispatch issue_id=abc123 issue_identifier=ABC-123 action=started
level=info event=agent_turn issue_id=abc123 turn=3 input_tokens=1500 output_tokens=800
level=warn event=stall_detected issue_id=abc123 elapsed_ms=310000
level=error event=agent_failed issue_id=abc123 error="Command timed out"
```

Required context fields:
- `issue_id` and `issue_identifier` for issue-related logs
- `session_id` for agent session logs

### 9. CLI Entry Point (`src/index.ts`)

```
Usage: claude-symphony [options]

Options:
  --workflow <path>    Path to WORKFLOW.md (default: ./WORKFLOW.md)
  --port <number>      Enable HTTP status server on this port
  --help               Show help

Environment:
  LINEAR_API_KEY       Linear API token
  ANTHROPIC_API_KEY    Anthropic API key for Claude
```

Startup sequence:
1. Parse CLI args
2. Load and validate WORKFLOW.md
3. Initialize tracker client
4. Run startup terminal cleanup
5. Start file watcher on WORKFLOW.md for dynamic reload
6. Start poll loop
7. Handle SIGINT/SIGTERM for graceful shutdown

### 10. Status Surface (optional, `src/status.ts`)

Optional HTTP endpoint or terminal UI showing:
- Running sessions (issue, turn count, tokens, elapsed time)
- Retry queue
- Aggregate token totals
- Rate limit info

---

## File Structure

```
claude-symphony/
├── package.json
├── tsconfig.json
├── WORKFLOW.md.example      # Example workflow file
├── src/
│   ├── index.ts             # CLI entry point
│   ├── types.ts             # Shared type definitions
│   ├── config.ts            # Config layer (typed getters, defaults, validation)
│   ├── workflow.ts          # WORKFLOW.md loader/parser
│   ├── prompt.ts            # Liquid template renderer
│   ├── logger.ts            # Structured logger
│   ├── orchestrator.ts      # Main orchestration state machine
│   ├── agent.ts             # Claude agent runner (replaces Codex)
│   ├── workspace.ts         # Workspace manager + hooks
│   ├── status.ts            # Optional HTTP status endpoint
│   └── tracker/
│       ├── types.ts         # Tracker-specific types
│       ├── linear.ts        # Linear GraphQL client
│       └── index.ts         # Tracker factory
```

---

## How To Use It

### Prerequisites

1. **Node.js** >= 18
2. **Anthropic API Key** — set `ANTHROPIC_API_KEY` env var
3. **Linear API Key** — set `LINEAR_API_KEY` env var
4. **A Linear project** with issues in "Todo" or "In Progress" states

### Setup

```bash
# Clone and install
cd claude-symphony
npm install
npm run build

# Set environment variables
export ANTHROPIC_API_KEY="sk-ant-..."
export LINEAR_API_KEY="lin_api_..."
```

### Create Your WORKFLOW.md

Place a `WORKFLOW.md` in your repository root. This file defines:
- **YAML front matter**: runtime configuration (tracker, polling, workspace, hooks, Claude settings)
- **Markdown body**: the prompt template sent to Claude for each issue

The prompt template uses Liquid syntax with `{{issue.title}}`, `{{issue.description}}`, `{{attempt}}`, etc.

### Run

```bash
# Start the orchestrator
claude-symphony --workflow ./WORKFLOW.md

# With optional status server
claude-symphony --workflow ./WORKFLOW.md --port 8080
```

### What Happens Next

1. Symphony connects to Linear and fetches issues from your project.
2. For each eligible issue, it creates a workspace and launches a Claude agent.
3. Claude reads the codebase, implements changes, runs tests — all autonomously.
4. Your `after_run` hook can auto-commit and push the changes.
5. The issue stays claimed until it moves to a terminal state in Linear.

### Monitoring

Watch the structured logs in your terminal:
```
[2026-05-13T10:00:00Z] level=info event=startup workflow=WORKFLOW.md issues_cleaned=2
[2026-05-13T10:00:01Z] level=info event=poll candidates=3 running=0 available_slots=5
[2026-05-13T10:00:01Z] level=info event=dispatch issue_identifier=ABC-123 title="Fix auth bug"
[2026-05-13T10:00:15Z] level=info event=agent_turn issue_identifier=ABC-123 turn=1 tool=bash
[2026-05-13T10:01:30Z] level=info event=agent_completed issue_identifier=ABC-123 turns=8 tokens=12400
```

Or hit the status endpoint:
```bash
curl http://localhost:8080/status
```

---

## Key Differences from OpenAI Symphony

| Aspect | OpenAI Symphony | Claude Symphony |
|--------|----------------|-----------------|
| Agent | Codex app-server (subprocess, JSON-RPC over stdio) | Claude API (direct SDK calls with tool_use) |
| Protocol | Custom JSON-RPC line protocol | Standard Anthropic Messages API |
| Tools | Defined by Codex runtime | Defined by us (bash, read/write/edit file) |
| Approval | Configurable (AskForApproval enum) | Auto-approve (high-trust mode) |
| Sandbox | Codex SandboxMode | Workspace-path containment |
| Model config | `codex.*` fields | `claude.*` fields (model, max_tokens) |
| Stall detection | Based on Codex events | Based on last API response timestamp |
| Token tracking | From Codex protocol events | From API response `usage` field |

Everything else — the orchestrator state machine, polling, concurrency control, retry/backoff, reconciliation, workspace management, hooks, WORKFLOW.md format, Linear integration — is the same.

---

## Testing — Three Levels

You can test Claude Symphony without spending a dime on Linear or Claude until you're ready.

### Level 1: Local Mock Tracker (No Linear, No Claude API)

We'll build a **local file-based tracker** (`tracker.kind: "local"`) so you can test the full orchestrator loop with zero external dependencies.

**How it works:**
- Issues are defined in a local JSON file (e.g., `issues.json`)
- You edit that file to change issue states, add new issues, etc.
- The orchestrator polls the file instead of Linear's API

**Setup:**

```bash
# 1. Create a test issues file
cat > issues.json << 'EOF'
[
  {
    "id": "1",
    "identifier": "TEST-1",
    "title": "Add a hello world endpoint",
    "description": "Create a simple HTTP server with a /hello endpoint that returns 'Hello World'",
    "state": "Todo",
    "priority": 1,
    "labels": [],
    "blocked_by": []
  },
  {
    "id": "2",
    "identifier": "TEST-2",
    "title": "Write a fibonacci function",
    "description": "Create a file called fib.py with a function that computes the nth fibonacci number. Include tests.",
    "state": "Todo",
    "priority": 2,
    "labels": [],
    "blocked_by": []
  }
]
EOF

# 2. Create a WORKFLOW.md using the local tracker
cat > WORKFLOW.md << 'EOF'
---
tracker:
  kind: local
  issues_file: ./issues.json

polling:
  interval_ms: 10000

workspace:
  root: ./test_workspaces

agent:
  max_concurrent_agents: 1
  max_turns: 10

claude:
  model: claude-sonnet-4-6
  max_tokens: 4096
---

You are a software engineer. Complete this task:

**{{issue.identifier}}: {{issue.title}}**

{{issue.description}}

Work in the current directory. Create any files needed.
EOF

# 3. Run (still needs ANTHROPIC_API_KEY for the agent)
claude-symphony --workflow ./WORKFLOW.md
```

**To test without Claude API too** (pure dry-run):

```bash
# Dry-run mode: orchestrator runs but agents just log what they would do
claude-symphony --workflow ./WORKFLOW.md --dry-run
```

In dry-run mode, the agent runner skips the Claude API call and logs the rendered prompt instead. This lets you verify:
- Workflow parsing works
- Issues are fetched and sorted correctly
- Workspaces are created
- Hooks run
- Concurrency limits are respected
- Retry/reconciliation logic works

**Changing issue state during a test:**

```bash
# Simulate moving TEST-1 to "Done" while the agent is running
# Edit issues.json and change TEST-1's state to "Done"
# On the next poll tick, reconciliation will detect this and stop the agent
```

### Level 2: Local Tracker + Real Claude (Test the Agent)

Same as Level 1 but without `--dry-run`. This tests the actual Claude agent:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
claude-symphony --workflow ./WORKFLOW.md
```

Watch Claude:
1. Read the issue description
2. Create files in `./test_workspaces/TEST_1/`
3. Write code, run commands
4. Complete the task

You can inspect the workspace afterward:
```bash
ls ./test_workspaces/TEST_1/
cat ./test_workspaces/TEST_1/fib.py
```

**Cost estimate**: Each issue typically uses 5-15 agent turns. With claude-sonnet-4-6, expect ~$0.05-0.30 per issue depending on complexity.

### Level 3: Linear + Real Claude (Production)

Full production mode with Linear as the tracker. See the Linear setup guide below.

---

## Setting Up Linear (Step by Step)

### What is Linear?

Linear is a project management tool (like Jira but faster). Symphony uses it as the source of truth for what work needs to be done. Free tier is sufficient for testing.

### Step 1: Create a Linear Account

1. Go to **https://linear.app**
2. Click **"Get started"** — sign up with Google/GitHub/email
3. Create a workspace (e.g., "My Workspace")

### Step 2: Create a Project

1. In Linear, click **"Projects"** in the left sidebar
2. Click **"New Project"**
3. Name it (e.g., "symphony-test")
4. Note the **project slug** — this is the URL-friendly name. If you named it "symphony-test", the slug is typically `symphony-test`. You can find it in the URL: `linear.app/<workspace>/project/<slug>`

### Step 3: Create Issues

1. Click **"New Issue"** (or press `C`)
2. Fill in:
   - **Title**: e.g., "Add error handling to the API"
   - **Description**: Detailed description of what the agent should do
   - **Status**: Set to **"Todo"** (this is an active state Symphony will pick up)
   - **Priority**: Urgent/High/Medium/Low (Symphony dispatches higher priority first)
   - **Project**: Assign to your project
3. Create a few issues to test with

**Tips for good issue descriptions** (the agent reads these):
- Be specific about what files to create/modify
- Mention the programming language
- Describe expected behavior
- Mention if tests are needed

Example issue:
```
Title: Create a REST API for user management
Description:
Create a Node.js Express API with these endpoints:
- POST /users - create a user (name, email)
- GET /users - list all users
- GET /users/:id - get a user by ID
- DELETE /users/:id - delete a user

Use an in-memory array for storage (no database needed).
Include basic input validation.
Write tests using Jest.
```

### Step 4: Get Your API Key

1. Click your avatar (bottom-left) → **"Settings"**
2. Go to **"API"** → **"Personal API keys"**
3. Click **"Create key"**
4. Give it a label (e.g., "symphony")
5. Copy the key — it starts with `lin_api_`

```bash
export LINEAR_API_KEY="lin_api_xxxxxxxxxxxx"
```

### Step 5: Create Your WORKFLOW.md

```yaml
---
tracker:
  kind: linear
  project_slug: symphony-test    # Your project slug from Step 2
  api_key: $LINEAR_API_KEY       # Reads from environment variable

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony_workspaces

hooks:
  after_create: |
    git init
    echo "node_modules/" > .gitignore
  after_run: |
    git add -A
    git commit -m "symphony: {{issue.identifier}} — {{issue.title}}" --allow-empty || true

agent:
  max_concurrent_agents: 3
  max_turns: 20

claude:
  model: claude-sonnet-4-6
  max_tokens: 8096
---

You are a senior software engineer working autonomously.

## Your Task
**{{issue.identifier}}: {{issue.title}}**

{{issue.description}}

## Guidelines
- Read existing code before making changes
- Write clean, well-structured code
- Add tests when appropriate
- Make sure the code runs without errors
- If you're unsure about something, make a reasonable decision and document it

{% if attempt %}
Note: This is retry attempt #{{attempt}}. Check what was done previously and continue.
{% endif %}
```

### Step 6: Run

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export LINEAR_API_KEY="lin_api_..."

claude-symphony --workflow ./WORKFLOW.md
```

Symphony will:
1. Connect to Linear, find your "Todo"/"In Progress" issues
2. Create workspaces under `~/symphony_workspaces/`
3. Run Claude on each issue
4. Auto-commit results via the `after_run` hook

### Step 7: Monitor

Watch the terminal output, or if you enabled the status server:
```bash
claude-symphony --workflow ./WORKFLOW.md --port 8080

# In another terminal:
curl localhost:8080/status | jq .
```

To stop an issue: move it to "Done" or "Cancelled" in Linear. Symphony will detect this on the next poll tick and stop the agent.

---

## Testing Checklist

### Orchestrator Logic (use --dry-run + local tracker)
- [ ] WORKFLOW.md parses correctly
- [ ] Issues are fetched and sorted by priority
- [ ] Concurrency limit is respected (set max_concurrent_agents: 1, create 3 issues)
- [ ] Changing an issue to "Done" in issues.json stops the agent
- [ ] Removing an issue from issues.json releases the claim
- [ ] Retry fires after simulated failure
- [ ] Stall detection works (set stall_timeout to something short like 5s)
- [ ] Dynamic reload: edit WORKFLOW.md while running, new config takes effect
- [ ] Hooks run in the correct order (after_create → before_run → after_run)

### Agent (use local tracker + real Claude)
- [ ] Claude receives the correct rendered prompt
- [ ] Claude can execute bash commands in the workspace
- [ ] Claude can read/write/edit files
- [ ] Tool execution is sandboxed to workspace directory
- [ ] Agent respects max_turns limit
- [ ] Token usage is tracked correctly
- [ ] Agent handles errors gracefully (bad commands, missing files)

### Linear Integration (use Linear + real Claude)
- [ ] Issues are fetched from the correct project
- [ ] Only active-state issues are picked up
- [ ] Terminal-state issues trigger cleanup
- [ ] Blocker detection works (create issue B blocked by issue A)
- [ ] Priority ordering works

---

## Updated File Structure

```
claude-symphony/
├── package.json
├── tsconfig.json
├── WORKFLOW.md.example          # Example for Linear
├── WORKFLOW.local.md.example    # Example for local testing
├── issues.example.json          # Example local issues file
├── src/
│   ├── index.ts                 # CLI entry point
│   ├── types.ts                 # Shared type definitions
│   ├── config.ts                # Config layer
│   ├── workflow.ts              # WORKFLOW.md loader/parser
│   ├── prompt.ts                # Liquid template renderer
│   ├── logger.ts                # Structured logger
│   ├── orchestrator.ts          # Main orchestration state machine
│   ├── agent.ts                 # Claude agent runner
│   ├── workspace.ts             # Workspace manager + hooks
│   ├── status.ts                # Optional HTTP status endpoint
│   └── tracker/
│       ├── types.ts             # Tracker interface + Issue type
│       ├── linear.ts            # Linear GraphQL client
│       ├── local.ts             # Local file-based tracker (for testing)
│       └── index.ts             # Tracker factory (picks linear or local)
```

---

## Implementation Order

The components should be built in dependency order:

**Phase 1 — Core (testable with --dry-run + local tracker):**
1. **types.ts** — no deps, everything else imports from here
2. **logger.ts** — no deps, used by everything
3. **workflow.ts** — depends on: yaml library
4. **config.ts** — depends on: types, workflow
5. **tracker/types.ts** — depends on: types (tracker interface)
6. **tracker/local.ts** — depends on: tracker/types (file-based, for testing)
7. **tracker/index.ts** — depends on: tracker/local
8. **workspace.ts** — depends on: config, logger
9. **prompt.ts** — depends on: types, liquidjs
10. **orchestrator.ts** — depends on: everything above (with dry-run support)
11. **index.ts** — depends on: orchestrator, config, workflow, logger

**Checkpoint: at this point you can `--dry-run` with the local tracker and verify the full orchestration loop without any API keys.**

**Phase 2 — Claude Agent:**
12. **agent.ts** — depends on: types, config, logger, anthropic SDK
13. Wire agent into orchestrator (remove dry-run stub)

**Checkpoint: now you can run with local tracker + real Claude agent.**

**Phase 3 — Linear Integration:**
14. **tracker/linear.ts** — depends on: tracker/types, config, logger
15. Update tracker/index.ts to support `kind: "linear"`

**Checkpoint: full production mode with Linear + Claude.**

**Phase 4 — Polish:**
16. **status.ts** — optional HTTP status endpoint
17. **WORKFLOW.md.example** — production example
18. **WORKFLOW.local.md.example** — local testing example
19. **issues.example.json** — sample issues file

Estimated lines of code: ~1800-2200 TypeScript across all files.
