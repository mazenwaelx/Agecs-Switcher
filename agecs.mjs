#!/usr/bin/env node
// agecs — auto-switch your logged-in Claude/Codex accounts when one hits its
// usage limit. Run `agecs run` instead of `claude`: it launches Claude normally,
// and the moment Claude Code logs a real usage-limit error, it swaps to your next
// account and continues the same conversation. No API key, no dependencies.
//
//   agecs run [provider] [-- ...args]   launch + auto-switch (default: claude)
//   agecs login <name>                  sign a new account in, then save it
//   agecs capture <name>                save the CURRENT login as <name>
//   agecs use <name>                    switch to <name> now
//   agecs status [provider]             show accounts + which is active

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { pickNextAccount, earliestReset } from "./lib/core.mjs";
import { capture, activate, whichActive, statusList, isCaptured, makeLimitTailer, accountFingerprint, recordAccountInfo } from "./lib/vault.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, "accounts.json"), "utf8"));
const isWin = process.platform === "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (ms) => new Date(ms).toLocaleTimeString();
const C = { cyan: "\x1b[36m", yellow: "\x1b[33m", green: "\x1b[32m", red: "\x1b[31m", reset: "\x1b[0m" };
const say = (m) => console.log(`${C.cyan}[agecs]${C.reset} ${m}`);
const warn = (m) => console.log(`${C.yellow}[agecs]${C.reset} ${m}`);

function providerOf(name) {
  for (const [pn, p] of Object.entries(cfg.providers)) if (p.accounts.includes(name)) return pn;
  return cfg.defaultProvider || "claude";
}
// Windows can't spawn a .cmd directly (EINVAL) and shell:true triggers a DEP0190
// warning on every launch; route through cmd.exe /c so interactive stdio still
// inherits the console (the Claude TUI needs a real terminal).
function spawnCli(cmd, args) {
  const opts = { stdio: "inherit", cwd: process.cwd() };
  return isWin ? spawn(process.env.ComSpec || "cmd.exe", ["/c", cmd, ...args], opts) : spawn(cmd, args, opts);
}

// Tell the AGECS Reloader VS Code extension (if installed) to reload the window so
// the Claude Code PANEL re-reads the just-swapped account. No-op if it isn't installed.
function signalReload() {
  try {
    const dir = join(homedir(), ".agecs-switcher");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "reload.signal"), String(Date.now()));
  } catch { /* best effort */ }
}

// --- commands --------------------------------------------------------------
function cmdStatus(provider = "claude") {
  say(`${provider} accounts:`);
  for (const a of statusList(cfg, provider)) {
    const flags = [a.active ? `${C.green}ACTIVE${C.reset}` : "", a.captured ? "saved" : `${C.red}not saved${C.reset}`,
      a.coolingUntil ? `${C.yellow}capped-> ${fmt(a.coolingUntil)}${C.reset}` : ""].filter(Boolean).join("  ");
    console.log(`  - ${a.name}  ${a.email ? `${a.email}  ` : ""}${flags}`);
  }
}
// Health check: are accounts saved, distinct, and is there something to switch to?
// Distinctness is by full-credential fingerprint, so two seats in the SAME org
// count as distinct (different logins) — only the same login saved twice is flagged.
function cmdDoctor() {
  let problems = 0;
  for (const [provider, p] of Object.entries(cfg.providers)) {
    const saved = p.accounts.filter((n) => isCaptured(cfg, provider, n));
    say(`${provider}: ${saved.length}/${p.accounts.length} saved, active: ${whichActive(cfg, provider) || "(none/unknown)"}`);
    const byFp = new Map();
    for (const n of saved) {
      const fp = accountFingerprint(cfg, provider, n);
      if (byFp.has(fp)) { warn(`  ! "${n}" is the SAME login as "${byFp.get(fp)}" — re-login "${n}" with a different account.`); problems++; }
      else byFp.set(fp, n);
    }
    const distinct = byFp.size;
    if (saved.length === 0) console.log(`  (not set up — skip if you don't use ${provider})`);
    else if (distinct < 2) { warn(`  ! only ${distinct} distinct account — nothing to switch to when it caps. Save another.`); problems++; }
    else console.log(`  ${C.green}${distinct} distinct accounts — switching will work.${C.reset}`);
  }
  say(problems ? `${C.red}${problems} problem(s).${C.reset}` : `${C.green}all good.${C.reset}`);
}

function cmdCapture(name) {
  const provider = providerOf(name);
  capture(cfg, provider, name);
  say(`${C.green}saved${C.reset} current ${provider} login as "${name}".`);
}
function cmdUse(name) {
  const provider = providerOf(name);
  activate(cfg, provider, name);
  signalReload();
  say(`switched active ${provider} account to "${name}". Terminal: next launch. Panel: reloads if AGECS Reloader is installed.`);
}
function cmdLogin(name) {
  const provider = providerOf(name);
  const p = cfg.providers[provider];
  say(`opening ${p.cmd} — type /login and sign in as "${name}", then exit.`);
  const child = spawnCli(p.cmd, []);
  child.on("close", () => {
    try {
      cmdCapture(name);
      const email = recordAccountInfo(cfg, provider, name);
      if (email) say(`recorded "${name}" = ${C.green}${email}${C.reset}`);
    } catch (e) { warn(e.message); }
  });
}

async function cmdRun(provider, passthrough) {
  provider = provider || cfg.defaultProvider || "claude";
  const p = cfg.providers[provider];
  if (!p) { warn(`unknown provider "${provider}"`); process.exit(2); }
  const cooldownMs = (cfg.defaultCooldownHours || 5) * 3600 * 1000;
  const cooldownUntil = {};
  const saved = () => p.accounts.filter((n) => isCaptured(cfg, provider, n));

  let active = whichActive(cfg, provider);
  if (!active) {
    const first = saved()[0];
    if (!first) { warn(`no saved ${provider} accounts. Run:  node agecs.mjs login ${p.accounts[0] || "claude-1"}`); process.exit(2); }
    activate(cfg, provider, first); active = first;
    say(`no account was active — activated "${first}".`);
  }

  let firstLaunch = true;
  while (true) {
    if ((cooldownUntil[active] || 0) > Date.now()) {
      const next = pickNextAccount({ accounts: saved(), activeName: active, cooldownUntil, now: Date.now() });
      if (!next) { await waitForReset(cooldownUntil); continue; }
      activate(cfg, provider, next); active = next;
    }
    say(`▶ launching ${provider} as ${C.green}${active}${C.reset}${firstLaunch ? "" : " (continuing)"}`);
    const outcome = await launchUntilLimitOrExit(provider, active, passthrough, firstLaunch, cooldownUntil, cooldownMs);
    firstLaunch = false;
    if (outcome.quit) { say("Claude exited normally. Bye."); return; }
    warn(`${active} hit a usage limit. Cooling until ${fmt(cooldownUntil[active])}. Switching...`);
    const next = pickNextAccount({ accounts: saved(), activeName: active, cooldownUntil, now: Date.now() });
    if (!next) { await waitForReset(cooldownUntil); continue; }
    activate(cfg, provider, next); active = next;
  }
}

// For the VS Code Claude Code PANEL (and any Claude you run yourself): we don't own
// that process, so we can't relaunch it. Instead we watch the transcript and the
// moment a real limit hits, swap the active login to the next account — then you
// just re-send your message / press Continue in the panel and it's on the new one.
async function cmdWatch(provider) {
  provider = provider || cfg.defaultProvider || "claude";
  const p = cfg.providers[provider];
  if (!p) { warn(`unknown provider "${provider}"`); process.exit(2); }
  const cooldownMs = (cfg.defaultCooldownHours || 5) * 3600 * 1000;
  const cooldownUntil = {};
  const saved = () => p.accounts.filter((n) => isCaptured(cfg, provider, n));

  let active = whichActive(cfg, provider);
  if (!active) {
    const first = saved()[0];
    if (!first) { warn(`no saved ${provider} accounts. Run:  node agecs.mjs login ${p.accounts[0] || "claude-1"}`); process.exit(2); }
    activate(cfg, provider, first); active = first;
    say(`no account was active — activated "${first}".`);
  }
  say(`watching ${provider} (active: ${C.green}${active}${C.reset}). Use the Claude Code panel as normal.`);
  say(`on a limit I'll switch the account — then re-send your message / press Continue in the panel.`);

  const tail = makeLimitTailer(cfg, Date.now());
  while (true) {
    await sleep(cfg.pollMs || 1500);
    const live = whichActive(cfg, provider);           // follow a manual switch too
    if (live && live !== active) active = live;
    let hit; try { hit = tail(); } catch { continue; }
    if (!hit) continue;
    cooldownUntil[active] = hit.resetEpochMs || Date.now() + cooldownMs;
    warn(`${active} hit a usage limit. Cooling until ${fmt(cooldownUntil[active])}. Switching...`);
    const next = pickNextAccount({ accounts: saved(), activeName: active, cooldownUntil, now: Date.now() });
    if (!next) { await waitForReset(cooldownUntil); continue; }
    activate(cfg, provider, next); active = next;
    signalReload();
    say(`${C.green}switched to ${next}${C.reset}. Panel reloads automatically (AGECS Reloader); terminal picks it up on next launch.`);
  }
}

async function waitForReset(cooldownUntil) {
  const next = earliestReset(cooldownUntil);
  const waitMs = Math.max(next - Date.now(), 60_000);
  warn(`all accounts capped. Waiting until ${fmt(next)} (${Math.round(waitMs / 60000)} min)...`);
  await sleep(waitMs);
}

// Launch the CLI (inherited TTY = normal interactive UI). Concurrently tail the
// newest transcript for a real usage-limit event (structured isApiErrorMessage).
function launchUntilLimitOrExit(provider, active, passthrough, firstLaunch, cooldownUntil, cooldownMs) {
  const p = cfg.providers[provider];
  const args = firstLaunch ? [...passthrough] : [...p.continueArgs, ...passthrough];
  const launchTs = Date.now();
  const child = spawnCli(p.cmd, args);
  const tail = makeLimitTailer(cfg, launchTs);

  return new Promise((resolve) => {
    let done = false, limitHit = false;

    const poll = setInterval(() => {
      try {
        const hit = tail();
        if (hit) {
          cooldownUntil[active] = hit.resetEpochMs || Date.now() + cooldownMs;
          limitHit = true;
          killTree(child);
        }
      } catch { /* transient fs race — ignore */ }
    }, cfg.pollMs || 1500);

    child.on("close", () => {
      if (done) return; done = true;
      clearInterval(poll);
      resolve({ quit: !limitHit });
    });
  });
}

function killTree(child) {
  try { if (isWin) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"]); else child.kill("SIGTERM"); } catch { /* gone */ }
}

// --- dispatch --------------------------------------------------------------
const [cmd, ...rest] = process.argv.slice(2);
const sep = rest.indexOf("--");
const passthrough = sep >= 0 ? rest.slice(sep + 1) : [];
const positional = sep >= 0 ? rest.slice(0, sep) : rest;
const requireName = (n) => { if (!n) { warn("needs an account name, e.g. claude-1"); process.exit(2); } return true; };

try {
  if (cmd === "status") cmdStatus(positional[0]);
  else if (cmd === "doctor") cmdDoctor();
  else if (cmd === "capture") requireName(positional[0]) && cmdCapture(positional[0]);
  else if (cmd === "use") requireName(positional[0]) && cmdUse(positional[0]);
  else if (cmd === "login") requireName(positional[0]) && cmdLogin(positional[0]);
  else if (cmd === "watch") cmdWatch(positional[0]);
  else if (cmd === "run" || cmd === undefined) cmdRun(positional[0], passthrough);
  else { console.log("commands: run | watch [provider] | login <name> | capture <name> | use <name> | status [provider] | doctor"); process.exit(1); }
} catch (e) { warn(e.message); process.exit(1); }
