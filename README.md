# Claude Symphony

An autonomous coding agent orchestrator powered by Claude. Claude Symphony watches your issue tracker (Linear, Jira, or a local JSON file), picks up issues automatically, and runs a Claude coding agent inside an isolated workspace to complete the work — then pushes a branch and opens a PR.

Inspired by OpenAI's Symphony/Codex orchestrator.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        CLAUDE SYMPHONY                           │
│                                                                  │
│  ┌─────────────┐   ┌────────────────────┐   ┌────────────────┐  │
│  │   Tracker   │──▶│    Orchestrator     │──▶│  Agent Runner  │  │
│  │             │◀──│                    │   │  (Claude API)  │  │
│  │  - Linear   │   │  - Poll loop       │   │                │  │
│  │  - Jira     │   │  - Dispatch        │   │  Tools:        │  │
│  │  - Local    │   │  - Retry/backoff   │   │  - bash        │  │
│  └─────────────┘   │  - Reconciliation  │   │  - read_file   │  │
│                    └────────────────────┘   │  - write_file  │  │
│  ┌─────────────┐            │               │  - edit_file   │  │
│  │ WORKFLOW.md │────────────┘               │  - list_dir    │  │
│  │             │            │               └────────────────┘  │
│  │  - Config   │            ▼                        │           │
│  │  - Prompt   │   ┌────────────────────┐            ▼           │
│  │  template   │   │  Workspace Manager │   ┌────────────────┐  │
│  └─────────────┘   │                    │──▶│  Per-Issue Dir  │  │
│                    │  - Create/reuse    │   │                │  │
│                    │  - Lifecycle hooks │   │  ~/symphony/   │  │
│                    │  - Cleanup         │   │    ABC-123/    │  │
│                    └────────────────────┘   │    ABC-124/    │  │
│                                             └────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### How it works

1. **Startup** — Reads `WORKFLOW.md`, validates config, removes stale workspaces for terminal issues.
2. **Poll tick** (every 30 s by default):
   - Reconcile running agents: abort stalled ones and any whose issue moved to a terminal state.
   - Fetch candidate issues from the tracker (issues in active states, e.g. `Todo`, `In Progress`).
   - Sort by priority, then creation date.
   - Dispatch up to the configured concurrency limit.
3. **Dispatch** — For each eligible issue:
   - Claim the issue (prevent duplicate dispatch).
   - Create (or reuse) `<workspace_root>/<issue-identifier>/`.
   - Run `after_create` hook on first creation (e.g. `git clone`).
   - Run `before_run` hook before each agent session (e.g. `git pull`).
   - Render the Liquid prompt template with issue data.
   - Launch a multi-turn Claude agent session.
4. **Agent execution** — Claude calls tools (`bash`, `read_file`, `write_file`, `edit_file`, `list_directory`) iteratively until it either completes the task or reaches `max_turns`.
5. **Post-run** — Run `after_run` hook (e.g. `git commit`, `gh pr create`).
6. **Retry / continuation** — On failure, exponential back-off retry. On success, re-check if the issue is still active to handle multi-session tasks.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js ≥ 18** | Uses native `fetch`, ES modules, and `AbortSignal.timeout` |
| **ANTHROPIC_API_KEY** | Get one at [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| **LINEAR_API_KEY** *(Linear only)* | Linear → Settings → API → Personal API keys |
| **JIRA_EMAIL + JIRA_API_TOKEN** *(Jira only)* | Jira → Account settings → Security → API tokens |
| **GitHub CLI `gh`** *(optional)* | Only needed if your hooks auto-create PRs |

---

## Quick Start (5 minutes)

### 1. Install

```bash
git clone https://github.com/singh-krishan/claude-symphony.git
cd claude-symphony
npm install
npm run build
```

Or run the interactive setup script which also handles WORKFLOW.md creation:

```bash
bash setup.sh
```

### 2. Set API keys

```bash
export ANTHROPIC_API_KEY="sk-ant-..."

# Linear:
export LINEAR_API_KEY="lin_api_..."

# Jira:
export JIRA_EMAIL="you@company.com"
export JIRA_API_TOKEN="your-token"
```

### 3. Create your WORKFLOW.md

Copy the example that matches your tracker:

```bash
# Linear
cp WORKFLOW.linear.md.example WORKFLOW.md

# Jira
cp WORKFLOW.jira.md.example WORKFLOW.md

# Local JSON (great for testing — no external tracker needed)
cp WORKFLOW.local.md.example WORKFLOW.md
cp issues.example.json issues.json
```

Edit `WORKFLOW.md` and fill in your project slug / domain (see [Configuration Reference](#configuration-reference) below).

### 4. Run

```bash
# Normal run
node dist/index.js

# With a status API on port 8080
node dist/index.js --port 8080

# Dry-run — no Claude API calls, useful to test config
node dist/index.js --dry-run

# Verbose logging
node dist/index.js --verbose

# Custom workflow file path
node dist/index.js --workflow ./my-project/WORKFLOW.md
```

Check the status endpoint (if `--port` is set):

```bash
curl http://localhost:8080/status   # running agents, retries, token totals
curl http://localhost:8080/health   # { "status": "ok" }
```

---

## Configuration Reference

`WORKFLOW.md` uses YAML front matter followed by a Liquid prompt template:

```
---
<yaml config>
---
<prompt template (Liquid)>
```

Symphony watches `WORKFLOW.md` for file changes and hot-reloads config without restarting.

### `tracker`

| Key | Required | Default | Description |
|---|---|---|---|
| `kind` | ✅ | — | `linear`, `jira`, or `local` |
| `project_slug` | ✅ (Linear/Jira) | — | Linear project `slugId`; Jira project key (e.g. `PROJ`) |
| `api_key` | ✅ (Linear/Jira) | `$LINEAR_API_KEY` / `$JIRA_API_TOKEN` | API token. Use `$ENV_VAR` to read from environment |
| `domain` | ✅ (Jira) | — | Jira domain, e.g. `mycompany.atlassian.net` |
| `email` | ✅ (Jira) | `$JIRA_EMAIL` | Jira account email for Basic Auth |
| `issues_file` | ✅ (Local) | — | Path to a JSON file, e.g. `./issues.json` |
| `active_states` | ❌ | `["Todo","In Progress"]` | Issue states to pick up and work on |
| `terminal_states` | ❌ | `["Done","Closed","Cancelled",…]` | Issue states that mean "finished — clean up workspace" |

### `polling`

| Key | Default | Description |
|---|---|---|
| `interval_ms` | `30000` | How often to poll the tracker (milliseconds) |

### `workspace`

| Key | Default | Description |
|---|---|---|
| `root` | `/tmp/symphony_workspaces` | Root directory for per-issue workspace folders. Supports `~` expansion |

### `hooks`

Shell scripts executed at key lifecycle points. Each runs in the workspace directory via `/bin/bash`. You can use Liquid template variables (e.g. `{{issue.identifier}}`) only in `before_run` and `after_run` — the other hooks run before the issue context is rendered.

| Key | When | Typical use |
|---|---|---|
| `after_create` | Once, when a workspace is first created | `git clone`, `npm install` |
| `before_run` | Before every agent session | `git pull`, create a feature branch |
| `after_run` | After a successful agent session | `git commit`, `git push`, `gh pr create` |
| `before_remove` | Before a workspace is deleted | Delete the remote branch |
| `timeout_ms` | — | Hook timeout (default `60000` ms) |

### `agent`

| Key | Default | Description |
|---|---|---|
| `max_concurrent_agents` | `10` | Global cap on simultaneous Claude sessions |
| `max_turns` | `20` | Maximum tool-use turns per session before giving up |
| `max_retry_backoff_ms` | `300000` | Maximum retry delay (5 min). Retries use exponential back-off starting at 10 s |
| `max_concurrent_agents_by_state` | `{}` | Per-state caps, e.g. `todo: 2` limits two agents to "Todo" issues at once |

### `claude`

| Key | Default | Description |
|---|---|---|
| `model` | `claude-sonnet-4-6` | Any Anthropic model identifier |
| `max_tokens` | `8096` | Max tokens per Claude response |

### Prompt template variables

The body of `WORKFLOW.md` (after the closing `---`) is a [Liquid](https://liquidjs.com/) template. Available variables:

| Variable | Type | Description |
|---|---|---|
| `issue.id` | string | Internal tracker ID |
| `issue.identifier` | string | Human-readable key, e.g. `ENG-42` |
| `issue.title` | string | Issue title |
| `issue.description` | string | Issue body / description |
| `issue.state` | string | Current workflow state |
| `issue.priority` | number \| `""` | Priority (1 = urgent, 4 = low); empty string if unset |
| `issue.labels` | array | Label names (lower-cased) |
| `issue.url` | string \| `""` | Link to the issue in the tracker |
| `issue.branch_name` | string \| `""` | Suggested branch name (Linear only) |
| `issue.blocked_by` | array | Blocker refs: `{ id, identifier, state }` |
| `attempt` | number \| `null` | Retry attempt number; `null` on the first run |

---

## Examples

### Local tracker (no external service)

Perfect for testing Symphony itself or running it against a static backlog.

**`WORKFLOW.md`:**
```yaml
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
You are a software engineer working autonomously in this directory.

## Your Task
**{{issue.identifier}}: {{issue.title}}**

{{issue.description}}

{% if attempt %}
This is retry attempt #{{attempt}}. Check what exists and continue from there.
{% endif %}
```

**`issues.json`:**
```json
[
  {
    "id": "1",
    "identifier": "TEST-1",
    "title": "Create a hello world HTTP server",
    "description": "Create server.js that listens on port 3000 and returns 'Hello World'",
    "state": "Todo",
    "priority": 1,
    "labels": ["backend"],
    "blocked_by": []
  }
]
```

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
node dist/index.js
```

---

### Linear tracker

```yaml
---
tracker:
  kind: linear
  project_slug: my-project-slug   # find this in the Linear project URL
  api_key: $LINEAR_API_KEY
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Cancelled

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony_workspaces

hooks:
  after_create: |
    git clone https://github.com/my-org/my-repo.git .
    npm install
  before_run: |
    git checkout main && git pull
    BRANCH="symphony/$(echo '{{issue.identifier}}' | tr '[:upper:]' '[:lower:]')"
    git checkout -b "$BRANCH" 2>/dev/null || git checkout "$BRANCH"
  after_run: |
    git add -A
    git commit -m "{{issue.identifier}}: {{issue.title}}" --allow-empty || true
    BRANCH="symphony/$(echo '{{issue.identifier}}' | tr '[:upper:]' '[:lower:]')"
    git push -u origin "$BRANCH" --force-with-lease
    gh pr create \
      --title "{{issue.identifier}}: {{issue.title}}" \
      --body "Closes {{issue.url}}" \
      --head "$BRANCH" 2>/dev/null || true
  timeout_ms: 120000

agent:
  max_concurrent_agents: 3
  max_turns: 20

claude:
  model: claude-sonnet-4-6
  max_tokens: 8096
---
You are a senior software engineer working autonomously on the codebase.

## Your Task
**{{issue.identifier}}: {{issue.title}}**

{% if issue.description %}
### Description
{{issue.description}}
{% endif %}

{% if attempt %}
**Retry attempt #{{attempt}}.** Check `git log --oneline -5` to see previous work.
{% endif %}
```

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export LINEAR_API_KEY="lin_api_..."
node dist/index.js
```

---

### Jira tracker

```yaml
---
tracker:
  kind: jira
  domain: mycompany.atlassian.net
  email: $JIRA_EMAIL
  api_key: $JIRA_API_TOKEN
  project_slug: PROJ             # your Jira project key
  active_states:
    - To Do
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Cancelled
    - Resolved

polling:
  interval_ms: 30000

workspace:
  root: ~/symphony_workspaces

hooks:
  after_create: |
    git clone https://github.com/my-org/my-repo.git .
    npm install
  before_run: |
    git checkout main && git pull
    BRANCH="symphony/$(echo '{{issue.identifier}}' | tr '[:upper:]' '[:lower:]')"
    git checkout -b "$BRANCH" 2>/dev/null || git checkout "$BRANCH"
  after_run: |
    git add -A
    git commit -m "{{issue.identifier}}: {{issue.title}}" --allow-empty || true
    BRANCH="symphony/$(echo '{{issue.identifier}}' | tr '[:upper:]' '[:lower:]')"
    git push -u origin "$BRANCH" --force-with-lease
    gh pr create \
      --title "{{issue.identifier}}: {{issue.title}}" \
      --body "JIRA: {{issue.url}}" \
      --head "$BRANCH" 2>/dev/null || true
  timeout_ms: 120000

agent:
  max_concurrent_agents: 5
  max_turns: 20

claude:
  model: claude-sonnet-4-6
  max_tokens: 8096
---
You are a senior software engineer working autonomously on the codebase.

## Your Task
**{{issue.identifier}}: {{issue.title}}**

{% if issue.description %}
### Description
{{issue.description}}
{% endif %}
```

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export JIRA_EMAIL="you@company.com"
export JIRA_API_TOKEN="your-token"
node dist/index.js
```

---

## Agent Tools

Each Claude session has access to five tools. All file paths are relative to the issue's workspace directory and are sandbox-checked to prevent path traversal.

### `bash`

Execute any shell command inside the workspace.

```
command   (string, required)  — The shell command to run
timeout_ms (number, optional) — Timeout in ms (default: 30 000)
```

Returns stdout. On failure returns a structured error with stdout, stderr, and the error message.

### `read_file`

Read a file from the workspace.

```
path       (string, required) — Relative file path
start_line (number, optional) — First line to read (1-indexed)
end_line   (number, optional) — Last line to read (inclusive)
```

### `write_file`

Create or overwrite a file. Parent directories are created automatically.

```
path    (string, required) — Relative file path
content (string, required) — Full file content
```

### `edit_file`

Replace an exact string in a file. Safer than rewriting the whole file for small edits.

```
path       (string, required) — Relative file path
old_string (string, required) — Exact text to find (must match exactly)
new_string (string, required) — Replacement text
```

Returns an error if `old_string` is not found, so Claude knows to retry with a corrected match.

### `list_directory`

List files and directories at a given path.

```
path (string, optional) — Relative directory path (default: ".")
```

Returns one entry per line, with trailing `/` for directories.

---

## CLI Reference

```
Usage: node dist/index.js [options]

Options:
  --workflow <path>   Path to WORKFLOW.md (default: ./WORKFLOW.md)
  --port <number>     Enable HTTP status server on this port
  --dry-run           Skip Claude API calls (test config and hooks only)
  --verbose           Enable debug-level logging
  --help              Show help
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ANTHROPIC_API_KEY … is required` | Missing env var | `export ANTHROPIC_API_KEY="sk-ant-..."` |
| `tracker.project_slug is required` | Blank slug in WORKFLOW.md | Set `project_slug` under `tracker:` |
| Issues fetched but never dispatched | All issues are blocked by incomplete blockers | Resolve blockers first |
| Agent loops without finishing | `max_turns` too low or task too complex | Increase `max_turns`; break issues into smaller tasks |
| Hook timed out | Slow `git clone` / `npm install` | Increase `hooks.timeout_ms` |
| `old_string not found in file` | Claude tried to edit a file but the text changed | Usually self-corrects on the next turn |
