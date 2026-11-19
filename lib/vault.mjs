// Filesystem side of the switcher: a "vault" holding one saved login snapshot per
// account, and functions to capture the current login into it or activate one.
// All paths come from the passed cfg, so tests can point it at temp dirs.
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { credIdentity, scanLimitLines } from "./core.mjs";

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

// Tiny pointer remembering which account we last activated — the reliable way to
// know the active account when two accounts share an org (so organizationUuid
// can't tell them apart) and the live token has since been refreshed in place.
// The CLI's own account cache (e.g. ~/.claude.json, a sibling of ~/.claude) holds
// the logged-in account's email — but only updates on /login, not on our swaps.
const infoPath = (cfg, provider) => expandHome(cfg.activeDirs[provider]) + ".json";
const metaPath = (cfg, provider, name) => join(expandHome(cfg.vaultDir), provider, name, "account.json");

const pointerPath = (cfg, provider) => join(expandHome(cfg.vaultDir), provider, ".active-pointer");
const writePointer = (cfg, provider, name) => { try { writeFileSync(pointerPath(cfg, provider), name); } catch { /* best effort */ } };
const readPointer = (cfg, provider) => { try { return readFileSync(pointerPath(cfg, provider), "utf8").trim(); } catch { return null; } };

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
  writePointer(cfg, provider, name);
  restoreIdentity(cfg, provider, name);   // keep displayed identity in sync with tokens
  return dst;
}

export function isCaptured(cfg, provider, name) {
  return existsSync(slotPath(cfg, provider, name));
}

// Record who an account is (email/org), read from the CLI's account cache at the
// moment it's freshly logged in, and store it beside the snapshot. Returns the
// email, or null if the cache didn't have one. Call right after a real /login.
export function recordAccountInfo(cfg, provider, name) {
  const a = readJSON(infoPath(cfg, provider))?.oauthAccount;
  if (!a || !a.emailAddress) return null;
  try {
    const dst = metaPath(cfg, provider, name);
    mkdirSync(join(dst, ".."), { recursive: true });
    // Save the FULL oauthAccount block so activate() can restore the identity the
    // CLI/extension displays — not just the email for the UI.
    writeFileSync(dst, JSON.stringify({ email: a.emailAddress, org: a.organizationName || null, oauthAccount: a, at: Date.now() }, null, 2));
  } catch { /* best effort */ }
  return a.emailAddress;
}

// Put the account's saved identity back into the CLI's account cache (~/.claude.json)
// so the DISPLAYED/active account matches the swapped tokens. No-op if we never
// recorded it (account logged in before this feature) or the cache is unreadable.
function restoreIdentity(cfg, provider, name) {
  const saved = readJSON(metaPath(cfg, provider, name))?.oauthAccount;
  if (!saved) return;
  const f = infoPath(cfg, provider);
  const info = readJSON(f);
  if (!info) return;
  info.oauthAccount = saved;
  try { writeFileSync(f, JSON.stringify(info, null, 2)); } catch { /* best effort */ }
}

// The email recorded for an account (null if never recorded via a login).
export function accountEmail(cfg, provider, name) {
  return readJSON(metaPath(cfg, provider, name))?.email || null;
}

// Which vaulted account matches the live login? null if none / not logged in.
// Exact credential match first (distinguishes two accounts even in the SAME org);
// if the live token was refreshed since we activated it (no exact match), trust the
// last-activated pointer, but only when its org matches — so a genuinely different
// account logged in outside the tool still reads as unknown (null).
export function whichActive(cfg, provider) {
  const p = prov(cfg, provider);
  const live = readJSON(activePath(cfg, provider));
  if (!live) return null;
  const liveExact = credIdentity(live, null);
  for (const name of p.accounts) {
    const snap = readJSON(slotPath(cfg, provider, name));
    if (snap && credIdentity(snap, null) === liveExact) return name;
  }
  const ptr = readPointer(cfg, provider);
  if (ptr && p.accounts.includes(ptr)) {
    const snap = readJSON(slotPath(cfg, provider, ptr));
    if (snap && credIdentity(snap, p.identityField) === credIdentity(live, p.identityField)) return ptr;
  }
  return null;
}

// Stable fingerprint of a saved account's full credentials — two accounts with the
// same fingerprint are the SAME captured login (a useless duplicate). null if unsaved.
export function accountFingerprint(cfg, provider, name) {
  const snap = readJSON(slotPath(cfg, provider, name));
  return snap ? credIdentity(snap, null) : null;
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
    email: accountEmail(cfg, provider, name),
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

// A tailer for the live transcript: each call returns the first NEW real usage-limit
// event since launchTs (or null), tracking the newest file, its read offset, and
// seen uuids across calls. Used by both `run` (owns the process) and `watch` (the
// VS Code Claude Code panel, which the switcher can't relaunch — it just swaps the
// active login so your next message in the panel lands on the next account).
export function makeLimitTailer(cfg, launchTs = Date.now()) {
  const seen = new Set();
  let watchFile = null, offset = 0;
  return () => {
    const f = newestTranscript(cfg, launchTs - 60_000);
    if (!f) return null;
    if (f !== watchFile) { watchFile = f; offset = 0; }
    let size;
    try { size = statSync(f).size; } catch { return null; }
    if (size <= offset) return null;
    const chunk = readFileSync(f, "utf8").slice(offset);
    offset = size;
    return scanLimitLines(chunk, { patterns: cfg.limitPatterns, launchTs, seen, now: Date.now() });
  };
}
