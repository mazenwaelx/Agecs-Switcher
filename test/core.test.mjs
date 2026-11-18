import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLimitText, eventText, isLimitEvent, credIdentity, pickNextAccount, earliestReset } from "../lib/core.mjs";

const P = ["5-hour limit", "weekly limit", "usage limit", "limit reached", "rate limit"];

test("detectLimitText: matches each limit phrase", () => {
  for (const s of ["5-hour limit reached", "You hit the weekly limit", "Claude usage limit reached", "rate limit exceeded"])
    assert.equal(detectLimitText(s, P).hit, true, s);
});

test("detectLimitText: no false positive on normal text", () => {
  assert.equal(detectLimitText("All tests passed, task done.", P).hit, false);
  assert.equal(detectLimitText("", P).hit, false);
  assert.equal(detectLimitText(null, P).hit, false);
});

test("detectLimitText: parses a reset epoch when present", () => {
  const r = detectLimitText("usage limit reached. try again at 1900000000", P);
  assert.equal(r.hit, true);
  assert.equal(r.resetEpochMs, 1900000000 * 1000);
});

test("eventText: flattens string and block content", () => {
  assert.equal(eventText({ message: { content: "hello" } }), "hello");
  assert.equal(eventText({ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }), "a b");
  assert.equal(eventText({}), "");
});

test("isLimitEvent: true only when flagged AND text is a limit", () => {
  assert.equal(isLimitEvent({ type: "assistant", isApiErrorMessage: true, message: { content: "5-hour limit reached" } }, P), true);
  assert.equal(isLimitEvent({ message: { isApiErrorMessage: true, content: [{ type: "text", text: "weekly limit" }] } }, P), true);
});

test("isLimitEvent: false when NOT flagged, even if text says limit (no false switch)", () => {
  assert.equal(isLimitEvent({ type: "assistant", message: { content: "the limit reached -> BLD-ST batched same job" } }, P), false);
  assert.equal(isLimitEvent({ type: "user", message: { content: "please fix the rate limit bug" } }, P), false);
});

test("isLimitEvent: flagged but a DIFFERENT api error (overloaded) does not trigger", () => {
  assert.equal(isLimitEvent({ isApiErrorMessage: true, message: { content: "API Error: overloaded_error" } }, P), false);
});

test("credIdentity: uses the identity field, stable across token refresh", () => {
  const a1 = { claudeAiOauth: { accessToken: "AAA", refreshToken: "R1" }, organizationUuid: "org-123" };
  const a1later = { claudeAiOauth: { accessToken: "BBB", refreshToken: "R2" }, organizationUuid: "org-123" };
  const a2 = { claudeAiOauth: { accessToken: "CCC" }, organizationUuid: "org-999" };
  assert.equal(credIdentity(a1, "organizationUuid"), "org-123");
  assert.equal(credIdentity(a1, "organizationUuid"), credIdentity(a1later, "organizationUuid"));
  assert.notEqual(credIdentity(a1, "organizationUuid"), credIdentity(a2, "organizationUuid"));
});

test("credIdentity: falls back to a hash when no identity field", () => {
  assert.match(credIdentity({ token: "x" }, null), /^sha256:/);
  assert.equal(credIdentity(null, null), null);
});

test("pickNextAccount: rotates to a different available account", () => {
  const accounts = ["claude-1", "claude-2", "claude-3"];
  assert.equal(pickNextAccount({ accounts, activeName: "claude-1", cooldownUntil: {}, now: 1000 }), "claude-2");
});

test("pickNextAccount: skips cooling accounts", () => {
  const accounts = ["claude-1", "claude-2", "claude-3"];
  const cd = { "claude-1": 5000, "claude-2": 5000 };
  assert.equal(pickNextAccount({ accounts, activeName: "claude-1", cooldownUntil: cd, now: 1000 }), "claude-3");
});

test("pickNextAccount: returns null when every account is capped", () => {
  const cd = { "claude-1": 9999, "claude-2": 9999 };
  assert.equal(pickNextAccount({ accounts: ["claude-1", "claude-2"], activeName: "claude-1", cooldownUntil: cd, now: 1000 }), null);
});

test("pickNextAccount: cooldown expires -> account available again", () => {
  const accounts = ["claude-1", "claude-2"];
  const cd = { "claude-2": 2000 };
  assert.equal(pickNextAccount({ accounts, activeName: "claude-1", cooldownUntil: cd, now: 1000 }), "claude-1");
  assert.equal(pickNextAccount({ accounts, activeName: "claude-1", cooldownUntil: cd, now: 3000 }), "claude-2");
});

test("pickNextAccount: single free account returns itself", () => {
  assert.equal(pickNextAccount({ accounts: ["solo"], activeName: "solo", cooldownUntil: {}, now: 1 }), "solo");
});

test("earliestReset: soonest cooldown, 0 when none", () => {
  assert.equal(earliestReset({ a: 5000, b: 3000 }), 3000);
  assert.equal(earliestReset({}), 0);
});
