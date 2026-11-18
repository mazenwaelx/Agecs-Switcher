# AGECS Switcher

Keep working in VSCode when Claude hits its limit. You use **Claude Code normally
in the terminal**; the moment it logs a real **5-hour or weekly usage-limit**,
this tool silently **switches to another account you've logged in** and continues
the same conversation. No API key — it swaps your subscription logins. No npm
dependencies.

> Status: the **Claude** path is built, verified, and unit/integration-tested.
> The **Codex / ChatGPT** path is wired in config but unverified (the OpenAI Codex
> CLI isn't installed here) — confirm its `auth.json` path and `resume` flag first.

## Why it works

Claude Code stores your login as a plain file (`~/.claude/.credentials.json`) and
logs every API error — including usage limits — to its session transcript as a
structured `isApiErrorMessage` event. So the switcher can:

1. keep a **vault** of each account's login snapshot,
2. run `claude` with a normal interactive terminal,
3. watch the transcript for a **real** limit event (the structured flag, not just
   the words "limit" in your chat — so it never switches by mistake),
4. on a hit: swap the active login to your next account and relaunch
   `claude --continue` so your conversation picks up where it stopped.

## Setup (once per account)

```bash
# 1. Log each account in (opens Claude; type /login, then exit — it auto-saves):
node agecs.mjs login claude-1
node agecs.mjs login claude-2        # sign in with your OTHER account

# 2. Check they're saved:
node agecs.mjs status
```

Logins are stored under `~/.agecs-switcher/vault/` — **never** in this repo (see
`.gitignore`).

## Daily use

Instead of `claude`, run:

```bash
node agecs.mjs run
```

Use Claude exactly as normal in that terminal. When an account caps, you'll see
`[agecs] … hit a usage limit. Switching…`, a brief relaunch, and your conversation
continues on the next account. When all accounts are capped it waits for the
soonest reset, then resumes.

Pass Claude args through after `--`:  `node agecs.mjs run claude -- --model opus`

### Commands

| Command | Does |
|---|---|
| `agecs run [provider] [-- args]` | launch Claude and auto-switch on a limit |
| `agecs login <name>` | sign a new account in and save it |
| `agecs capture <name>` | save whoever is logged in right now as `<name>` |
| `agecs use <name>` | switch the active account now |
| `agecs status [provider]` | list accounts: saved / ACTIVE / capped |

## Control panel (optional GUI)

```bash
node server.mjs       # opens http://127.0.0.1:4319
```

A localhost page to log in / save / switch accounts and start the auto-switcher
with buttons. Also available as the VSCode task **"AGECS: Control panel"**.

## From VSCode

Copy this repo's `.vscode/tasks.json` into any project (the tasks call the switcher
by absolute path). Then **Terminal → Run Task → "AGECS: Run (auto-switch)"**.

## Tests

```bash
npm test        # node --test  — core logic, vault, server connection, fake-data switch
```

29 tests: limit detection (incl. no-false-switch), account rotation + cooldown,
vault capture/activate round-trip, the server connection, and the full
fake-transcript → swap flow.

## Caveats

- Rotating accounts to get past usage limits is a **ToS gray area** for Anthropic/
  OpenAI, even with your own paid accounts. Your call.
- The switch relaunches Claude (resumes via `--continue`) — a brief blip, not a
  mid-message hot-swap (no API lets you change account inside a live request).
- If a future Claude Code version changes the limit wording, add the new snippet
  to `limitPatterns` in `accounts.json` and run `npm test`.
