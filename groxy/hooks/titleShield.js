// Preloaded via `node --require` before the Next.js standalone server starts.
// 9router's killAllAppProcesses() sweeps any ps line containing "next-server",
// and Next.js calls `process.title = "next-server (vX)"` at boot. Since
// process.title is a plain data property on this Node, we can't intercept
// the assignment; instead we poll and restore our own title if Next changed it.
// Node 26 / macOS: assigning to process.title updates the OS-visible argv,
// so ps aux reflects the new name immediately.
const WANTED = "groxy-server";
process.title = WANTED;
setInterval(() => {
  if (/next-server/.test(String(process.title))) {
    process.title = WANTED;
  }
}, 2000);
