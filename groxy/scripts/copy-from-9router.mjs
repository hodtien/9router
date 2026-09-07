#!/usr/bin/env node
// Copy the existing 9router data dir (~/.9router) into the groxy data dir
// (~/.groxy). Refuses if 9router or groxy is currently bound to a port, and
// if the destination already exists, exits without overwriting unless
// --force is passed.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SRC = process.env.GROXY_SRC_DIR || join(homedir(), ".9router");
const DST = process.env.GROXY_DATA_DIR || join(homedir(), ".groxy");
const FORCE = process.argv.includes("--force");

function die(msg, code = 1) {
  console.error(`❌ ${msg}`);
  process.exit(code);
}

if (!existsSync(SRC)) die(`Source not found: ${SRC}`);
if (!statSync(SRC).isDirectory()) die(`Source is not a directory: ${SRC}`);

if (existsSync(DST)) {
  if (!FORCE) die(`Destination already exists: ${DST} (use --force to overwrite)`);
  console.log(`--force: overwriting ${DST}`);
}

if (!existsSync(DST)) mkdirSync(DST, { recursive: true });

// Best-effort port check: refuse if 9router is listening on 20128 or groxy on 20138.
function portInUse(port) {
  try {
    const out = spawnSync("lsof", ["-ti", String(port)], { encoding: "utf8" }).stdout.trim();
    return !!out;
  } catch {
    return false;
  }
}

if (portInUse(20128)) die("9router is currently running on :20128 — stop it before copying.");
if (portInUse(20138)) die("Groxy is already running on :20138 — stop it before copying.");

console.log(`Copying ${SRC} → ${DST} ...`);
const r = spawnSync("cp", ["-a", `${SRC}/.`, DST], { stdio: "inherit" });
if (r.status !== 0) die(`cp exited with status ${r.status}`);

console.log("✅ Done. Next: npm start (or `node groxy/cli.js`) on port 20138.");