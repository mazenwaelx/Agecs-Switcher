// AGECS Reloader — companion VS Code extension.
// AGECS Switcher writes a timestamp to ~/.agecs-switcher/reload.signal whenever it
// swaps the active Claude account. This reloads the VS Code window so the Claude
// Code panel re-reads the new login.
//
// Pair with these settings so the panel RESUMES your conversation on the new
// account and keeps working by itself:
//   VS Code setting:            "claudeCode.continueAfterReload": true
//   ~/.claude/settings.json:    "autoContinueAtUsageLimit": true
const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");

function activate(context) {
  const signal = path.join(os.homedir(), ".agecs-switcher", "reload.signal");
  try { fs.mkdirSync(path.dirname(signal), { recursive: true }); } catch { /* ignore */ }

  // Remember the current value so we don't reload on the signal that already exists
  // at startup (and don't loop: after a reload we re-read the same value).
  let last = readTs(signal);

  fs.watchFile(signal, { interval: 1000 }, () => {
    const v = readTs(signal);
    if (v > last) {
      last = v;
      vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  });

  context.subscriptions.push({ dispose: () => fs.unwatchFile(signal) });
}

function readTs(f) { try { return Number(fs.readFileSync(f, "utf8").trim()) || 0; } catch { return 0; } }

function deactivate() {}

module.exports = { activate, deactivate };
