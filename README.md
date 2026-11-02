# pi-extensions

Personal [pi](https://github.com/badlogic/pi-mono) extensions, distributed as a pi package.

## Install

On any machine:

```bash
pi install git:github.com/Haxi52/pi-extensions
```

Update:

```bash
pi update --extensions
```

Remove:

```bash
pi remove git:github.com/Haxi52/pi-extensions
```

## Extensions

### bg-notify

Background tasks with agent notification. Long-running work (builds, downloads, test suites, docker/CI jobs) starts with the `bg` tool and returns immediately; when the process exits, the agent receives a message and continues, so it never has to poll.

- `bg run { command, name? }` — start in background, returns task id
- `bg list` — tasks and statuses
- `bg log { id, lines? }` — tail a task's log
- `bg kill { id }` — stop a task (no notification)
- `/bg` — human-facing task list; running tasks show in the footer; desktop notification (OSC 777) on finish

### web-search

Web search and page reading, backed by DuckDuckGo's JS-free HTML endpoint (`html.duckduckgo.com/html/`). No API key, no quota, no SDK. DDG's `uddg=` redirect wrappers are unwrapped to the real target URL and pages are flattened to readable text (scripts/styles/comments dropped, entities decoded).

- `web_search { query, limit? }` — DuckDuckGo search, returns numbered title / URL / snippet results (default 8, max 20)
- `web_fetch { url }` — GET a URL and return its text, truncated to pi's 50KB / 2000 line limits
- `/websearch <query>` — human-facing search, top 5 results in a notification

Requests send a desktop browser User-Agent, follow redirects, and time out after 20s (30s for `web_fetch`). If DuckDuckGo rate-limits (a challenge page with no results), the tool reports it instead of returning junk. Cancelled agent turns abort in-flight requests via `ctx.signal`.

## Development

Pure parsing/flattening logic is covered by node:test:

```bash
npm test
```

Try a single extension without installing:

```bash
pi -e ./extensions/web-search.ts
```
