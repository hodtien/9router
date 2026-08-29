// Ensure better-sqlite3 is installed in USER_DATA_DIR/runtime/node_modules
// (user-writable, avoids Windows EBUSY locks during npm i -g updates).
// sql.js is bundled in bin/app already; node:sqlite / bun:sqlite are built-in.
const fs = require("fs");
const path = require("path");
const {
  ensureRuntimeDir,
  getRuntimeDir,
  getRuntimeNodeModules,
  installRuntimePackages,
  runNpmInstall,
  summarizeNpmError,
} = require("./runtimeInstall");

// Gate the pinned version by Node major, mirroring src/lib/db/driver.js gating
// style: 13.x is N-API and ships per-platform prebuilds inside the package, so
// it needs no ABI-specific download. It requires Node >= 22; older runtimes stay
// on 12.6.2, which fetches an ABI-specific binary via prebuild-install.
const [NODE_MAJOR] = process.versions.node.split(".").map(Number);
const USE_NAPI_BUILD = NODE_MAJOR >= 22;
const BETTER_SQLITE3_VERSION = USE_NAPI_BUILD ? "13.0.3" : "12.6.2";
const SQL_JS_VERSION = "1.14.1";

function hasModule(name) {
  return fs.existsSync(path.join(getRuntimeNodeModules(), name, "package.json"));
}

function isGlibcRuntime() {
  try { return Boolean(process.report?.getReport()?.header?.glibcVersionRuntime); } catch { return true; }
}

// 12.x compiles/downloads into build/Release; 13.x ships prebuilds/<platform>-<arch>.node.
function getBetterSqliteBinary() {
  const root = path.join(getRuntimeNodeModules(), "better-sqlite3");
  const platform = process.platform === "linux" && !isGlibcRuntime() ? "linuxmusl" : process.platform;
  return [
    path.join(root, "build", "Release", "better_sqlite3.node"),
    path.join(root, "prebuilds", `${platform}-${process.arch}.node`),
  ].find((file) => fs.existsSync(file));
}

function isBetterSqliteBinaryValid() {
  const binary = getBetterSqliteBinary();
  if (!binary) return false;
  try {
    const fd = fs.openSync(binary, "r");
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    const magic = buf.toString("hex");
    if (process.platform === "linux") return magic.startsWith("7f454c46");
    if (process.platform === "darwin") return magic.startsWith("cffaedfe") || magic.startsWith("cefaedfe");
    if (process.platform === "win32") return magic.startsWith("4d5a");
    return true;
  } catch { return false; }
}

// Public: ensure better-sqlite3 native module is installed in user-writable
// runtime dir. sql.js may be bundled in bin/app, but npm publish strips .wasm
// from nested node_modules — verify and reinstall if missing. node:sqlite is
// built-in. This is purely a *speed optimization* — app works without
// better-sqlite3 via fallbacks.
function isSqlJsWasmValid() {
  const bundledWasm = path.join(__dirname, "..", "app", "node_modules", "sql.js", "dist", "sql-wasm.wasm");
  if (fs.existsSync(bundledWasm)) return true;
  const runtimeWasm = path.join(getRuntimeNodeModules(), "sql.js", "dist", "sql-wasm.wasm");
  return fs.existsSync(runtimeWasm);
}

function ensureSqliteRuntime({ silent = false } = {}) {
  ensureRuntimeDir();

  let sqlJsOk = isSqlJsWasmValid();
  if (!sqlJsOk) {
    sqlJsOk = installRuntimePackages([`sql.js@${SQL_JS_VERSION}`], {
      silent,
      label: "sql.js fallback",
      failureTitle: "sql.js install failed",
      failureHint: "SQLite fallback unavailable",
    });
    if (sqlJsOk) sqlJsOk = isSqlJsWasmValid();
  }

  const needBetterSqlite = !hasModule("better-sqlite3") || !isBetterSqliteBinaryValid();
  if (!needBetterSqlite) {
    if (!silent) console.log("✅ SQLite engine ready");
    return { betterSqlite: true, sqlJs: sqlJsOk };
  }

  // npm injects an implicit `node-gyp rebuild` for any package carrying a
  // binding.gyp, which would demand build tools even though 13.x already bundles
  // the binary — skip scripts so the bundled prebuild is used as-is.
  const ok = installRuntimePackages([`better-sqlite3@${BETTER_SQLITE3_VERSION}`], {
    silent,
    label: "SQLite engine",
    failureTitle: "SQLite engine install failed — using fallback",
    failureHint: "using fallback",
    extraArgs: USE_NAPI_BUILD ? ["--ignore-scripts"] : [],
  });
  return {
    betterSqlite: ok && hasModule("better-sqlite3") && isBetterSqliteBinaryValid(),
    sqlJs: sqlJsOk,
  };
}

// Inject runtime + bundled node_modules into NODE_PATH so child Node processes
// resolve sql.js (bundled in bin/app/node_modules) and better-sqlite3 (runtime).
function buildEnvWithRuntime(baseEnv = process.env) {
  const runtimeNm = getRuntimeNodeModules();
  const bundledNm = path.join(__dirname, "..", "app", "node_modules");
  const existing = baseEnv.NODE_PATH || "";
  const NODE_PATH = [runtimeNm, bundledNm, existing].filter(Boolean).join(path.delimiter);
  return { ...baseEnv, NODE_PATH };
}

module.exports = {
  ensureSqliteRuntime,
  buildEnvWithRuntime,
  getRuntimeDir,
  getRuntimeNodeModules,
  runNpmInstall,
  summarizeNpmError,
};
