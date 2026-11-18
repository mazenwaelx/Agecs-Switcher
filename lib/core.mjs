// Pure logic for the account switcher. No fs, no network — all inputs passed in,
// so every function here is directly unit-testable with fake data.
import { createHash } from "node:crypto";

// Does this text look like a usage-limit message? Returns {hit, resetEpochMs}.
export function detectLimitText(text, patterns) {
  if (!text) return { hit: false, resetEpochMs: null };
  const hit = patterns.some((p) => new RegExp(p, "i").test(text));
  if (!hit) return { hit: false, resetEpochMs: null };
  const m = String(text).match(/(?:reset|reached|try again)[^0-9]{0,24}(\d{10})/i);
  return { hit: true, resetEpochMs: m ? Number(m[1]) * 1000 : null };
}

// Flatten a transcript message's content (string | block[]) to plain text.
export function eventText(o) {
  const c = o?.message?.content ?? o?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : b?.text || "")).join(" ");
  return "";
}

// Is this transcript event a usage-limit error? We key on Claude Code's own
// structured flag (isApiErrorMessage) FIRST, then confirm the text is a limit —
// so ordinary conversation mentioning "limit" never triggers a switch.
export function isLimitEvent(o, patterns) {
  const flagged = o?.isApiErrorMessage === true || o?.message?.isApiErrorMessage === true;
  if (!flagged) return false;
  return detectLimitText(eventText(o), patterns).hit;
}

// Stable identity for a credentials object, to tell which account is active.
export function credIdentity(creds, identityField) {
  if (!creds || typeof creds !== "object") return null;
  const unwrap = creds.claudeAiOauth ? { ...creds.claudeAiOauth, ...creds } : creds;
  if (identityField && unwrap[identityField]) return String(unwrap[identityField]);
  return "sha256:" + createHash("sha256").update(JSON.stringify(creds)).digest("hex").slice(0, 16);
}

// Pick the next account to switch to.
//   accounts: string[]  cooldownUntil: {name: epochMs}  now: epochMs
// Prefers an account other than the active one; never returns a cooling one.
// Returns a name, or null if every account is currently capped.
export function pickNextAccount({ accounts, activeName, cooldownUntil = {}, now = Date.now() }) {
  const available = accounts.filter((a) => (cooldownUntil[a] || 0) <= now);
  if (available.length === 0) return null;
  const others = available.filter((a) => a !== activeName);
  if (others.length > 0) return others[0];
  return available[0]; // only the active one is free
}

// Soonest time any capped account frees up (for "wait then resume").
export function earliestReset(cooldownUntil = {}) {
  const vals = Object.values(cooldownUntil);
  return vals.length ? Math.min(...vals) : 0;
}
