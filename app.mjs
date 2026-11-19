#!/usr/bin/env node
// AGECS Switcher as a desktop APP (not a browser tab): starts the local control
// server on a random port and opens the UI in a dedicated Edge/Chrome *app window*
// — its own window, no tabs, no address bar, own taskbar icon. Closing the window
// quits the app. No Electron, no dependencies. Falls back to the default browser.
import { makeServer } from "./server.mjs";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const isWin = process.platform === "win32";
const env = (k) => process.env[k];

// First Edge/Chrome we can find (Edge ships on Win10/11). null -> default browser.
function findBrowser() {
  const c = isWin
    ? [
        join(env("ProgramFiles(x86)") || "", "Microsoft/Edge/Application/msedge.exe"),
        join(env("ProgramFiles") || "", "Microsoft/Edge/Application/msedge.exe"),
        join(env("ProgramFiles") || "", "Google/Chrome/Application/chrome.exe"),
        join(env("ProgramFiles(x86)") || "", "Google/Chrome/Application/chrome.exe"),
        join(env("LOCALAPPDATA") || "", "Google/Chrome/Application/chrome.exe"),
      ]
    : ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/microsoft-edge"];
  return c.find((p) => p && existsSync(p)) || null;
}

const server = makeServer();
server.listen(0, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  const browser = findBrowser();
  if (!browser) {
    console.log(`AGECS Switcher running at ${url} (no Edge/Chrome found — opening your default browser).`);
    if (isWin) spawn("cmd", ["/c", "start", "", url]);
    return; // server keeps running; close this window/terminal to quit
  }
  // Dedicated profile => its own browser process, so the window's lifetime is ours
  // to track (and it won't touch your normal browsing profile).
  const profile = join(homedir(), ".agecs-switcher", "app-profile");
  mkdirSync(profile, { recursive: true });
  const win = spawn(browser, [`--app=${url}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check"], { stdio: "ignore" });
  console.log(`AGECS Switcher app window opened. (${url}) — close the window to quit.`);
  win.on("error", () => { console.log(`could not launch the app window; open ${url} in a browser.`); });
  win.on("exit", () => { server.close(); process.exit(0); });
});
