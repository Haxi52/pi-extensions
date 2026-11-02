/**
 * Node test for the pure parts of extensions/web-search.ts (parser + text
 * flattener). The pi/typebox imports are stripped, so this runs without the
 * extension runtime:  node --test tests/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(
	path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extensions", "web-search.ts"),
	"utf8",
)
	.replace(/^import[\s\S]*?from\s+"[^"]*";\n/gm, "")
	.replace(/^const SearchParams[\s\S]*$/m, "");

const tmp = path.join(os.tmpdir(), "pi-web-search-sliced.ts");
writeFileSync(tmp, src);
const { parseDuckDuckGoResults, htmlToText } = (await import(pathToFileURL(tmp).href)) as {
	parseDuckDuckGoResults: (html: string, limit: number) => Array<{ title: string; url: string; snippet: string }>;
	htmlToText: (html: string) => string;
};

const SAMPLE = `
<div class="result__body">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%2Fb&amp;rut=abc">Node <b>fetch</b> &amp; AbortSignal</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=example.com">Aborts a <b>fetch</b> &nbsp;request &#8212; see docs.</a>
</div>
<div class="result__body">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example.org/x">Second &quot;Result&quot;</a></h2>
</div>
<div class="result__body">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%2Fb&amp;rut=zzz">Duplicate</a></h2>
</div>`;

test("parses DDG html results: unwraps uddg redirects, decodes entities, dedupes", () => {
	const results = parseDuckDuckGoResults(SAMPLE, 8);
	assert.equal(results.length, 2);
	assert.equal(results[0]!.url, "https://example.com/a/b");
	assert.equal(results[0]!.title, "Node fetch & AbortSignal");
	assert.equal(results[0]!.snippet, "Aborts a fetch request — see docs.");
	assert.equal(results[1]!.url, "https://example.org/x");
	assert.equal(results[1]!.title, 'Second "Result"');
	assert.equal(results[1]!.snippet, "");
});

test("respects limit", () => {
	assert.equal(parseDuckDuckGoResults(SAMPLE, 1).length, 1);
});

test("empty/irrelevant html yields no results", () => {
	assert.deepEqual(parseDuckDuckGoResults("<html><body>challenge</body></html>", 8), []);
});

test("htmlToText drops scripts/styles and keeps block breaks", () => {
	const text = htmlToText(
		`<html><head><style>a{color:red}</style><title>Hi &amp; bye</title></head><body>
		<script>var x = "<p>nope</p>";</script>
		<h1>Heading</h1><p>First para with <b>bold</b>.</p><ul><li>one</li><li>two</li></ul>
		<!-- comment -->line<br>break</body></html>`,
	);
	assert.equal(text, "Heading\nFirst para with bold.\none\ntwo\nline\nbreak");
});
