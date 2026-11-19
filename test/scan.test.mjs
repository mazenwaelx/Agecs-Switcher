// Every edge of the "did we hit a limit this run?" decision, on FAKE transcript
// data: the exact logic agecs.mjs runs each poll (scanLimitLines + parseResetEpoch).
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanLimitLines, parseResetEpoch } from "../lib/core.mjs";

const P = ["5-hour limit", "weekly limit", "usage limit", "limit reached", "rate limit"];
const line = (o) => JSON.stringify(o) + "\n";
const iso = (ms) => new Date(ms).toISOString();
const FUTURE = 1900000000;            // epoch seconds, year 2030
const FUTURE_MS = FUTURE * 1000;

test("real flagged limit event is detected", () => {
  const hit = scanLimitLines(line({ uuid: "a", isApiErrorMessage: true, message: { content: "Claude usage limit reached" } }), { patterns: P });
  assert.ok(hit);
  assert.equal(hit.event.uuid, "a");
});

test("flagged but non-limit error (overloaded) is ignored", () => {
  assert.equal(scanLimitLines(line({ uuid: "o", isApiErrorMessage: true, message: { content: "API Error: overloaded_error" } }), { patterns: P }), null);
});

test("unflagged 'limit' text does NOT switch (no false positive)", () => {
  const text = line({ uuid: "u", type: "assistant", message: { content: "fixed the rate limit reached bug" } });
  assert.equal(scanLimitLines(text, { patterns: P }), null);
});

test("event older than launchTs is skipped even if it is a real limit", () => {
  const launchTs = 1_000_000;
  const old = line({ uuid: "old", isApiErrorMessage: true, timestamp: iso(launchTs - 5000), message: { content: "weekly limit" } });
  assert.equal(scanLimitLines(old, { patterns: P, launchTs }), null);
});

test("event at/after launchTs with no timestamp is still considered", () => {
  const launchTs = 1_000_000;
  const hit = scanLimitLines(line({ uuid: "n", isApiErrorMessage: true, message: { content: "5-hour limit" } }), { patterns: P, launchTs });
  assert.ok(hit, "no timestamp => not treated as old");
});

test("dedup: the same uuid across two poll chunks fires only once", () => {
  const seen = new Set();
  const ev = line({ uuid: "dup", isApiErrorMessage: true, message: { content: "usage limit reached" } });
  assert.ok(scanLimitLines(ev, { patterns: P, seen }), "first poll sees it");
  assert.equal(scanLimitLines(ev, { patterns: P, seen }), null, "second poll skips it");
});

test("malformed JSON lines are skipped; a valid limit after them still fires", () => {
  const text = "{not json\n" + "\n" + line({ uuid: "ok", isApiErrorMessage: true, message: { content: "weekly limit" } });
  const hit = scanLimitLines(text, { patterns: P });
  assert.equal(hit.event.uuid, "ok");
});

test("returns the FIRST limit event when several are present", () => {
  const text =
    line({ uuid: "chat", type: "user", message: { content: "keep going" } }) +
    line({ uuid: "first", isApiErrorMessage: true, message: { content: "usage limit reached" } }) +
    line({ uuid: "second", isApiErrorMessage: true, message: { content: "5-hour limit" } });
  assert.equal(scanLimitLines(text, { patterns: P }).event.uuid, "first");
});

test("empty / whitespace input returns null", () => {
  assert.equal(scanLimitLines("", { patterns: P }), null);
  assert.equal(scanLimitLines("   \n\n  ", { patterns: P }), null);
});

test("reset epoch: future in event -> used; past -> null; absent -> null", () => {
  const now = Date.now();
  const future = scanLimitLines(line({ uuid: "f", isApiErrorMessage: true, message: { content: `usage limit reached. reset at ${FUTURE}` } }), { patterns: P, now });
  assert.equal(future.resetEpochMs, FUTURE_MS);

  const past = scanLimitLines(line({ uuid: "p", isApiErrorMessage: true, message: { content: "usage limit reached. reset at 1000000000" } }), { patterns: P, now });
  assert.equal(past.resetEpochMs, null);

  const none = scanLimitLines(line({ uuid: "x", isApiErrorMessage: true, message: { content: "usage limit reached" } }), { patterns: P, now });
  assert.equal(none.resetEpochMs, null);
});

test("parseResetEpoch: honors the passed `now` boundary", () => {
  assert.equal(parseResetEpoch({ t: "reset 1900000000" }, FUTURE_MS - 1), FUTURE_MS);
  assert.equal(parseResetEpoch({ t: "reset 1900000000" }, FUTURE_MS + 1), null);
  assert.equal(parseResetEpoch({ t: "no epoch here" }), null);
});
