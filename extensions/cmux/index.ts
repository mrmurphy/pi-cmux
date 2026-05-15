import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
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
let lastReportedPrKey: string | undefined;

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

type PullRequestCandidate = {
  url: string;
  repo?: string;
  number: string;
  timestamp: number;
};

const EXPLICIT_PR_URL = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\b/g;
const PR_NUMBER = /(?:\bPR\b|\bpull request\b)\s*#?(\d+)\b|#(\d+)\b/gi;

function cwdGitHubRepo(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;

  try {
    const remote = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const ssh = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (ssh) return `${ssh[1]}/${ssh[2]}`;
    const https = remote.match(/github\.com\/([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (https) return `${https[1]}/${https[2]}`;
  } catch {
    // Not a git repo, no origin, or git unavailable.
  }

  return undefined;
}

function candidatesFromText(text: string, timestamp: number, fallbackRepo?: string): PullRequestCandidate[] {
  const candidates: PullRequestCandidate[] = [];

  for (const match of text.matchAll(EXPLICIT_PR_URL)) {
    const [, owner, repo, number] = match;
    candidates.push({
      url: `https://github.com/${owner}/${repo}/pull/${number}`,
      repo: `${owner}/${repo}`,
      number,
      timestamp,
    });
  }

  if (fallbackRepo) {
    for (const match of text.matchAll(PR_NUMBER)) {
      const number = match[1] ?? match[2];
      if (!number) continue;
      candidates.push({
        url: `https://github.com/${fallbackRepo}/pull/${number}`,
        repo: fallbackRepo,
        number,
        timestamp,
      });
    }
  }

  return candidates;
}

function messageText(message: any): string {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return textFromContent(message.content);
}

function newestPrInSession(ctx: any): PullRequestCandidate | undefined {
  const fallbackRepo = cwdGitHubRepo(ctx.cwd ?? ctx.sessionManager?.getCwd?.());
  const candidates: PullRequestCandidate[] = [];

  for (const entry of ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? []) {
    if (entry?.type !== "message") continue;
    const timestamp = Date.parse(entry.timestamp ?? "") || entry.message?.timestamp || 0;
    candidates.push(...candidatesFromText(messageText(entry.message), timestamp, fallbackRepo));
  }

  candidates.sort((a, b) => a.timestamp - b.timestamp);
  return candidates[candidates.length - 1];
}

function currentPr(ctx: any, prompt?: string): PullRequestCandidate | undefined {
  const fallbackRepo = cwdGitHubRepo(ctx.cwd ?? ctx.sessionManager?.getCwd?.());
  const promptCandidates = prompt ? candidatesFromText(prompt, Date.now(), fallbackRepo) : [];
  return promptCandidates[promptCandidates.length - 1] ?? newestPrInSession(ctx);
}

function quoteCmuxSocketArg(value: string): string {
  if (/^[A-Za-z0-9_./:#?&=%+-]+$/.test(value)) return value;
  return `"${value.replace(/["\\$`]/g, "\\$&")}"`;
}

function sendCmuxSocketCommand(command: string): Promise<void> {
  const socketPath = process.env.CMUX_SOCKET_PATH;
  if (!socketPath || !existsSync(socketPath)) return Promise.resolve();

  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const finish = () => resolve();
    socket.setTimeout(1000, () => socket.destroy());
    socket.on("connect", () => socket.end(`${command}\n`));
    socket.on("data", () => {});
    socket.on("error", finish);
    socket.on("close", finish);
  });
}

async function maybeReportCurrentPrToCmux(ctx: any, prompt?: string): Promise<void> {
  const tabId = process.env.CMUX_TAB_ID ?? process.env.CMUX_WORKSPACE_ID;
  const panelId = process.env.CMUX_PANEL_ID ?? process.env.CMUX_SURFACE_ID;
  if (!tabId || !panelId) return;

  const pr = currentPr(ctx, prompt);
  if (!pr) return;

  const key = `${tabId}:${panelId}:${pr.url}`;
  if (key === lastReportedPrKey) return;
  lastReportedPrKey = key;

  await sendCmuxSocketCommand(
    [
      "report_pr",
      quoteCmuxSocketArg(pr.number),
      quoteCmuxSocketArg(pr.url),
      "--label=PR",
      "--state=open",
      `--tab=${quoteCmuxSocketArg(tabId)}`,
      `--panel=${quoteCmuxSocketArg(panelId)}`,
    ].join(" "),
  );
}

const FALLBACK_EMOJI = [
  "🧭",
  "🛠️",
  "✨",
  "🚀",
  "🌿",
  "🧪",
  "📌",
  "🔎",
  "💡",
  "🧵",
  "📦",
  "🎯",
  "📝",
  "🧰",
  "🌙",
  "☕️",
  "🦉",
  "🐝",
  "🌊",
  "🔥",
];

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
        return String(part.text ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function compactText(value: string, maxLength: number): string {
  const compacted = value.replace(/[;:]/g, "").replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) return compacted;
  return `${compacted.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function getSessionKey(ctx: any): string {
  return String(
    ctx.sessionManager?.getSessionId?.() ?? ctx.sessionManager?.getSessionFile?.() ?? ctx.sessionManager?.getCwd?.() ?? "pi",
  )
}

function getSessionShortId(ctx: any): string {
  const sessionId = String(ctx.sessionManager?.getSessionId?.() ?? "")
  if (sessionId) return sessionId.replace(/-/g, "").slice(0, 6)

  return hashString(getSessionKey(ctx)).toString(16).slice(0, 6)
}

function emojiForSession(ctx: any): string {
  const sessionKey = getSessionKey(ctx)
  return FALLBACK_EMOJI[hashString(sessionKey) % FALLBACK_EMOJI.length]
}

function firstWords(value: string, count: number): string {
  return compactText(value, 200).split(" ").filter(Boolean).slice(0, count).join(" ")
}

function getNewestAssistantText(ctx: any): string | undefined {
  const branch = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? []
  for (const entry of [...branch].reverse()) {
    const message = entry?.message
    if (message?.role !== "assistant") continue

    const text = compactText(textFromContent(message.content), 2000)
    if (text) return text
  }
  return undefined
}

type CmuxSurface = { ref?: string; selected?: boolean; title?: string }

function stripLeadingSessionEmoji(value: string): string {
  let cleaned = value.trim()
  let changed = true

  while (changed) {
    changed = false
    for (const emoji of FALLBACK_EMOJI) {
      if (cleaned.startsWith(emoji)) {
        cleaned = cleaned.slice(emoji.length).trim()
        changed = true
      }
    }
  }

  return cleaned
}

function cleanTerminalName(title: string | undefined): string | undefined {
  const cleaned = stripLeadingSessionEmoji(title ?? "")
    .replace(/^π\s*[-–—:]\s*/i, "")
    .replace(/^pi\s*[-–—:]\s*/i, "")
    .trim()
  return cleaned || undefined
}

async function getCurrentTerminalSurface(pi: ExtensionAPI): Promise<CmuxSurface | undefined> {
  if (!(await isCmuxAvailable(pi))) return undefined

  try {
    const result = await runCmux(pi, ["list-pane-surfaces", "--json"], 5_000)
    if (result.code !== 0 || !result.stdout?.trim()) return undefined

    const parsed = JSON.parse(result.stdout) as { surfaces?: CmuxSurface[] }
    const selected = parsed.surfaces?.find((surface) => surface.selected && surface.title?.trim())
    return selected ?? parsed.surfaces?.find((surface) => surface.title?.trim())
  } catch {
    return undefined
  }
}

async function getCurrentTerminalName(pi: ExtensionAPI): Promise<string | undefined> {
  const surface = await getCurrentTerminalSurface(pi)
  return cleanTerminalName(surface?.title)
}

async function maybePrefixTerminalName(pi: ExtensionAPI, ctx: any): Promise<void> {
  if (ctx.sessionManager?.getSessionName?.()?.trim()) return

  const surface = await getCurrentTerminalSurface(pi)
  if (!surface?.ref) return

  const baseName = cleanTerminalName(surface.title) || basename(ctx.sessionManager?.getCwd?.()) || "pi"
  const desiredTitle = `${emojiForSession(ctx)} ${baseName}`
  if (surface.title?.trim() === desiredTitle) return

  await runCmux(pi, ["rename-tab", "--surface", surface.ref, desiredTitle], 5_000)
}

function basename(path: string | undefined): string | undefined {
  const cleaned = path?.replace(/\/+$/, "")
  if (!cleaned) return undefined
  return cleaned.split("/").pop() || undefined
}

async function getNotificationContext(pi: ExtensionAPI, ctx: any): Promise<{ title: string; body: string; subtitle: string }> {
  const sessionName = ctx.sessionManager?.getSessionName?.()?.trim()
  const sessionEmoji = emojiForSession(ctx)
  const terminalName = sessionName ? undefined : await getCurrentTerminalName(pi)
  const cwdName = basename(ctx.sessionManager?.getCwd?.())
  const fallbackName = terminalName || cwdName || "pi"
  const title = compactText(sessionName || `${fallbackName} ${sessionEmoji}`, 80)
  const newestAssistantText = getNewestAssistantText(ctx)

  return {
    title,
    body: newestAssistantText ? compactText(newestAssistantText, 120) : "",
    subtitle: newestAssistantText ? firstWords(newestAssistantText, 4) : "Ready for you",
  }
}

export default function cmuxExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    await maybePrefixTerminalName(pi, ctx)
    await maybeReportCurrentPrToCmux(ctx)
  })

  pi.on("before_agent_start", async (event, ctx) => {
    await maybeReportCurrentPrToCmux(ctx, event.prompt)
  })

  pi.on("agent_start", async (_event, ctx) => {
    await maybePrefixTerminalName(pi, ctx)
    await maybeReportCurrentPrToCmux(ctx)
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

  pi.on("agent_end", async (_event, ctx) => {
    await maybeSetStatus(pi, undefined);
    await maybeReportCurrentPrToCmux(ctx)
    const notification = await getNotificationContext(pi, ctx);
    await maybeNotify(pi, notification.title, notification.body, notification.subtitle);
  });

  pi.on("turn_end", async (_event, ctx) => {
    await maybeReportCurrentPrToCmux(ctx)
  });

  pi.on("session_tree", async (_event, ctx) => {
    await maybeReportCurrentPrToCmux(ctx)
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
