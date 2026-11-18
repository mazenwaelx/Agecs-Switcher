// Filesystem side of the switcher: a "vault" holding one saved login snapshot per
// account, and functions to capture the current login into it or activate one.
// All paths come from the passed cfg, so tests can point it at temp dirs.
import { existsSync, mkdirSync, copyFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { credIdentity } from "./core.mjs";

export const expandHome = (p) => (p && p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

const prov = (cfg, provider) => {
  const p = cfg.providers[provider];
  if (!p) throw new Error(`unknown provider: ${provider}`);
  return p;
};

// Live credential file the CLI actually reads (e.g. ~/.claude/.credentials.json).
export function activePath(cfg, provider) {
  return join(expandHome(cfg.activeDirs[provider]), prov(cfg, provider).credFile);
}
// Vault slot for one account (e.g. <vault>/claude/claude-1/.credentials.json).
export function slotPath(cfg, provider, name) {
  return join(expandHome(cfg.vaultDir), provider, name, prov(cfg, provider).credFile);
}

const readJSON = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };

// Save the account that is CURRENTLY logged in into the vault under `name`.
export function capture(cfg, provider, name) {
  const src = activePath(cfg, provider);
  if (!existsSync(src)) throw new Error(`no active login to capture (expected ${src}). Log in first.`);
  const dst = slotPath(cfg, provider, name);
  mkdirSync(join(dst, ".."), { recursive: true });
  copyFileSync(src, dst);
  return dst;
}

// Make `name` the active account (overwrite the live credential file).
export function activate(cfg, provider, name) {
  const src = slotPath(cfg, provider, name);
  if (!existsSync(src)) throw new Error(`account "${name}" is not in the vault (${src}). Capture it first.`);
  const dst = activePath(cfg, provider);
  mkdirSync(join(dst, ".."), { recursive: true });
  copyFileSync(src, dst);
  return dst;
}

export function isCaptured(cfg, provider, name) {
  return existsSync(slotPath(cfg, provider, name));
}

// Which vaulted account matches the live login? null if none / not logged in.
export function whichActive(cfg, provider) {
  const p = prov(cfg, provider);
  const live = readJSON(activePath(cfg, provider));
  if (!live) return null;
  const liveId = credIdentity(live, p.identityField);
  for (const name of p.accounts) {
    const snap = readJSON(slotPath(cfg, provider, name));
    if (snap && credIdentity(snap, p.identityField) === liveId) return name;
  }
  return null;
}

// Status of every account of a provider, for the UI / CLI.
export function statusList(cfg, provider, cooldownUntil = {}, now = Date.now()) {
  const p = prov(cfg, provider);
  const active = whichActive(cfg, provider);
  return p.accounts.map((name) => ({
    name,
    provider,
    captured: isCaptured(cfg, provider, name),
    active: name === active,
    coolingUntil: (cooldownUntil[name] || 0) > now ? cooldownUntil[name] : null,
  }));
}

const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { return 0; } };

// Newest transcript .jsonl under the transcripts dir (the live session's file).
export function newestTranscript(cfg, modifiedAfter = 0) {
  const root = expandHome(cfg.transcriptsDir);
  if (!existsSync(root)) return null;
  let best = null, bestM = modifiedAfter;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".jsonl") && mtime(full) > bestM) { bestM = mtime(full); best = full; }
    }
  };
  try { walk(root); } catch { /* ignore */ }
  return best;
}
