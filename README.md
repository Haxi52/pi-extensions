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
