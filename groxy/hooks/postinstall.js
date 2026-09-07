#!/usr/bin/env node

// Postinstall: warm-up SQLite deps into ~/.groxy/runtime so the first
// `groxy` start doesn't need network. Failure here is non-fatal —
// cli.js will retry at runtime if anything is missing.
const { ensureSqliteRuntime } = require("./sqliteRuntime");
const { ensureTrayRuntime } = require("./trayRuntime");

try {
  ensureSqliteRuntime({ silent: false });
  console.log("[groxy] runtime SQLite deps ready");
} catch (e) {
  console.warn(`[groxy] runtime warm-up skipped: ${e.message}`);
}

try {
  ensureTrayRuntime({ silent: false });
} catch (e) {
  console.warn(`[groxy] tray runtime skipped: ${e.message}`);
}

process.exit(0);