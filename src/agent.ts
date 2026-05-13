import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, normalize, relative, join } from "node:path";
import { mkdirSync } from "node:fs";
import type { ServiceConfig, AgentResult, LiveSession } from "./types.js";
import { log } from "./logger.js";

const SYSTEM_PROMPT = `You are an autonomous coding agent. You have access to tools to interact with the filesystem and run commands. Complete the task described in the user message.

Guidelines:
- Read existing code before making changes to understand the codebase.
- Write clean, working code.
- Test your changes by running the code or tests when possible.
- If you encounter errors, debug and fix them.
- When you are done, state clearly what you accomplished.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description:
      "Execute a shell command in the workspace directory. Returns stdout and stderr. Use for running code, tests, git commands, installing packages, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        timeout_ms: {
          type: "number",
          description: "Command timeout in milliseconds (default: 30000)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description:
      "Read the contents of a file. Path is relative to the workspace directory.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "File path relative to workspace",
        },
        start_line: {
          type: "number",
          description: "Start reading from this line (1-indexed, optional)",
        },
        end_line: {
          type: "number",
          description: "Stop reading at this line (inclusive, optional)",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a file with the given content. Path is relative to the workspace directory. Creates parent directories if needed.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "File path relative to workspace",
        },
        content: {
          type: "string",
          description: "Full file content to write",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Edit a file by replacing an exact string match with new content. Path is relative to the workspace directory.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "File path relative to workspace",
        },
        old_string: {
          type: "string",
          description: "The exact string to find and replace",
        },
        new_string: {
          type: "string",
          description: "The replacement string",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "list_directory",
    description:
      "List files and directories at the given path. Path is relative to the workspace directory.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to workspace (default: '.')",
        },
      },
      required: [],
    },
  },
];

function resolveSafePath(workspacePath: string, filePath: string): string {
  const resolved = resolve(workspacePath, filePath);
  const normalized = normalize(resolved);
  const wsNorm = normalize(resolve(workspacePath));
  if (!normalized.startsWith(wsNorm)) {
    throw new Error(`Path traversal rejected: ${filePath} resolves outside workspace`);
  }
  return normalized;
}

function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  workspacePath: string,
): string {
  try {
    switch (toolName) {
      case "bash": {
        const command = input.command as string;
        const timeout = (input.timeout_ms as number) ?? 30000;
        try {
          const result = execSync(command, {
            cwd: workspacePath,
            shell: "/bin/bash",
            timeout,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env },
          });
          return result.toString("utf-8");
        } catch (e: unknown) {
          const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
          const stdout = err.stdout?.toString("utf-8") ?? "";
          const stderr = err.stderr?.toString("utf-8") ?? "";
          return `COMMAND FAILED\nstdout:\n${stdout}\nstderr:\n${stderr}\nerror: ${err.message ?? "unknown"}`;
        }
      }

      case "read_file": {
        const safePath = resolveSafePath(workspacePath, input.path as string);
        const content = readFileSync(safePath, "utf-8");
        const startLine = input.start_line as number | undefined;
        const endLine = input.end_line as number | undefined;
        if (startLine || endLine) {
          const lines = content.split("\n");
          const start = (startLine ?? 1) - 1;
          const end = endLine ?? lines.length;
          return lines.slice(start, end).join("\n");
        }
        return content;
      }

      case "write_file": {
        const safePath = resolveSafePath(workspacePath, input.path as string);
        const dir = resolve(safePath, "..");
        mkdirSync(dir, { recursive: true });
        writeFileSync(safePath, input.content as string, "utf-8");
        return `File written: ${input.path}`;
      }

      case "edit_file": {
        const safePath = resolveSafePath(workspacePath, input.path as string);
        const oldContent = readFileSync(safePath, "utf-8");
        const oldStr = input.old_string as string;
        const newStr = input.new_string as string;
        if (!oldContent.includes(oldStr)) {
          return `ERROR: old_string not found in file. Make sure it matches exactly.`;
        }
        const newContent = oldContent.replace(oldStr, newStr);
        writeFileSync(safePath, newContent, "utf-8");
        return `File edited: ${input.path}`;
      }

      case "list_directory": {
        const dirPath = (input.path as string) ?? ".";
        const safePath = resolveSafePath(workspacePath, dirPath);
        const entries = readdirSync(safePath);
        const result: string[] = [];
        for (const entry of entries) {
          const fullPath = join(safePath, entry);
          try {
            const stat = statSync(fullPath);
            const rel = relative(workspacePath, fullPath);
            result.push(stat.isDirectory() ? `${rel}/` : rel);
          } catch {
            result.push(entry);
          }
        }
        return result.join("\n") || "(empty directory)";
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (e) {
    return `Tool error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export async function runAgent(
  prompt: string,
  workspacePath: string,
  config: ServiceConfig,
  session: LiveSession,
  dryRun: boolean = false,
): Promise<AgentResult> {
  if (dryRun) {
    log.info({
      event: "agent_dry_run",
      issue_identifier: session.issue_identifier,
      prompt_length: prompt.length,
      workspace: workspacePath,
    });
    return {
      turns: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      elapsed_ms: 0,
    };
  }

  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: prompt },
  ];

  const startTime = Date.now();
  let totalInput = 0;
  let totalOutput = 0;

  for (let turn = 0; turn < config.agent.max_turns; turn++) {
    if (session.abort_controller.signal.aborted) {
      log.info({
        event: "agent_aborted",
        issue_identifier: session.issue_identifier,
        turn: turn,
      });
      break;
    }

    log.info({
      event: "agent_turn_start",
      issue_identifier: session.issue_identifier,
      turn: turn + 1,
    });

    const response = await client.messages.create({
      model: config.claude.model,
      max_tokens: config.claude.max_tokens,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });

    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;

    session.turn_count = turn + 1;
    session.input_tokens = totalInput;
    session.output_tokens = totalOutput;
    session.total_tokens = totalInput + totalOutput;
    session.last_activity = Date.now();

    if (
      response.stop_reason === "end_turn" ||
      !response.content.some((b) => b.type === "tool_use")
    ) {
      const textBlocks = response.content.filter((b) => b.type === "text");
      const summary = textBlocks
        .map((b) => (b as Anthropic.TextBlock).text)
        .join("\n")
        .slice(0, 200);
      log.info({
        event: "agent_completed",
        issue_identifier: session.issue_identifier,
        turns: turn + 1,
        input_tokens: totalInput,
        output_tokens: totalOutput,
        summary,
      });
      break;
    }

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      log.info({
        event: "tool_call",
        issue_identifier: session.issue_identifier,
        turn: turn + 1,
        tool: block.name,
        input_preview:
          block.name === "bash"
            ? (block.input as Record<string, unknown>).command
            : (block.input as Record<string, unknown>).path ?? "",
      });

      const result = executeTool(
        block.name,
        block.input as Record<string, unknown>,
        workspacePath,
      );

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.slice(0, 50000),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  const elapsed = Date.now() - startTime;

  return {
    turns: session.turn_count,
    input_tokens: totalInput,
    output_tokens: totalOutput,
    total_tokens: totalInput + totalOutput,
    elapsed_ms: elapsed,
  };
}
