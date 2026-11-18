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
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isLimitEvent, pickNextAccount, earliestReset } from "./lib/core.mjs";
import { capture, activate, whichActive, statusList, isCaptured, newestTranscript } from "./lib/vault.mjs";

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
const exe = (cmd) => (isWin && !cmd.includes(".") ? `${cmd}.cmd` : cmd);

// --- commands --------------------------------------------------------------
function cmdStatus(provider = "claude") {
  say(`${provider} accounts:`);
  for (const a of statusList(cfg, provider)) {
    const flags = [a.active ? `${C.green}ACTIVE${C.reset}` : "", a.captured ? "saved" : `${C.red}not saved${C.reset}`,
      a.coolingUntil ? `${C.yellow}capped-> ${fmt(a.coolingUntil)}${C.reset}` : ""].filter(Boolean).join("  ");
    console.log(`  - ${a.name}  ${flags}`);
  }
}
function cmdCapture(name) {
  const provider = providerOf(name);
  capture(cfg, provider, name);
  say(`${C.green}saved${C.reset} current ${provider} login as "${name}".`);
}
function cmdUse(name) {
  const provider = providerOf(name);
  activate(cfg, provider, name);
  say(`switched active ${provider} account to "${name}". Applies on next Claude launch.`);
}
function cmdLogin(name) {
  const provider = providerOf(name);
  const p = cfg.providers[provider];
  say(`opening ${p.cmd} — type /login and sign in as "${name}", then exit.`);
  const child = spawn(exe(p.cmd), [], { stdio: "inherit", cwd: process.cwd() });
  child.on("close", () => { try { cmdCapture(name); } catch (e) { warn(e.message); } });
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
  const child = spawn(exe(p.cmd), args, { stdio: "inherit", cwd: process.cwd() });

  return new Promise((resolve) => {
    let done = false, limitHit = false;
    const seen = new Set();
    let watchFile = null, offset = 0;

    const poll = setInterval(() => {
      try {
        const f = newestTranscript(cfg, launchTs - 60_000);
        if (!f) return;
        if (f !== watchFile) { watchFile = f; offset = 0; }
        const size = statSync(f).size;
        if (size <= offset) return;
        const chunk = readFileSync(f, "utf8").slice(offset);
        offset = size;
        for (const line of chunk.split(/\r?\n/)) {
          if (!line.trim()) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          const ts = Date.parse(o.timestamp || 0) || 0;
          if (ts && ts < launchTs) continue;
          if (o.uuid && seen.has(o.uuid)) continue;
          if (o.uuid) seen.add(o.uuid);
          if (isLimitEvent(o, cfg.limitPatterns)) {
            cooldownUntil[active] = detectReset(o) || Date.now() + cooldownMs;
            limitHit = true;
            killTree(child);
            return;
          }
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

function detectReset(o) {
  const t = JSON.stringify(o).match(/(\d{10})/);
  if (!t) return null;
  const ms = Number(t[1]) * 1000;
  return ms > Date.now() ? ms : null;
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
  else if (cmd === "capture") requireName(positional[0]) && cmdCapture(positional[0]);
  else if (cmd === "use") requireName(positional[0]) && cmdUse(positional[0]);
  else if (cmd === "login") requireName(positional[0]) && cmdLogin(positional[0]);
  else if (cmd === "run" || cmd === undefined) cmdRun(positional[0], passthrough);
  else { console.log("commands: run | login <name> | capture <name> | use <name> | status [provider]"); process.exit(1); }
} catch (e) { warn(e.message); process.exit(1); }
