// Edge cases on FAKE accounts + a FAKE vault: multi-account exhaustion rotation,
// re-capture (login refresh), corrupted/absent credential files, and picking the
// live transcript by mtime. All synthetic, no real logins touched.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pickNextAccount } from "../lib/core.mjs";
import { capture, activate, whichActive, statusList, isCaptured, activePath, slotPath, newestTranscript, accountFingerprint, recordAccountInfo, accountEmail } from "../lib/vault.mjs";

let root, cfg;
const creds = (org) => JSON.stringify({ claudeAiOauth: { accessToken: "t-" + org }, organizationUuid: org });

before(() => {
  root = mkdtempSync(join(tmpdir(), "agecs-edge-"));
  mkdirSync(join(root, "active"), { recursive: true });
  cfg = {
    activeDirs: { claude: join(root, "active") },
    vaultDir: join(root, "vault"),
    transcriptsDir: join(root, "projects"),
    providers: { claude: { credFile: ".credentials.json", identityField: "organizationUuid", accounts: ["claude-1", "claude-2", "claude-3"] } },
  };
});
after(() => rmSync(root, { recursive: true, force: true }));

// --- mock the accounts + the limit hits: full exhaustion rotation --------------
test("3-account rotation: each caps in turn, then all-capped returns null", () => {
  // save three distinct accounts
  for (const [n, org] of [["claude-1", "org-A"], ["claude-2", "org-B"], ["claude-3", "org-C"]]) {
    writeFileSync(activePath(cfg, "claude"), creds(org));
    capture(cfg, "claude", n);
  }
  const accounts = cfg.providers.claude.accounts;
  const cd = {};
  const now = 1_000_000;
  const cap = 3_600_000;

  let active = "claude-1";
  activate(cfg, "claude", active);
  assert.equal(whichActive(cfg, "claude"), "claude-1");

  cd[active] = now + cap;                       // claude-1 hits a limit
  let next = pickNextAccount({ accounts, activeName: active, cooldownUntil: cd, now });
  assert.equal(next, "claude-2");
  activate(cfg, "claude", next); active = next;
  assert.equal(whichActive(cfg, "claude"), "claude-2");

  cd[active] = now + cap;                       // claude-2 hits a limit
  next = pickNextAccount({ accounts, activeName: active, cooldownUntil: cd, now });
  assert.equal(next, "claude-3");
  activate(cfg, "claude", next); active = next;

  cd[active] = now + cap;                       // claude-3 hits a limit -> all capped
  assert.equal(pickNextAccount({ accounts, activeName: active, cooldownUntil: cd, now }), null);

  // after the soonest reset passes, claude-1 is free again
  assert.equal(pickNextAccount({ accounts, activeName: active, cooldownUntil: cd, now: now + cap + 1 }), "claude-1");
});

test("re-capture overwrites the saved snapshot (login refreshed)", () => {
  writeFileSync(activePath(cfg, "claude"), creds("org-OLD"));
  capture(cfg, "claude", "claude-1");
  assert.equal(whichActive(cfg, "claude"), "claude-1");

  writeFileSync(activePath(cfg, "claude"), creds("org-NEW"));
  capture(cfg, "claude", "claude-1");           // same slot, new token/org
  activate(cfg, "claude", "claude-1");
  assert.equal(whichActive(cfg, "claude"), "claude-1"); // identity re-matches the refreshed snapshot
});

test("whichActive is null when no one is logged in (no live file)", () => {
  const fresh = mkdtempSync(join(tmpdir(), "agecs-nolive-"));
  const c2 = { ...cfg, activeDirs: { claude: join(fresh, "active") }, vaultDir: join(fresh, "vault") };
  mkdirSync(join(fresh, "active"), { recursive: true });
  assert.equal(whichActive(c2, "claude"), null);
  rmSync(fresh, { recursive: true, force: true });
});

test("corrupted live credential file does not crash; whichActive returns null", () => {
  writeFileSync(activePath(cfg, "claude"), "{ this is not valid json ");
  assert.equal(whichActive(cfg, "claude"), null);
});

test("statusList: an un-captured account reports captured:false, active:false", () => {
  writeFileSync(activePath(cfg, "claude"), creds("org-A"));
  capture(cfg, "claude", "claude-1"); activate(cfg, "claude", "claude-1");
  const list = statusList(cfg, "claude");
  assert.equal(list.find((x) => x.name === "claude-1").active, true);
  const notSaved = list.find((x) => !isCaptured(cfg, "claude", x.name));
  if (notSaved) { assert.equal(notSaved.captured, false); assert.equal(notSaved.active, false); }
});

// --- newestTranscript: finds the live session file by mtime ---------------------
test("newestTranscript picks the most recently modified .jsonl across nested dirs", () => {
  const a = join(root, "projects", "projA", "old.jsonl");
  const b = join(root, "projects", "projB", "new.jsonl");
  mkdirSync(join(root, "projects", "projA"), { recursive: true });
  mkdirSync(join(root, "projects", "projB"), { recursive: true });
  writeFileSync(a, "{}\n"); writeFileSync(b, "{}\n");
  utimesSync(a, 1000, 1000);       // mtime = 1000s  (1_000_000 ms)
  utimesSync(b, 2000, 2000);       // mtime = 2000s  (2_000_000 ms) -> newest
  assert.equal(newestTranscript(cfg), b);
  // modifiedAfter filter excludes files older than the given mtime
  assert.equal(newestTranscript(cfg, 2_500_000), null);
});

test("newestTranscript returns null when the transcripts dir is missing", () => {
  const c2 = { ...cfg, transcriptsDir: join(root, "does-not-exist") };
  assert.equal(newestTranscript(c2), null);
});

test("slotPath / activePath stay under the configured dirs", () => {
  assert.ok(slotPath(cfg, "claude", "claude-1").startsWith(join(root, "vault")));
  assert.ok(activePath(cfg, "claude").startsWith(join(root, "active")));
});

// --- two accounts in the SAME org (different logins): the real user's case -------
test("same org, different logins: whichActive distinguishes them and survives a token refresh", () => {
  const r = mkdtempSync(join(tmpdir(), "agecs-org-"));
  mkdirSync(join(r, "active"), { recursive: true });
  const c = {
    activeDirs: { claude: join(r, "active") }, vaultDir: join(r, "vault"), transcriptsDir: join(r, "t"),
    providers: { claude: { credFile: ".credentials.json", identityField: "organizationUuid", accounts: ["a1", "a2"] } },
  };
  const cred = (tok) => JSON.stringify({ claudeAiOauth: { accessToken: tok, refreshToken: "r-" + tok }, organizationUuid: "ORG-SHARED" });
  writeFileSync(activePath(c, "claude"), cred("tokA")); capture(c, "claude", "a1");
  writeFileSync(activePath(c, "claude"), cred("tokB")); capture(c, "claude", "a2");

  activate(c, "claude", "a1");
  assert.equal(whichActive(c, "claude"), "a1", "shared org must not merge the two accounts");
  activate(c, "claude", "a2");
  assert.equal(whichActive(c, "claude"), "a2");

  // Claude refreshes a2's token in place (new token, same org) -> pointer keeps identity
  writeFileSync(activePath(c, "claude"), cred("tokB-refreshed"));
  assert.equal(whichActive(c, "claude"), "a2");

  // a stranger account in a DIFFERENT org reads as unknown, not the stale pointer
  writeFileSync(activePath(c, "claude"), JSON.stringify({ claudeAiOauth: { accessToken: "x" }, organizationUuid: "OTHER-ORG" }));
  assert.equal(whichActive(c, "claude"), null);
  rmSync(r, { recursive: true, force: true });
});

test("recordAccountInfo + accountEmail: email is captured from the CLI cache and shown in status", () => {
  const r = mkdtempSync(join(tmpdir(), "agecs-email-"));
  mkdirSync(join(r, "active"), { recursive: true });
  const c = {
    activeDirs: { claude: join(r, "active") }, vaultDir: join(r, "vault"), transcriptsDir: join(r, "t"),
    providers: { claude: { credFile: ".credentials.json", identityField: "organizationUuid", accounts: ["x1"] } },
  };
  writeFileSync(activePath(c, "claude"), JSON.stringify({ claudeAiOauth: { accessToken: "t" }, organizationUuid: "O" }));
  // the CLI's account cache lives next to the active dir: <active>.json  (~/.claude.json)
  writeFileSync(join(r, "active.json"), JSON.stringify({ oauthAccount: { emailAddress: "who@example.com", organizationName: "Acme" } }));
  capture(c, "claude", "x1");

  assert.equal(recordAccountInfo(c, "claude", "x1"), "who@example.com");
  assert.equal(accountEmail(c, "claude", "x1"), "who@example.com");
  assert.equal(statusList(c, "claude").find((a) => a.name === "x1").email, "who@example.com");
  // no cache -> null, no throw
  assert.equal(accountEmail(c, "claude", "never-saved"), null);
  rmSync(r, { recursive: true, force: true });
});

test("accountFingerprint: the same login saved twice is a detectable duplicate; distinct logins differ", () => {
  const r = mkdtempSync(join(tmpdir(), "agecs-fp-"));
  mkdirSync(join(r, "active"), { recursive: true });
  const c = {
    activeDirs: { claude: join(r, "active") }, vaultDir: join(r, "vault"), transcriptsDir: join(r, "t"),
    providers: { claude: { credFile: ".credentials.json", identityField: "organizationUuid", accounts: ["d1", "d2", "d3"] } },
  };
  const cred = (t) => JSON.stringify({ claudeAiOauth: { accessToken: t, refreshToken: "r" + t }, organizationUuid: "O" });
  writeFileSync(activePath(c, "claude"), cred("SAME")); capture(c, "claude", "d1"); capture(c, "claude", "d2");
  writeFileSync(activePath(c, "claude"), cred("DIFF")); capture(c, "claude", "d3");
  assert.equal(accountFingerprint(c, "claude", "d1"), accountFingerprint(c, "claude", "d2")); // duplicate login
  assert.notEqual(accountFingerprint(c, "claude", "d1"), accountFingerprint(c, "claude", "d3"));
  assert.equal(accountFingerprint(c, "claude", "missing"), null);
  rmSync(r, { recursive: true, force: true });
});
