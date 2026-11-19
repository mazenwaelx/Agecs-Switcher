# AGECS Switcher

Keep working in VSCode when Claude hits its limit. You use **Claude Code normally
in the terminal**; the moment it logs a real **5-hour or weekly usage-limit**,
this tool silently **switches to another account you've logged in** and continues
the same conversation. No API key — it swaps your subscription logins. No npm
dependencies.

> Status: the **Claude** path is built, verified, and unit/integration-tested.
> The **Codex / ChatGPT** path is wired in config but unverified (the OpenAI Codex
> CLI isn't installed here) — confirm its `auth.json` path and `resume` flag first.

## Quick start (new machine)

You need **Node.js** (https://nodejs.org) and **Claude Code** already installed, and
**two different Claude accounts**.

1. **Double-click `setup.cmd`** (installs the panel helper, checks your setup).
2. **Save both accounts** — opens Claude; type `/login`, sign in, exit:
   ```bash
   node agecs.mjs login claude-1
   node agecs.mjs login claude-2
   ```
3. **Check:** `node agecs.mjs doctor` → should say *"2 distinct accounts — switching will work."*
4. **Start it — double-click `START.cmd`** and press a number to pick a mode:
   - **[1] Sidebar panel** — the Claude chat panel. Needs `claudeCode.continueAfterReload: true`
     and `autoContinueAtUsageLimit: true` set once (see
     [the panel section](#using-the-vs-code-claude-code-extension-sidebar-panel)), then reopen VS Code.
   - **[2] Terminal** — Claude in the terminal, fully automatic, keeps the conversation.
   - **[3] App window** — buttons to log in / save / switch accounts.
   - **[4] Check accounts** — runs `doctor`.

   (Prefer typing? The same modes are `node agecs.mjs watch` / `run`, and `node app.mjs`.)

That's it — when an account hits its limit, it switches to the other one.

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

Each account must be a **different Claude login**. Two seats in the **same
org/team** count as different accounts (they share an `organizationUuid` but have
separate usage limits) — the switcher tells them apart by the full login, not the
org. Run `node agecs.mjs doctor` to confirm your saved accounts are distinct and
there's something to switch to.

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
| `agecs run [provider] [-- args]` | launch Claude in the terminal and auto-switch on a limit |
| `agecs watch [provider]` | for the VS Code Claude Code **panel**: swap the account on a limit |
| `agecs login <name>` | sign a new account in and save it |
| `agecs capture <name>` | save whoever is logged in right now as `<name>` |
| `agecs use <name>` | switch the active account now |
| `agecs status [provider]` | list accounts: saved / ACTIVE / capped |
| `agecs doctor` | check accounts are saved, **distinct**, and switchable |

## Using the VS Code Claude Code extension (sidebar panel)

Two ways to use Claude in VS Code, two modes:

- **Integrated terminal (CLI)** → `agecs run`. Fully automatic: it owns the
  Claude process, so on a limit it swaps *and relaunches* `--continue` itself.
- **The extension's chat panel (GUI)** → switch, then **restart VS Code**.
  Switching an account (`agecs use <name>`, the app's **Make active**, or `watch`
  on a limit) swaps **both** the tokens *and* the account identity
  (`oauthAccount` in `~/.claude.json`). But the panel loads its login into memory
  when the session starts, so a **running** chat won't change — you must fully
  **quit and reopen VS Code** (not just *Reload Window*, which resumes the old
  session), then start a new chat. `/status` in the panel will then show the new
  account.

  `agecs watch` detects the limit and does the swap for you; you still restart to
  adopt it. Run it in a side terminal and leave it going:

```bash
node agecs.mjs watch
```

Or the VSCode task **"AGECS: Watch (extension panel)"**.

### Make the panel switch automatically (AGECS Reloader)

The panel caches its login in memory, so a swap alone won't move a *running* chat.
The **AGECS Reloader** companion extension fixes that: the switcher writes a signal
whenever it swaps accounts, and the extension reloads the window so the panel
re-reads the new login — no manual quit. One-time setup:

1. **Install it:** double-click **`install-reloader.cmd`** (copies `vscode-reloader/`
   into `~/.vscode/extensions/`).
2. **Set** `"claudeCode.continueAfterReload": true` in VS Code settings — so the
   reloaded panel **resumes your conversation**. Combined with the switcher's
   identity swap, the resumed chat comes back on the **new** account (the same chat,
   now on the other login).
3. **Fully quit and reopen VS Code once** to load the extension.

After that: `agecs watch` (or **Make active**) swaps the account → the window
reloads itself (~1s flash) → **your conversation continues on the new account**.
The extension then **pre-fills `continue`** in the panel so you just press **Enter**
to resume the work.

**Auto-press Enter (optional, fragile):** to also send `continue` without any
keypress, create the flag file `~/.agecs-switcher/auto-submit` (e.g.
`echo 1 > %USERPROFILE%\.agecs-switcher\auto-submit`). It uses an OS keystroke, so
it only works when the VS Code window is focused — delete the file to turn it off.
There is no official "send" API; the Claude URI only pre-fills the box.

> **Both tokens and identity:** the panel reads the displayed account from
> `~/.claude.json` (`oauthAccount`), not only the token file — so switching must
> move both, or `/status` shows the wrong account. `use`/`activate` do this
> automatically, but only for accounts saved **with** their identity: run
> `agecs login <name>` once per account (not just `capture`) so the identity is
> recorded.

Without the Reloader, the panel needs a manual **full restart** after a switch
(not *Reload Window*, which resumes the old session). The **terminal** (`agecs run`)
is switch-and-continue with zero restart, because each launch is a fresh process.

## App (desktop window)

Double-click **`AGECS.cmd`** (or run `npm run app` / `node app.mjs`). It opens a
real **app window** — its own window, no browser tabs or address bar, own taskbar
icon — with buttons to log in / save / switch accounts, a health check, and
**Watch** / **Run** to start switching. Closing the window quits it.

Under the hood it runs a tiny localhost server and shows it in an Edge/Chrome app
window (no Electron, no dependencies). If neither is installed it falls back to
your default browser. Also available as the VSCode task **"AGECS: App"**.

```bash
node app.mjs          # or: npm run app  — opens the app window
node server.mjs       # plain web version at http://127.0.0.1:4319 (task: "Control panel (web)")
```

## From VSCode

Copy this repo's `.vscode/tasks.json` into any project (the tasks call the switcher
by absolute path). Then **Terminal → Run Task → "AGECS: Run (auto-switch)"**.

## Tests

```bash
npm test        # node --test  — core logic, vault, server connection, fake-data switch
```

53 tests: limit detection + the full per-poll scan + the live-transcript tailer
(launch-time filtering, cross-poll uuid dedup, offset tracking, reset-epoch
parsing incl. past-epoch rejection), 3-account
exhaustion rotation + cooldown, vault capture/activate round-trip + re-capture +
corrupted/absent credential files, newest-transcript selection by mtime, the
server connection, and the full fake-transcript → swap flow — all on fake data.

## Caveats

- Rotating accounts to get past usage limits is a **ToS gray area** for Anthropic/
  OpenAI, even with your own paid accounts. Your call.
- The switch relaunches Claude (resumes via `--continue`) — a brief blip, not a
  mid-message hot-swap (no API lets you change account inside a live request).
- If a future Claude Code version changes the limit wording, add the new snippet
  to `limitPatterns` in `accounts.json` and run `npm test`.
