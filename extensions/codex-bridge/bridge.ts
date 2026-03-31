import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
	getMarkdownTheme,
	type ExecOptions,
	type ExecResult,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";

export type CommandExecutor = (
	command: string,
	args: string[],
	options?: ExecOptions,
) => Promise<ExecResult>;

export interface SetupSummary {
	ok: boolean;
	content: string;
}

export interface ReviewArgs {
	target: "uncommitted" | "base";
	base: string | null;
	prompt: string;
}

export interface ReviewSummary {
	ok: boolean;
	content: string;
}

export interface TaskSummary {
	ok: boolean;
	content: string;
}

type PromptContextEntry =
	| {
			type: "message";
			message: {
				role?: string;
				content?: Array<{ type?: string; text?: string }>;
			};
	  }
	| {
			type: "custom_message";
			customType?: string;
			content?: string | Array<{ type?: string; text?: string }>;
	  };

const CODEX_TIMEOUT_MS = 15 * 60 * 1000;
const NOISY_PATH_WARNING = "WARNING: proceeding, even though we could not update PATH:";

function cleanCodexText(text: string): string {
	return text
		.split(/\r?\n/)
		.filter((line) => !line.startsWith(NOISY_PATH_WARNING))
		.join("\n")
		.trim();
}

function summarizeFailure(result: ExecResult): string {
	const stderr = cleanCodexText(result.stderr);
	const stdout = cleanCodexText(result.stdout);
	if (stderr) return stderr;
	if (stdout) return stdout;
	if (result.killed) return "The process was terminated before it completed.";
	return `Command exited with code ${result.code}.`;
}

function tokenize(input: string): string[] {
	return input.trim() ? input.trim().split(/\s+/) : [];
}

function containsKorean(text: string): boolean {
	return /[\u3131-\u318e\uac00-\ud7a3]/i.test(text);
}

function withLanguageInstruction(prompt: string, userInstruction: string): string {
	if (containsKorean(userInstruction)) {
		return `${prompt}\n\nIMPORTANT: Answer in Korean.`;
	}

	return `${prompt}\n\nIMPORTANT: Answer in English.`;
}

function withMarkdownAnswerInstruction(prompt: string): string {
	return `${prompt}

IMPORTANT: Return only the final answer in clean Markdown.
- Do not return JSON.
- Do not wrap the entire answer in a code fence.
- Do not add a generic leading heading like "Conclusion".
- Start directly with the answer content.
- Use bullet points only when helpful.
- If you list findings, order them by severity.`;
}

function createOutputCapturePath(): { dir: string; file: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codex-bridge-"));
	return { dir, file: path.join(dir, "last-message.txt") };
}

function cleanupOutputCapturePath(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function readCapturedLastMessage(filePath: string): string {
	if (!fs.existsSync(filePath)) {
		return "";
	}

	return fs.readFileSync(filePath, "utf8").trim();
}

function summarizeFailureShort(result: ExecResult): string {
	const summary = summarizeFailure(result);
	const lines = summary.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	return lines.slice(0, 8).join("\n");
}

function preferredOutput(result: ExecResult): string {
	const stdout = cleanCodexText(result.stdout);
	const stderr = cleanCodexText(result.stderr);
	return stdout || stderr;
}

function extractStreamDelta(event: unknown): string | null {
	if (!event || typeof event !== "object") return null;
	const record = event as Record<string, unknown>;
	const type = typeof record.type === "string" ? record.type : "";

	if (type === "response.output_text.delta" && typeof record.delta === "string") {
		return record.delta;
	}

	if (type === "response.output_text.done" && typeof record.text === "string") {
		return record.text;
	}

	if ((type === "message.delta" || type === "agent_message_delta") && typeof record.delta === "string") {
		return record.delta;
	}

	return null;
}

function processJsonStreamChunk(
	buffer: string,
	onDelta: (delta: string) => void,
): string {
	let remaining = buffer;

	for (;;) {
		const newlineIndex = remaining.indexOf("\n");
		if (newlineIndex === -1) {
			return remaining;
		}

		const line = remaining.slice(0, newlineIndex).trim();
		remaining = remaining.slice(newlineIndex + 1);

		if (!line.startsWith("{")) {
			continue;
		}

		try {
			const parsed = JSON.parse(line);
			const delta = extractStreamDelta(parsed);
			if (delta) {
				onDelta(delta);
			}
		} catch {
			// Ignore malformed lines from mixed CLI output.
		}
	}
}

async function runCodexCommandStreaming(
	args: string[],
	cwd: string,
	onDelta?: (delta: string) => void,
): Promise<ExecResult> {
	return await new Promise((resolve) => {
		const proc = spawn("codex", args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let stdoutBuffer = "";

		const timeoutId = setTimeout(() => {
			if (!killed) {
				killed = true;
				proc.kill("SIGTERM");
			}
		}, CODEX_TIMEOUT_MS);

		proc.stdout?.on("data", (chunk) => {
			const text = chunk.toString();
			stdout += text;
			if (onDelta) {
				stdoutBuffer += text;
				stdoutBuffer = processJsonStreamChunk(stdoutBuffer, onDelta);
			}
		});

		proc.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});

		proc.on("close", (code) => {
			clearTimeout(timeoutId);
			resolve({ stdout, stderr, code: code ?? 0, killed });
		});

		proc.on("error", () => {
			clearTimeout(timeoutId);
			resolve({ stdout, stderr, code: 1, killed });
		});
	});
}

function startSpinner(
	ui: {
		setStatus(key: string, text: string | undefined): void;
		setWorkingMessage(message?: string): void;
		setWidget(
			key: string,
			content:
				| string[]
				| undefined
				| ((tui: unknown, theme: any) => { dispose?(): void }),
			options?: { placement?: "aboveEditor" | "belowEditor" },
		): void;
	},
	label: string,
	previewLines?: string[],
	streamState?: { answer: string },
): () => void {
	const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	let index = 0;
	const render = () => `${frames[index]} Waiting for Codex...`;
	const renderWidgetText = () => {
		const lines: string[] = [...(previewLines ?? [])];
		if (streamState?.answer.trim()) {
			lines.push("");
			lines.push(streamState.answer.trim());
		}
		if (lines.length > 0) lines.push("");
		lines.push(render());
		return lines.join("\n");
	};
	const splitSections = () => {
		const text = renderWidgetText();
		const questionMatch = text.match(/QUESTION\s*([\s\S]*?)\nANSWER\s*([\s\S]*)/);
		if (!questionMatch) {
			return { question: "", answer: text.trim() };
		}
		return {
			question: questionMatch[1]?.trim() ?? "",
			answer: questionMatch[2]?.trim() ?? "",
		};
	};
	const renderWidget = () => (_tui: unknown, theme: any) => {
		const box = new Box(1, 1, (text) => `\x1b[40m${text}\x1b[49m`);
		const mdTheme = getMarkdownTheme();
		const { question, answer } = splitSections();
		const container = new Container(0, 0);
		container.addChild(new Text(theme.fg("customMessageLabel", "\x1b[1mCODEX ANSWER\x1b[22m"), 0, 0));
		container.addChild(new Spacer(0, 1));
		if (question) {
			container.addChild(new Text(theme.fg("warning", "\x1b[1mQUESTION\x1b[22m"), 0, 1));
			container.addChild(new Spacer(0, 0));
			container.addChild(new Markdown(question, 0, 1, mdTheme));
			container.addChild(new Spacer(0, 1));
		}
		container.addChild(new Text(theme.fg("warning", "\x1b[1mANSWER\x1b[22m"), 0, 1));
		container.addChild(new Spacer(0, 0));
		container.addChild(new Markdown(answer, 0, 1, mdTheme));
		box.addChild(container);
		return box;
	};

	ui.setWorkingMessage(label);
	ui.setWidget("codex-bridge-progress", renderWidget());

	const timer = setInterval(() => {
		index = (index + 1) % frames.length;
		ui.setWidget("codex-bridge-progress", renderWidget());
	}, 120);

	return () => {
		clearInterval(timer);
		ui.setWidget("codex-bridge-progress", undefined);
		ui.setWorkingMessage();
	};
}

function buildCombinedContent(commandLabel: string, instruction: string, answer: string): string {
	return [
		"## QUESTION",
		"",
		commandLabel,
		"",
		instruction.trim() || "_No additional instruction provided._",
		"",
		"---",
		"",
		"## ANSWER",
		"",
		answer.trim(),
	].join("\n");
}

function buildPreviewLines(commandLabel: string, instruction: string): string[] {
	return [
		"QUESTION",
		"",
		commandLabel,
		"",
		instruction.trim() || "_No additional instruction provided._",
		"",
		"ANSWER",
	];
}

function primeCommandInput(
	ui: { setEditorText(text: string): void; notify(message: string, type?: "info" | "warning" | "error"): void },
	commandLabel: string,
): void {
	ui.setEditorText(`${commandLabel} `);
	ui.notify("Add your instruction, then press Enter.", "info");
}

function extractTextFromParts(content: unknown): string {
	if (typeof content === "string") {
		return content.trim();
	}

	if (!Array.isArray(content)) {
		return "";
	}

	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			if ("type" in part && part.type === "text" && "text" in part && typeof part.text === "string") {
				return part.text;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

export function parseReviewArgs(input: string): ReviewArgs {
	const tokens = tokenize(input);
	let target: ReviewArgs["target"] = "uncommitted";
	let base: string | null = null;
	const promptTokens: string[] = [];

	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === "--base") {
			const next = tokens[i + 1];
			if (!next) {
				throw new Error("`--base` requires a branch name.");
			}
			target = "base";
			base = next;
			i += 1;
			continue;
		}
		promptTokens.push(token);
	}

	return {
		target,
		base,
		prompt: promptTokens.join(" ").trim(),
	};
}

export function buildTaskPrompt(entries: PromptContextEntry[], task: string, maxItems: number = 8): string {
	const recent: string[] = [];

	for (let i = entries.length - 1; i >= 0 && recent.length < maxItems; i -= 1) {
		const entry = entries[i];
		if (entry.type === "message") {
			const text = extractTextFromParts(entry.message.content);
			if (!text) continue;
			recent.push(`${(entry.message.role ?? "unknown").toUpperCase()}: ${text}`);
			continue;
		}

		const text = extractTextFromParts(entry.content);
		if (!text) continue;
		recent.push(`${(entry.customType ?? "custom").toUpperCase()}: ${text}`);
	}

	recent.reverse();

	const sections = ["You are being called from inside an active pi TUI development session."];
	if (recent.length > 0) {
		sections.push("## Recent pi conversation context", recent.join("\n\n"));
	}
	sections.push("## Requested Codex task", task.trim());
	return sections.join("\n\n").trim();
}

export async function buildSetupSummary(exec: CommandExecutor, cwd: string): Promise<SetupSummary> {
	const [version, login] = await Promise.all([
		exec("codex", ["--version"], { cwd, timeout: 30_000 }),
		exec("codex", ["login", "status"], { cwd, timeout: 30_000 }),
	]);

	const versionText = version.code === 0 ? preferredOutput(version) : summarizeFailure(version);
	const loginStatusText = login.code === 0 ? preferredOutput(login) : summarizeFailure(login);
	const loginDetected = /logged in/i.test(loginStatusText);
	const ok = version.code === 0 && login.code === 0 && loginDetected;

	return {
		ok,
		content: [
			"## Codex Setup",
			`- CLI: ${versionText || "Unavailable"}`,
			`- Login: ${loginStatusText || "Unavailable"}`,
			`- Working directory: ${cwd}`,
			"",
			"Codex credentials are not read from the project root.",
			"They come from your user-level Codex CLI state.",
			!loginDetected ? "" : undefined,
			!loginDetected ? "If login is missing, run `codex login` in a regular terminal and then retry `/codex:setup`." : undefined,
		].filter(Boolean).join("\n"),
	};
}

export async function buildReviewSummary(
	exec: CommandExecutor,
	cwd: string,
	request: ReviewArgs,
	onDelta?: (delta: string) => void,
): Promise<ReviewSummary> {
	const capture = createOutputCapturePath();
	const args = ["exec", "review", "--full-auto", "--output-last-message", capture.file];
	args.push("--json");
	if (request.target === "base" && request.base) {
		args.push("--base", request.base);
	} else {
		args.push("--uncommitted");
	}
	if (request.prompt) {
		args.push(request.prompt);
	}

	try {
		const result =
			onDelta
				? await runCodexCommandStreaming(args, cwd, onDelta)
				: await exec("codex", args, { cwd, timeout: CODEX_TIMEOUT_MS });

		const lastMessage = readCapturedLastMessage(capture.file);
		const ok = result.code === 0 && !result.killed;

		if (!ok) {
			return {
				ok: false,
				content: ["Codex review failed.", "", summarizeFailureShort(result)].join("\n"),
			};
		}

		return {
			ok: true,
			content: lastMessage || "_Codex returned no final review text._",
		};
	} finally {
		cleanupOutputCapturePath(capture.dir);
	}
}

export async function buildTaskSummary(
	exec: CommandExecutor,
	cwd: string,
	prompt: string,
	options?: { resumeLast?: boolean },
	onDelta?: (delta: string) => void,
): Promise<TaskSummary> {
	const capture = createOutputCapturePath();
	const args = options?.resumeLast
		? ["exec", "resume", "--last", "--full-auto", "--output-last-message", capture.file, "--json", prompt]
		: ["exec", "--full-auto", "--output-last-message", capture.file, "--json", prompt];

	try {
		const result =
			onDelta
				? await runCodexCommandStreaming(args, cwd, onDelta)
				: await exec("codex", args, { cwd, timeout: CODEX_TIMEOUT_MS });

		const lastMessage = readCapturedLastMessage(capture.file);
		const ok = result.code === 0 && !result.killed;

		if (!ok) {
			return {
				ok: false,
				content: ["Codex request failed.", "", summarizeFailureShort(result)].join("\n"),
			};
		}

		return {
			ok: true,
			content: lastMessage || "_Codex returned no final text._",
		};
	} finally {
		cleanupOutputCapturePath(capture.dir);
	}
}

function sendCodexMessage(
	pi: Pick<ExtensionAPI, "sendMessage">,
	kind: "setup" | "review",
	ok: boolean,
	content: string,
) {
	pi.sendMessage({
		customType: "codex-bridge",
		content,
		display: true,
		details: { kind, ok },
	});
}

export function registerCodexBridge(
	pi: Pick<ExtensionAPI, "registerCommand" | "sendMessage" | "exec">,
): void {
	pi.registerCommand("codex:setup", {
		description: "Check the local Codex CLI version and login status",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Checking local Codex CLI...", "info");
			const stopSpinner = startSpinner(ctx.ui, "Working Codex setup...");
			const summary = await buildSetupSummary(
				(command, args, options) => pi.exec(command, args, options),
				ctx.cwd,
			).finally(stopSpinner);
			sendCodexMessage(pi, "setup", summary.ok, summary.content);
			ctx.ui.notify(summary.ok ? "Codex is ready" : "Codex setup needs attention", summary.ok ? "info" : "warning");
		},
	});

	pi.registerCommand("codex:review", {
		description: "Ask Codex to review based on recent pi conversation context",
		handler: async (args, ctx) => {
			const request = args.trim() || "Review the current situation using the recent pi conversation context and give the most useful next-step feedback.";
			if (!args.trim()) {
				primeCommandInput(ctx.ui, "/codex:review");
				return;
			}
			const streamState = { answer: "" };
			const prompt = withMarkdownAnswerInstruction(
				withLanguageInstruction(
				buildTaskPrompt(
					ctx.sessionManager.getBranch() as PromptContextEntry[],
					`Review the work based on the recent pi conversation context. Focus on bugs, risks, incorrect assumptions, and the most important next step.\n\nAdditional user guidance: ${request}`,
				),
				request,
				),
			);

			ctx.ui.notify("Running Codex context review...", "info");
			const stopSpinner = startSpinner(
				ctx.ui,
				"Working Codex review...",
				buildPreviewLines("/codex:review", request),
				streamState,
			);
			const summary = await buildTaskSummary(
				(command, argv, options) => pi.exec(command, argv, options),
				ctx.cwd,
				prompt,
				{ resumeLast: true },
				(delta) => {
					streamState.answer += delta;
				},
			).finally(stopSpinner);
			sendCodexMessage(pi, "review", summary.ok, buildCombinedContent("/codex:review", request, summary.content));
			ctx.ui.notify(summary.ok ? "Codex context review complete" : "Codex context review failed", summary.ok ? "info" : "error");
		},
	});

	pi.registerCommand("codex:diff-review", {
		description: "Run a Codex review for uncommitted changes or against a base branch",
		handler: async (args, ctx) => {
			let request: ReviewArgs;
			try {
				request = parseReviewArgs(args);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			const streamState = { answer: "" };
			ctx.ui.notify("Running Codex review...", "info");
			const stopSpinner = startSpinner(ctx.ui, "Working Codex diff review...", buildPreviewLines(
				"/codex:diff-review",
				args.trim() || (request.base ? `Review diff against base ${request.base}` : "Review uncommitted changes"),
			), streamState);
			const summary = await buildReviewSummary(
				(command, argv, options) => pi.exec(command, argv, options),
				ctx.cwd,
				request,
				(delta) => {
					streamState.answer += delta;
				},
			).finally(stopSpinner);
			sendCodexMessage(
				pi,
				"review",
				summary.ok,
				buildCombinedContent(
					"/codex:diff-review",
					args.trim() || (request.base ? `Review diff against base ${request.base}` : "Review uncommitted changes"),
					summary.content,
				),
			);
			ctx.ui.notify(summary.ok ? "Codex review complete" : "Codex review failed", summary.ok ? "info" : "error");
		},
	});

	pi.registerCommand("codex:task", {
		description: "Delegate a coding task to Codex using recent pi conversation context",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				primeCommandInput(ctx.ui, "/codex:task");
				return;
			}

			const streamState = { answer: "" };
			const prompt = withMarkdownAnswerInstruction(
				withLanguageInstruction(
				buildTaskPrompt(ctx.sessionManager.getBranch() as PromptContextEntry[], task),
				task,
				),
			);
			ctx.ui.notify("Running Codex task...", "info");
			const stopSpinner = startSpinner(ctx.ui, "Working Codex task...", buildPreviewLines("/codex:task", task), streamState);
			const summary = await buildTaskSummary(
				(command, argv, options) => pi.exec(command, argv, options),
				ctx.cwd,
				prompt,
				undefined,
				(delta) => {
					streamState.answer += delta;
				},
			).finally(stopSpinner);
			sendCodexMessage(pi, "review", summary.ok, buildCombinedContent("/codex:task", task, summary.content));
			ctx.ui.notify(summary.ok ? "Codex task complete" : "Codex task failed", summary.ok ? "info" : "error");
		},
	});

	pi.registerCommand("codex:resume", {
		description: "Resume the most recent Codex task with current pi conversation context",
		handler: async (args, ctx) => {
			const followUp =
				args.trim() || "Continue from the latest Codex task using the current repository state and latest pi context.";
			const streamState = { answer: "" };
			const prompt = withMarkdownAnswerInstruction(
				withLanguageInstruction(
				buildTaskPrompt(ctx.sessionManager.getBranch() as PromptContextEntry[], followUp),
				followUp,
				),
			);
			ctx.ui.notify("Resuming the latest Codex task...", "info");
			const stopSpinner = startSpinner(
				ctx.ui,
				"Working Codex resume...",
				buildPreviewLines("/codex:resume", followUp),
				streamState,
			);
			const summary = await buildTaskSummary(
				(command, argv, options) => pi.exec(command, argv, options),
				ctx.cwd,
				prompt,
				{ resumeLast: true },
				(delta) => {
					streamState.answer += delta;
				},
			).finally(stopSpinner);
			sendCodexMessage(pi, "review", summary.ok, buildCombinedContent("/codex:resume", followUp, summary.content));
			ctx.ui.notify(summary.ok ? "Codex resume complete" : "Codex resume failed", summary.ok ? "info" : "error");
		},
	});
}
