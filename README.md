# glance

Read-only overview of every local Claude Code session and of what each one is waiting on you for.
One Node file, no dependencies, no build. It never writes to the sessions and never controls them.

    node glance.mjs                    # → http://127.0.0.1:7357
    ./launchagent.sh install|uninstall # optional (macOS): start at login, restart if it dies

Clone it anywhere; it needs Node 20.12 or later.

## Configuration

All settings are optional; with none set, glance works for any Claude Code setup.
Set them as environment variables, or put them in a `.env` file next to `glance.mjs`:

    cp .env.example .env   # then uncomment what you need

`.env` (and any other `.env.*` file except `.env.example`) is in `.gitignore`, so your own settings stay on your
machine. Precedence: a variable already set in the environment wins over `.env`, and `.env` wins over the built-in
default. A variable that is set but empty counts as unset. If you move settings from shell exports into `.env`, remove
the old exports, or they keep winning. `GLANCE_ENV_FILE=/path/to/file` reads another file instead. A missing file is
fine; a line that is not `NAME=value` stops glance at start with a message.

Use single quotes around regular expressions in `.env`, so that backslashes stay as written. A quoted value ends at
its second quote, so write `'` inside a regular expression as `\x27` (text after the closing quote stops glance with a
message). An unquoted value ends at `#` (glance warns); quote a value that contains `#`.

| Variable | Default | Meaning |
|---|---|---|
| `GLANCE_PORT` | `7357` | Port on 127.0.0.1. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Where Claude Code keeps sessions and transcripts. |
| `GLANCE_ENV_FILE` | `.env` next to `glance.mjs` | The local settings file (environment only, not read from the file itself). |
| `GLANCE_IGNORE_NAMES` | none | Comma-separated session names whose own waits are not asks to you. With `deploy,review`, a sentence such as "deploy is waiting for your go" (one session reporting on another) does not make a card unless it also says "you". |
| `GLANCE_ASK_EXTRA` | none | Regular expression (case-insensitive) for extra sentences that count as an ask to you, added to the built-in ones. Useful when your sessions call you by a name or role, e.g. `\bfor (?:the )?lead\b`. |
| `GLANCE_MEMORY` | off | `1` (or `on`, `true`, `yes`) shows the memory sidebar. |
| `GLANCE_MEMORY_CUE` | see `glance.mjs` | Regular expression (case-insensitive): which `MEMORY.md` index lines to look at. The default matches "pending", "waiting on you", "needs you", "blocked on you" and "decisions pending". |
| `GLANCE_MEMORY_WAIT` | see `glance.mjs` | Regular expression: the part of such a line shown as the wait (no match = line skipped). The default takes the matched phrase up to the next `;`. |
| `GLANCE_MEMORY_SKIP` | `\b(?:DONE\|CLOSED\|COMPLETE\|PARKED)\b` | Regular expression: index entries whose title matches are skipped. |
| `GLANCE_PROJECT_PREFIX` | none | Comma-separated folder prefixes removed from the project label of a memory item (after your home folder), e.g. `code-` when your projects live in `~/code/`. |
| `GLANCE_ALLOWED_HOSTS` | none | Comma-separated extra `host:port` values to accept, for a proxy such as Tailscale Serve. |
| `GLANCE_TAILSCALE_USERS` | none | Comma-separated Tailscale logins. When set, any request that came through a proxy must carry a `Tailscale-User-Login` on this list (Serve sets it; tagged devices and Funnel requests have none). |
| `GLANCE_DEV` | off | `1` re-reads `index.html` on every page load. |

`.env.example` lists every variable except `GLANCE_ENV_FILE`, with an example. An invalid regular expression or an
invalid `GLANCE_MEMORY` value stops glance at start with a message, and an unknown `GLANCE_*` name in `.env` prints a
warning.

`launchagent.sh install` copies every `GLANCE_*` variable and `CLAUDE_CONFIG_DIR` that is set in your shell at install
time into the login item, where they win over `.env`; run it again after a change there. The `.env` file is read at
every start anyway, so settings that are only in `.env` need no reinstall (restart glance to apply them).

glance reads Claude Code's internal files, which are not a public format. A Claude Code update can change them and
break parts of the page.

## What it reads

| Source | Used for |
|---|---|
| `~/.claude/sessions/*.json` | the live sessions: name, status (busy / idle / shell), cwd, pid (checked alive) |
| `~/.claude/projects/<cwd>/<session>.jsonl` (tail, then only appended bytes) | title, last message, harness recap (`away_summary`), `/goal`, pending tool calls, PR and artifact links |
| `~/.claude/projects/*/memory/MEMORY.md` | only with `GLANCE_MEMORY` on: index lines that name a wait on you (see `GLANCE_MEMORY_*`) |

## How "needs you" is decided

1. **Asking you**: a pending `AskUserQuestion` (questions and options shown).
2. **Permission**: an unanswered tool call older than 8 s on an idle session, or a waiting status.
3. **Waiting on you**: an idle session whose recap "Next:" part or last message contains a sentence that puts the next move on you
   ("please review…", "your next step", "once you save…", "waiting for your answer", "nothing is posted until you…",
   plus anything `GLANCE_ASK_EXTRA` matches).
   Those sentences are the card's headline. Sentences about other sessions waiting (names in `GLANCE_IGNORE_NAMES`) do not count.

Sessions that are busy are listed under **In flight**, with the tool running now. Everything else is under **Quiet**.

## Page

- Polls `/api/state` every 2.5 s (10 s when the tab is hidden) with an ETag, so unchanged polls return 304.
- `/` focuses the filter and Esc clears it. **Context** opens the recap, last message, your last prompt and the goal.
- Click once anywhere to allow desktop notifications. You then get one notification each time a session starts waiting on you.
- The tab title shows the count, e.g. `(3) Glance`.
- It binds to 127.0.0.1 only, refuses foreign Host headers (DNS rebinding) and serves GET only.

## Another screen on your tailnet

Keep glance on 127.0.0.1 and let Tailscale Serve (tailnet only, HTTPS) proxy to it, on its own port. In `.env`:

    GLANCE_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net:7357
    GLANCE_TAILSCALE_USERS=<your Tailscale login>

then restart glance and run:

    tailscale serve --bg --https=7357 http://127.0.0.1:7357

Then open `https://<machine>.<tailnet>.ts.net:7357` on any device signed in as that login.
**Never use `tailscale funnel` for glance**: Funnel puts it on the public internet, and the page shows your
transcripts. (With `GLANCE_TAILSCALE_USERS` set, Funnel requests are refused anyway.) Undo: `tailscale serve --https=7357 off`.

## License

MIT, see `LICENSE`.
