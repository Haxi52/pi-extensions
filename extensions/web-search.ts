/**
 * web-search - Web search and page fetch, backed by DuckDuckGo's HTML endpoint.
 *
 * Ported from the C# WebTools in Haxi52/Chatbot (DuckDuckGoSearch + WebGet),
 * reworked for pi: the DDG `html.duckduckgo.com/html/` markup is parsed without
 * a DOM, the `//duckduckgo.com/l/?uddg=…` redirect wrappers are unwrapped to the
 * real target URL, and pages are flattened to readable text.
 *
 * Load:
 *   pi -e ./extensions/web-search.ts
 * or copy into ~/.pi/agent/extensions/ for auto-discovery.
 *
 * Distribution:
 *   Published as a pi package: https://github.com/Haxi52/pi-extensions
 *   Install on other machines: pi install git:github.com/Haxi52/pi-extensions
 *   Updates: pi update --extensions
 *
 * Tools:
 *   web_search { query, limit? }  - DuckDuckGo search, returns title/snippet/url
 *   web_fetch  { url }            - GET a URL, return readable page text
 *
 * Commands:
 *   /websearch <query>            - human-facing search, top results in a notify
 *
 * Limits: web_fetch output is truncated to 50KB / 2000 lines (pi defaults);
 * web_search returns at most 20 results (default 8). Requests time out at 20s.
 */

import { Type } from "typebox";
import {
	defineTool,
	truncateHead,
	formatSize,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	laquo: "«",
	raquo: "»",
	middot: "·",
	bull: "•",
	copy: "©",
	reg: "®",
	trade: "™",
	deg: "°",
	times: "×",
	divide: "÷",
};

function decodeEntities(input: string): string {
	return input
		.replace(/&#(\d+);/g, (_m, dec: string) => safeCodePoint(Number(dec)))
		.replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeCodePoint(parseInt(hex, 16)))
		.replace(/&([a-z][a-z0-9]*);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function safeCodePoint(cp: number): string {
	try {
		return String.fromCodePoint(cp);
	} catch {
		return "";
	}
}

/** Strip inline tags, decode entities, collapse whitespace. For titles/snippets. */
function inlineText(html: string): string {
	return decodeEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/** Flatten a whole document to readable text: drop scripts/styles, keep block breaks. */
export function htmlToText(html: string): string {
	let s = html
		.replace(/<head[\s\S]*?<\/head>/gi, " ")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ");
	s = s.replace(
		/<\/?(p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|nav|blockquote|pre|figure|figcaption)[^>]*>/gi,
		"\n",
	);
	s = s.replace(/<br\s*\/?>/gi, "\n");
	s = s.replace(/<[^>]+>/g, "");
	return decodeEntities(s)
		.split("\n")
		.map((line) => line.replace(/[\t \u00a0]+/g, " ").trim())
		.filter((line) => line.length > 0)
		.join("\n");
}

/** DDG wraps every outbound link in //duckduckgo.com/l/?uddg=<encoded>&rut=<hash>. */
function unwrapDdgLink(href: string): string {
	let url = href.replace(/&amp;/g, "&");
	const at = url.indexOf("uddg=");
	if (at >= 0) {
		url = url.slice(at + 5);
		const amp = url.indexOf("&");
		if (amp >= 0) url = url.slice(0, amp);
		try {
			url = decodeURIComponent(url);
		} catch {
			/* leave as-is if malformed */
		}
	} else if (url.startsWith("//")) {
		url = `https:${url}`;
	}
	return url;
}

export function parseDuckDuckGoResults(html: string, limit: number): SearchResult[] {
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	// Each result block starts at its title anchor: <a rel="nofollow" class="result__a" href="…">
	for (const block of html.split('class="result__a"').slice(1)) {
		const href = /href="([^"]+)"/.exec(block);
		if (!href) continue;
		const url = unwrapDdgLink(href[1]);
		if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;

		const titleEnd = block.indexOf("</a>", href.index + href[1].length);
		if (titleEnd < 0) continue;
		const title = inlineText(block.slice(block.indexOf(">", href.index + href[1].length) + 1, titleEnd));
		if (!title) continue;

		let snippet = "";
		const snip = block.indexOf('class="result__snippet"');
		if (snip >= 0) {
			const from = block.indexOf(">", snip) + 1;
			const to = block.indexOf("</a>", from);
			if (to > from) snippet = inlineText(block.slice(from, to));
		}

		seen.add(url);
		results.push({ title, url, snippet });
		if (results.length >= limit) break;
	}
	return results;
}

async function httpGetText(url: string, signal?: AbortSignal, timeoutMs = 20_000): Promise<string> {
	const res = await fetch(url, {
		redirect: "follow",
		signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
		headers: {
			Accept: "text/html,application/xhtml+xml,*/*",
			"Accept-Language": "en-US,en;q=0.9",
			"User-Agent": UA,
		},
	});
	if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
	return await res.text();
}

async function search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const html = await httpGetText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, signal);
	const results = parseDuckDuckGoResults(html, limit);
	if (!results.length) {
		throw new Error(
			"DuckDuckGo returned no results (rate limit or challenge page). Retry shortly, or use web_fetch on a known URL.",
		);
	}
	return results;
}

function formatResults(results: SearchResult[]): string {
	return results
		.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
		.join("\n");
}

const SearchParams = Type.Object({
	query: Type.String({ description: "Search query" }),
	limit: Type.Optional(Type.Number({ description: "Max results, 1-20 (default 8)" })),
});

const webSearchTool = defineTool({
	name: "web_search",
	label: "Web search",
	description:
		"Search the web (DuckDuckGo) and return titles, URLs and snippets. " +
		"For current information: releases, library docs, error messages, news, anything not in the local repo. " +
		"Use web_fetch on a result URL to read the full page.",
	promptSnippet: "Search the web (DuckDuckGo) for current information",
	promptGuidelines: [
		"Use web_search for facts that may be newer than your knowledge cutoff (library versions, APIs, CVEs, prices, events) instead of guessing.",
		"Use web_fetch on the most promising web_search result URL when a snippet is not enough to answer.",
	],
	parameters: SearchParams,

	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		const limit = Math.max(1, Math.min(20, Math.round(params.limit ?? 8)));
		const results = await search(params.query, limit, signal);
		return {
			content: [{ type: "text" as const, text: formatResults(results) }],
			details: { results },
		};
	},

	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(
			theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("muted", `"${args.query ?? ""}"`),
		);
		return text;
	},

	renderResult(result, { expanded, isPartial }, theme, context) {
		if (isPartial) return new Text(theme.fg("muted", "searching…"), 0, 0);
		const results = (result.details?.results ?? []) as SearchResult[];
		if (!results.length) return new Text(theme.fg("warning", "no results"), 0, 0);
		let out = theme.fg("success", `${results.length} result${results.length === 1 ? "" : "s"}`);
		if (!expanded) {
			return new Text(
				out + ` ${theme.fg("muted", results[0].title)} ${theme.fg("dim", `(${context.keyHint("app.tools.expand", "to expand")})`)}`,
				0,
				0,
			);
		}
		for (const [i, r] of results.entries()) {
			out += `\n${theme.fg("accent", `${i + 1}. ${r.title}`)}\n  ${theme.fg("muted", r.url)}`;
			if (r.snippet) out += `\n  ${theme.fg("dim", r.snippet)}`;
		}
		return new Text(out, 0, 0);
	},
});

const FetchParams = Type.Object({
	url: Type.String({ description: "Absolute http(s) URL to fetch" }),
});

const webFetchTool = defineTool({
	name: "web_fetch",
	label: "Web fetch",
	description:
		"HTTP GET a URL and return the page as readable text (scripts/styles removed, entities decoded). " +
		"Output is truncated to 50KB / 2000 lines. Use after web_search to read a result in full.",
	promptSnippet: "Fetch a URL and read it as text",
	parameters: FetchParams,

	async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
		const url = params.url.trim().replace(/^@/, "");
		if (!/^https?:\/\//i.test(url)) throw new Error(`url must be absolute http(s): ${params.url}`);
		const html = await httpGetText(url, signal, 30_000);
		const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
		const title = titleMatch ? inlineText(titleMatch[1]) : "";
		const body = htmlToText(html);
		const truncation = truncateHead(body, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
		let text = `${title ? `# ${title}\n${url}\n` : url}\n${truncation.content}`;
		if (truncation.truncated) {
			text += `\n\n[Truncated: ${truncation.outputLines} of ${truncation.totalLines} lines, ${formatSize(
				truncation.outputBytes,
			)} of ${formatSize(truncation.totalBytes)}. Narrow the request or use a more specific URL.]`;
		}
		return {
			content: [{ type: "text" as const, text }],
			details: { url, title, truncated: truncation.truncated, lines: truncation.totalLines },
		};
	},

	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("muted", args.url ?? ""));
		return text;
	},

	renderResult(result, { isPartial }, theme) {
		if (isPartial) return new Text(theme.fg("muted", "fetching…"), 0, 0);
		if (result.isError) {
			return new Text(theme.fg("error", String(result.content?.[0]?.text ?? "fetch failed")), 0, 0);
		}
		const d = (result.details ?? {}) as { url?: string; title?: string; lines?: number; truncated?: boolean };
		return new Text(
			theme.fg("success", `\u2713 ${d.title || d.url || "fetched"}`) +
				theme.fg("dim", ` (${d.lines ?? 0} lines${d.truncated ? ", truncated" : ""})`),
			0,
			0,
		);
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(webSearchTool);
	pi.registerTool(webFetchTool);

	pi.registerCommand("websearch", {
		description: "Search the web (DuckDuckGo) and show the top results",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) {
				ctx.ui.notify("Usage: /websearch <query>", "warning");
				return;
			}
			try {
				const results = await search(query, 5, ctx.signal);
				ctx.ui.notify(formatResults(results), "info");
			} catch (err) {
				ctx.ui.notify(`web search failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
