/**
 * bg-notify - Background tasks that notify the agent when they finish.
 *
 * Long-running work (model downloads, cmake builds, training runs) is started
 * with the `bg` tool, which returns immediately. When the process exits, the
 * extension sends a user message ("task X finished, exit code N") so the agent
 * notices completion on its own, checks the log, and continues.
 *
 * Delivery is *steering*: if the agent is mid-run, the completion enters after
 * the current assistant turn finishes its tool calls, i.e. before the next LLM
 * call — not after the whole run settles. Set `PI_BG_NOTIFY_MODE=followUp` to
 * fall back to end-of-run delivery.
 *
 * Load:
 *   pi -e ./extensions/bg-notify.ts
 * or copy into ~/.pi/agent/extensions/ for auto-discovery.
 *
 * Distribution:
 *   Published as a pi package: https://github.com/Haxi52/pi-extensions
 *   Install on other machines: pi install git:github.com/Haxi52/pi-extensions
 *   Updates: pi update --extensions
 *
 * Tools:
 *   bg run  { command, name? }  - start command in background, returns task id
 *   bg list                     - list tasks and statuses
 *   bg log  { id, lines? }      - tail a task's log
 *   bg kill { id }              - kill a running task (no notification)
 *
 * Commands:
 *   /bg                         - human-facing task list
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type TaskStatus = "running" | "done" | "failed" | "killed";

interface Task {
	id: number;
	name: string;
	command: string;
	pid?: number;
	status: TaskStatus;
	logPath: string;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	signal?: string | null;
}

const tasks = new Map<number, Task>();
let nextId = 1;
let logDir: string | undefined;

// Latest context we've seen, so completion callbacks can notify/steer.
let lastCtx: ExtensionContext | undefined;
// pi reference, captured at startup (tool execute() has no pi in scope).
let piRef: ExtensionAPI | undefined;

function ensureLogDir(): string {
	if (!logDir || !fs.existsSync(logDir)) {
		logDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-"));
	}
	return logDir;
}

function elapsed(task: Task): string {
	const end = task.endedAt ?? Date.now();
	const secs = Math.round((end - task.startedAt) / 1000);
	if (secs < 60) return `${secs}s`;
	if (secs < 3600) return `${Math.floor(secs / 60)}m${secs % 60}s`;
	return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60)}m`;
}

function summarize(task: Task): string {
	const bits = [`#${task.id} "${task.name}"`, task.status];
	if (task.exitCode !== undefined && task.exitCode !== null) bits.push(`exit ${task.exitCode}`);
	if (task.signal) bits.push(`signal ${task.signal}`);
	bits.push(`took ${elapsed(task)}`);
	bits.push(`log: ${task.logPath}`);
	return bits.join(" | ");
}

// Persistent footer indicator: "● #1 download 12m30s  ● #2 build 3m1s"
function refreshStatus(): void {
	if (!lastCtx) return;
	const running = [...tasks.values()].filter((t) => t.status === "running");
	if (!running.length) {
		lastCtx.ui.setStatus("bg-status", undefined);
		if (statusTimer) {
			clearInterval(statusTimer);
			statusTimer = undefined;
		}
		return;
	}
	const theme = lastCtx.ui.theme;
	const parts = running.map(
		(t) => `${theme.fg("accent", "●")}${theme.fg("dim", ` #${t.id} ${t.name} ${elapsed(t)}`)}`,
	);
	lastCtx.ui.setStatus("bg-status", `bg: ${parts.join("  ")}`);
	if (!statusTimer) statusTimer = setInterval(refreshStatus, 5_000);
}
let statusTimer: ReturnType<typeof setInterval> | undefined;

function terminalNotify(text: string): void {
	// OSC 777 desktop notification (Ghostty, iTerm2, WezTerm); harmless elsewhere.
	try {
		const escaped = text.replace(/[\n\r]/g, " ").replace(/\\/g, "\\\\").replace(/;/g, "\\;");
		process.stdout.write(`\x1b]777;notify;pi background task;${escaped}\x07`);
	} catch {
		// ignore
	}
}

/** How a completion message reaches the model while it is already running. */
const deliveryMode: "steer" | "followUp" =
	process.env.PI_BG_NOTIFY_MODE === "followUp" ? "followUp" : "steer";

function notifyAgent(pi: ExtensionAPI, task: Task): void {
	const ok = task.status === "done";
	const text =
		`[bg] Background task finished: ${summarize(task)}. ` +
		(ok
			? "Read the tail of the log to confirm the result, then continue with the next step."
			: "Read the tail of the log to see why it failed.");
	try {
		// One call covers both states: when idle, prompt() starts a turn; when streaming,
		// prompt() routes the message through deliveryMode. A steer lands after the
		// in-flight assistant turn's tool calls, before the next LLM call, so the model
		// sees the completion immediately, not at end of run.
		pi.sendUserMessage(text, { deliverAs: deliveryMode });
	} catch {
		// Session may be shutting down; the ui.notify in onExit already fired.
	}
}

function onExit(pi: ExtensionAPI, task: Task, code: number | null, signal: string | null): void {
	if (task.status === "killed") return; // user asked for silence
	task.endedAt = Date.now();
	task.exitCode = code;
	task.signal = signal;
	task.status = code === 0 ? "done" : "failed";
	if (lastCtx) lastCtx.ui.notify(summarize(task), task.status === "done" ? "info" : "warning");
	refreshStatus();
	terminalNotify(summarize(task));
	notifyAgent(pi, task);
}

const BgParams = Type.Object({
	action: Type.String({ enum: ["run", "list", "log", "kill"], description: "run | list | log | kill" }),
	command: Type.Optional(Type.String({ description: "Shell command to run in background (action=run)" })),
	name: Type.Optional(Type.String({ description: "Short label for the task (action=run)" })),
	id: Type.Optional(Type.Number({ description: "Task id (action=log/kill)" })),
	lines: Type.Optional(Type.Number({ description: "Log lines to return (action=log, default 100)" })),
});

const bgTool = defineTool({
	name: "bg",
	label: "Background task",
	description:
		"Start long-running tasks in the background; the completion is steered into the conversation " +
		"when the process exits. Prefer bg over bash, sleep, or polling for anything over ~30 seconds " +
		"(builds, downloads, test suites, CI jobs, training, deploys). " +
		"action=run returns a task id at once — launch it and keep working; the completion arrives after " +
		"your current tool calls, so do not end your turn, poll, or check up on it.",
	parameters: BgParams,

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		lastCtx = ctx;
		const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], details: { error: msg } });

		switch (params.action) {
			case "run": {
				if (!params.command?.trim()) return fail("run requires a command");
				const dir = ensureLogDir();
				const id = nextId++;
				const name = params.name?.trim() || params.command.slice(0, 40);
				const logPath = path.join(dir, `bg-${id}.log`);
				const out = fs.createWriteStream(logPath);
				const child = spawn(params.command, { shell: true, cwd: ctx.cwd, detached: true });
				const task: Task = {
					id,
					name,
					command: params.command,
					pid: child.pid,
					status: "running",
					logPath,
					startedAt: Date.now(),
				};
				tasks.set(id, task);
				child.stdout?.pipe(out);
				child.stderr?.pipe(out);
				refreshStatus();
				child.on("exit", (code, signal) => {
					if (piRef) onExit(piRef, task, code, signal);
				});
				child.on("error", (err) => {
					task.status = "failed";
					task.endedAt = Date.now();
					out.write(`\n[spawn error] ${err.message}\n`);
					out.end();
					refreshStatus();
					ctx.ui.notify(`bg #${id} spawn failed: ${err.message}`, "error");
				});
				out.write(`$ ${params.command}\n(cwd ${ctx.cwd})\n\n`);
				return {
					content: [
						{
							type: "text" as const,
							text:
								`Started bg #${id} "${name}" (pid ${child.pid}). Log: ${logPath}\n` +
								`It is steered into the conversation when it exits. Keep working on other steps; do not poll, sleep, or end your turn waiting for it.`,
						},
					],
					details: { task },
				};
			}

			case "list": {
				const all = [...tasks.values()];
				const text = all.length
					? all.map(summarize).join("\n")
					: "No background tasks this session.";
				return { content: [{ type: "text" as const, text }], details: { tasks: all } };
			}

			case "log": {
				const task = params.id !== undefined ? tasks.get(params.id) : undefined;
				if (!task) return fail(`log requires a valid id (see bg list)`);
				const lines = params.lines ?? 100;
				const raw = fs.readFileSync(task.logPath, "utf8").split("\n");
				const tail = raw.slice(-lines).join("\n");
				return {
					content: [{ type: "text" as const, text: `[${task.status}] ${task.logPath}\n${tail}` }],
					details: { task },
				};
			}

			case "kill": {
				const task = params.id !== undefined ? tasks.get(params.id) : undefined;
				if (!task) return fail(`kill requires a valid id (see bg list)`);
				if (task.status !== "running") return fail(`bg #${task.id} is already ${task.status}`);
				task.status = "killed";
				task.endedAt = Date.now();
				refreshStatus();
				try {
					if (task.pid) process.kill(-task.pid, "SIGTERM");
				} catch {
					try {
						if (task.pid) process.kill(task.pid, "SIGTERM");
					} catch {
						/* already gone */
					}
				}
				return {
					content: [{ type: "text" as const, text: `Killed bg #${task.id} "${task.name}" (no notification sent).` }],
					details: { task },
				};
			}

			default:
				return fail(`unknown action: ${params.action}`);
		}
	},
});

export default function (pi: ExtensionAPI) {
	piRef = pi;
	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
	});

	pi.registerTool(bgTool);

	pi.registerCommand("bg", {
		description: "List background tasks started with the bg tool",
		handler: async (_args, ctx) => {
			lastCtx = ctx;
			const all = [...tasks.values()];
			if (!all.length) {
				ctx.ui.notify("No background tasks this session.", "info");
				return;
			}
			ctx.ui.notify(all.map(summarize).join("\n"), "info");
		},
	});

	// Warn about still-running tasks when the session ends.
	pi.on("session_shutdown", async (_event, ctx) => {
		if (statusTimer) clearInterval(statusTimer);
		const running = [...tasks.values()].filter((t) => t.status === "running");
		if (running.length) {
			ctx.ui.notify(`${running.length} background task(s) still running: ${running.map((t) => `#${t.id} ${t.name}`).join(", ")}`, "warning");
		}
	});
}
