# Groxy

A rebrand/fork of [9router](https://github.com/decolua/9router) that runs as
the binary `groxy` on port **20138**, with state isolated under `~/.groxy`
(override with `GROXY_DATA_DIR`).

Reuses the 9router Next.js standalone build that already lives in this repo at
`cli/app/` — no separate `npm run build` needed.

## First run

```bash
# 1. One-time import existing 9router data (settings, accounts, OAuth tokens, runtime deps)
node groxy/scripts/copy-from-9router.mjs
# Add --force to overwrite an existing ~/.groxy

# 2. Start on port 20138 (no browser, in foreground)
node groxy/cli.js --no-browser -p 20138

# Or background (system tray)
node groxy/cli.js --tray --skip-update -p 20138
```

## Layout

```
groxy/
  cli.js              # launcher (Node CLI; mirrors cli/cli.js, rebranded)
  package.json        # bin "groxy" → ./cli.js
  hooks/
    runtimeInstall.js # shared user-data-dir helpers (copy of 9router's)
    sqliteRuntime.js
    trayRuntime.js
    postinstall.js    # warm-up SQLite/tray deps on install
  scripts/
    copy-from-9router.mjs
```

## Configuration overrides

| Env var | Default | Purpose |
|---|---|---|
| `GROXY_DATA_DIR` | `~/.groxy` | State + runtime deps location |
| `GROXY_STANDALONE_DIR` | `<repo>/cli/app` | Next.js standalone build to launch |
| `GROXY_SRC_DIR` | `~/.9router` | Source dir for `copy-from-9router.mjs` |

`PORT` / `HOSTNAME` flow through to the Next.js server as in 9router.