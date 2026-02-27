import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateTail,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const CMUX_BIN = process.env.CMUX_CLI_PATH?.trim() || "cmux";
const STATUS_KEY = process.env.PI_CMUX_STATUS_KEY?.trim() || "pi";
const ENABLE_NOTIFICATIONS = parseBoolean(process.env.PI_CMUX_ENABLE_NOTIFICATIONS, true);
const ENABLE_STATUS = parseBoolean(process.env.PI_CMUX_ENABLE_STATUS, true);
const TOOL_NOTIFY_NAMES = parseCsv(process.env.PI_CMUX_NOTIFY_TOOL_NAMES ?? "task,subagent");

let availabilityCache: { ok: boolean; checkedAt: number } | undefined;

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function parseCsv(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
}

function renderCommand(args: string[]): string {
  return [CMUX_BIN, ...args]
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

function splitArgs(input: string): string[] {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escape = false;

  for (const ch of input) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        argv.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current) argv.push(current);
  return argv;
}

async function runCmux(pi: ExtensionAPI, args: string[], timeout = 20_000, signal?: AbortSignal) {
  return pi.exec(CMUX_BIN, args, { timeout, signal });
}

async function isCmuxAvailable(pi: ExtensionAPI): Promise<boolean> {
  const now = Date.now();
  if (availabilityCache && now - availabilityCache.checkedAt < 30_000) {
    return availabilityCache.ok;
  }

  try {
    const result = await runCmux(pi, ["ping"], 2_500);
    const ok = result.code === 0;
    availabilityCache = { ok, checkedAt: now };
    return ok;
  } catch {
    availabilityCache = { ok: false, checkedAt: now };
    return false;
  }
}

async function maybeNotify(pi: ExtensionAPI, title: string, body: string, subtitle?: string): Promise<void> {
  if (!ENABLE_NOTIFICATIONS) return;
  if (!(await isCmuxAvailable(pi))) return;

  const args = ["notify", "--title", title, "--body", body];
  if (subtitle) args.push("--subtitle", subtitle);
  await runCmux(pi, args, 5_000);
}

async function maybeSetStatus(pi: ExtensionAPI, value: string | undefined): Promise<void> {
  if (!ENABLE_STATUS) return;
  if (!(await isCmuxAvailable(pi))) return;

  if (value == null) {
    await runCmux(pi, ["clear-status", STATUS_KEY], 5_000);
    return;
  }

  await runCmux(pi, ["set-status", STATUS_KEY, value, "--icon", "sparkles", "--color", "#0A84FF"], 5_000);
}

async function maybeLog(pi: ExtensionAPI, message: string, level: "info" | "success" | "warning" | "error" = "info") {
  if (!(await isCmuxAvailable(pi))) return;
  await runCmux(pi, ["log", "--level", level, "--source", "pi", message], 5_000);
}

export default function cmuxExtension(pi: ExtensionAPI) {
  pi.on("agent_start", async () => {
    await maybeSetStatus(pi, "Working");
  });

  pi.on("tool_execution_start", async (event) => {
    await maybeLog(pi, `${event.toolName} started`, "info");
  });

  pi.on("tool_execution_end", async (event) => {
    if (event.isError) {
      await maybeLog(pi, `${event.toolName} failed`, "error");
    } else {
      await maybeLog(pi, `${event.toolName} done`, "success");
    }

    if (TOOL_NOTIFY_NAMES.has(event.toolName.toLowerCase()) && !event.isError) {
      await maybeNotify(pi, "Pi", "Agent finished task", event.toolName);
    }
  });

  pi.on("agent_end", async () => {
    await maybeSetStatus(pi, undefined);
    await maybeNotify(pi, "Pi", "Session complete");
  });

  pi.on("session_shutdown", async () => {
    await maybeSetStatus(pi, undefined);
  });

  pi.registerCommand("cmux", {
    description: "Run cmux CLI directly (example: /cmux list-workspaces --json)",
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim();
      if (!raw) {
        ctx.ui.notify("Usage: /cmux <args>", "info");
        return;
      }

      const argv = splitArgs(raw);
      if (argv.length === 0) {
        ctx.ui.notify("Usage: /cmux <args>", "info");
        return;
      }

      const result = await runCmux(pi, argv, 30_000);
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";

      let output = stdout;
      if (stderr.trim()) output += `${output ? "\n\n" : ""}[stderr]\n${stderr}`;
      if (!output.trim()) output = `Command exited with code ${result.code}.`;

      const truncation = truncateTail(output, {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      });

      let text = `$ ${renderCommand(argv)}\n\n${truncation.content}`;
      if (truncation.truncated) {
        text += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
          truncation.outputBytes,
        )} of ${formatSize(truncation.totalBytes)}).]`;
      }

      pi.sendMessage({
        customType: "cmux",
        content: text,
        display: true,
        details: {
          command: [CMUX_BIN, ...argv],
          code: result.code,
          killed: result.killed,
        },
      });

      if (result.code === 0) {
        ctx.ui.notify("cmux command completed", "info");
      } else {
        ctx.ui.notify(`cmux command failed (${result.code})`, "error");
      }
    },
  });

  pi.registerCommand("cmux-notify", {
    description: "Send a cmux notification (usage: /cmux-notify <title> | <body> | [subtitle])",
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim();
      const parts = raw.split("|").map((s) => s.trim());
      if (!parts[0] || !parts[1]) {
        ctx.ui.notify("Usage: /cmux-notify <title> | <body> | [subtitle]", "info");
        return;
      }

      const [title, body, subtitle] = parts;
      const cmd = ["notify", "--title", title, "--body", body];
      if (subtitle) cmd.push("--subtitle", subtitle);

      const result = await runCmux(pi, cmd, 10_000);
      if (result.code === 0) {
        ctx.ui.notify("cmux notification sent", "info");
      } else {
        ctx.ui.notify(`cmux notify failed (${result.code})`, "error");
      }
    },
  });

  pi.registerTool({
    name: "cmux_cli",
    label: "cmux CLI",
    description:
      "Run cmux CLI commands to control workspaces, panes, surfaces, notifications, sidebar metadata, and browser automation. Pass argv without the leading 'cmux'.",
    parameters: Type.Object({
      argv: Type.Array(
        Type.String({
          description:
            "Arguments passed to cmux (example: ['list-workspaces','--json'] or ['browser','surface:2','snapshot','--interactive']).",
        }),
        { minItems: 1 },
      ),
      timeoutMs: Type.Optional(
        Type.Number({
          description: "Command timeout in milliseconds (default 30000, max 120000).",
          minimum: 1,
          maximum: 120000,
        }),
      ),
      allowNonZeroExit: Type.Optional(
        Type.Boolean({
          description: "If true, non-zero exit code is returned as non-error.",
        }),
      ),
      includeStderr: Type.Optional(
        Type.Boolean({
          description: "Include stderr in the tool output text (default true).",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const argv = params.argv as string[];
      const includeStderr = params.includeStderr ?? true;
      const allowNonZeroExit = params.allowNonZeroExit ?? false;
      const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 30_000, 1), 120_000);

      const result = await runCmux(pi, argv, timeoutMs, signal);
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";

      let output = stdout;
      if (includeStderr && stderr.trim()) {
        output += `${output ? "\n\n" : ""}[stderr]\n${stderr}`;
      }
      if (!output.trim()) {
        output = `Command exited with code ${result.code}.`;
      }

      const truncation = truncateTail(output, {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      });

      let text = `$ ${renderCommand(argv)}\n\n${truncation.content}`;
      if (truncation.truncated) {
        text += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(
          truncation.outputBytes,
        )} of ${formatSize(truncation.totalBytes)}).]`;
      }

      return {
        content: [{ type: "text", text }],
        details: {
          command: [CMUX_BIN, ...argv],
          code: result.code,
          killed: result.killed,
          timeoutMs,
          truncated: truncation.truncated,
        },
        isError: result.code !== 0 && !allowNonZeroExit,
      };
    },
  });

  pi.registerTool({
    name: "cmux_notify",
    label: "cmux Notify",
    description: "Send a cmux notification (equivalent to `cmux notify --title ... --body ...`).",
    parameters: Type.Object({
      title: Type.String({ description: "Notification title." }),
      body: Type.String({ description: "Notification body." }),
      subtitle: Type.Optional(Type.String({ description: "Optional notification subtitle." })),
    }),

    async execute(_toolCallId, params, _signal) {
      const args = ["notify", "--title", params.title, "--body", params.body] as string[];
      if (params.subtitle) args.push("--subtitle", params.subtitle);

      const result = await runCmux(pi, args, 10_000);
      const ok = result.code === 0;

      return {
        content: [
          {
            type: "text",
            text: ok
              ? `Notification sent: ${params.title}`
              : `cmux notify failed with exit code ${result.code}.`,
          },
        ],
        details: {
          command: [CMUX_BIN, ...args],
          code: result.code,
          stderr: result.stderr,
        },
        isError: !ok,
      };
    },
  });
}
