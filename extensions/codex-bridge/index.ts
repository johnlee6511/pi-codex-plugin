import { getMarkdownTheme, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { registerCodexBridge } from "./bridge.js";

export default function codexBridgeExtension(pi: ExtensionAPI) {
	const splitSections = (content: string) => {
		const questionMatch = content.match(/## QUESTION\s*([\s\S]*?)\n---\n\s*## ANSWER\s*([\s\S]*)/);
		if (!questionMatch) {
			return { question: "", answer: content.trim() };
		}
		return {
			question: questionMatch[1]?.trim() ?? "",
			answer: questionMatch[2]?.trim() ?? "",
		};
	};

	const renderBox = (label: string, labelColor: "customMessageLabel" | "warning", content: string, theme: any) => {
		const box = new Box(1, 1, (text) => `\x1b[40m${text}\x1b[49m`);
		const mdTheme = getMarkdownTheme();
		const { question, answer } = splitSections(content);
		const container = new Container(0, 0);
		container.addChild(new Text(theme.fg(labelColor, `\x1b[1m${label}\x1b[22m`), 0, 0));
		container.addChild(new Spacer(0, 1));
		if (question) {
			container.addChild(new Text(theme.fg("warning", "\x1b[1mQUESTION\x1b[22m"), 0, 1));
			container.addChild(new Spacer(0, 0));
			container.addChild(new Markdown(question, 0, 1, mdTheme));
			container.addChild(new Spacer(0, 1));
		}
		container.addChild(new Text(theme.fg("warning", "\x1b[1mANSWER\x1b[22m"), 0, 1));
		container.addChild(new Spacer(0, 0));
		container.addChild(new Markdown(answer || content.trim(), 0, 1, mdTheme));
		box.addChild(container);
		return box;
	};

	pi.registerMessageRenderer("codex-bridge", (message, _options, theme) => {
		return renderBox("CODEX ANSWER", "customMessageLabel", String(message.content ?? ""), theme);
	});

	registerCodexBridge(pi);
}
