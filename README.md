# OpenCut for Linux (`.deb`)

**Unofficial community Linux desktop build of [OpenCut](https://github.com/OpenCut-app/OpenCut)** — a free and open source video editor (the open-source CapCut alternative).

> Packaged from the archived [`opencut-classic`](https://github.com/OpenCut-app/opencut-classic) codebase — the version that currently works as a full editor. The main OpenCut project lives at **<https://github.com/OpenCut-app/OpenCut>**.

This project wraps the OpenCut web editor in a self-contained [Electron](https://www.electronjs.org/) desktop application and ships it as an installable Debian/Ubuntu `.deb` package. It runs **fully offline and local-first**: your videos and projects never leave your device.

> **Disclaimer:** This is an unofficial, community-maintained package. It is **not** produced, endorsed by, or affiliated with the OpenCut project. "OpenCut" belongs to its respective owners; the name is used only to identify the upstream software being packaged.

---

## Highlights

- **One-click desktop app** — install the `.deb`, launch "OpenCut" from your applications menu.
- **Works offline** — no account, no server, no internet required to edit.
- **Local-first persistence** — projects are auto-saved to your device and **kept until you delete them**, even if the app is force-closed or crashes (see below).
- **No system Node.js required** — the app runs its bundled server with Electron's built-in Node runtime.
- **Modern-Linux friendly** — handles the Chromium sandbox correctly on Ubuntu 24.04 / 26.04 (AppArmor `unprivileged_userns` restrictions) and Wayland sessions.

## Install

Download the latest `.deb` from the [Releases](https://github.com/mutlukurt/opencut-linux/releases) page, then:

```sh
sudo apt install ./OpenCut_*_amd64.deb
```

Launch **OpenCut** from your applications menu. To remove it:

```sh
sudo apt remove opencut-desktop
```

**Supported:** x86_64 (amd64), Debian/Ubuntu-based distributions.

## Local-first persistence

The OpenCut editor stores everything in the browser engine's local storage:

- **Projects, scenes and timelines** → IndexedDB
- **Imported media files** → OPFS (Origin Private File System)

The editor auto-saves changes (debounced) and only ever removes data when **you** delete a project. This desktop build makes that durable across restarts by:

1. **Using a stable local origin** (a fixed localhost port), so previously saved
   projects remain reachable after every relaunch.
2. **Granting persistent storage**, so the engine never evicts your data under
   storage pressure.
3. **Cleaning up orphaned background servers** left by a hard crash, without
   touching your data.

Result: closing the window (including via the ✕ button), quitting, or even a
force-kill will **not** lose your projects — they stay until you delete them.

## Build from source

The build is reproducible: it fetches a pinned OpenCut commit, applies small
packaging patches, builds the web app into a standalone server, and packages it.

**Requirements:** `git`, `node` + `npm`, and `bun` (auto-installed if missing).

```sh
git clone https://github.com/mutlukurt/opencut-linux.git
cd opencut-linux
npm run build
# -> out/OpenCut_<version>_amd64.deb
```

### What the patches change

`patches/opencut-classic-fixes.patch` applies three minimal, runtime-safe fixes
to the pinned upstream snapshot so it can produce an offline standalone build:

1. Implements a missing `isShortcutKey` type guard in the keybindings module.
2. Implements a missing `isActionWithOptionalArgs` type guard in the actions module.
3. Skips the blocking TypeScript type-check gate during `next build`
   (`typescript.ignoreBuildErrors`). These are type-only mismatches in the
   upstream snapshot and do not affect the emitted runtime JavaScript.

None of these change the license or behavior of the upstream code.

## Project layout

```
main.js                              Electron main process (server bootstrap + window)
package.json                         electron-builder configuration
build/icon.png                       Application icon
build/after-install.sh               .deb post-install (sandbox + launcher setup)
build/after-remove.sh                .deb post-remove cleanup
patches/opencut-classic-fixes.patch  Packaging patches applied to upstream
scripts/build-deb.sh                 Reproducible build entry point
licenses/OpenCut-LICENSE             Upstream OpenCut MIT license (preserved)
LICENSE                              Packaging license (MIT)
NOTICE                               Attribution and third-party notices
```

## Credits & license

- **OpenCut** (the editor) — © 2025-2026 OpenCut, MIT.
  Project: <https://github.com/OpenCut-app/OpenCut> ·
  Packaged source (archived): <https://github.com/OpenCut-app/opencut-classic>
- **Linux packaging** (this repository) — © 2026 [Mutlu Kurt (@mutlukurt)](https://github.com/mutlukurt), MIT.

Both the upstream software and this packaging are distributed under the MIT
License. See [`LICENSE`](LICENSE), [`NOTICE`](NOTICE), and
[`licenses/OpenCut-LICENSE`](licenses/OpenCut-LICENSE).
