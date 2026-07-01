"use strict";

const { app, BrowserWindow, shell, dialog, Menu, session } = require("electron");
const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");

// ---------------------------------------------------------------------------
// Sandbox / platform handling
//
// Modern Ubuntu (24.04+/26.04) restricts unprivileged user namespaces through
// AppArmor (`kernel.apparmor_restrict_unprivileged_userns=1`). This breaks
// Chromium's default sandbox and causes the window to silently fail to open
// when the app is launched from the desktop menu. Because this is a local,
// self-contained desktop application that only ever loads its own bundled
// content from 127.0.0.1, disabling the Chromium sandbox is safe here and makes
// the app launch reliably regardless of how it is started.
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-gpu-sandbox");
app.commandLine.appendSwitch("disable-setuid-sandbox");
// Some environments expose a tiny /dev/shm; fall back to /tmp so the renderer
// cannot crash on shared-memory allocation.
app.commandLine.appendSwitch("disable-dev-shm-usage");
// Prefer the native platform (Wayland when available, otherwise X11). Ubuntu
// 26.04 defaults to Wayland; without this hint some setups fail to present a
// window.
app.commandLine.appendSwitch("ozone-platform-hint", "auto");

// GPU presentation reliability.
//
// On many Linux setups (especially Wayland with Mesa drivers) Chromium renders
// the page correctly but fails to *present* the composited frame to the window,
// leaving a fully black window even though the UI is loaded. Disabling hardware
// acceleration switches Electron to software compositing, which is presented via
// a plain shared-memory buffer — a much more reliable path that fixes the black
// window on affected systems. Users with a known-good GPU can opt back into
// hardware acceleration by launching with OPENCUT_ENABLE_GPU=1.
if (process.env.OPENCUT_ENABLE_GPU === "1") {
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
} else {
  app.disableHardwareAcceleration();
}

// ---------------------------------------------------------------------------
// Logging (persisted so users can share it if something goes wrong)
// ---------------------------------------------------------------------------

const logFile = path.join(os.tmpdir(), "opencut-desktop.log");
try {
  fs.writeFileSync(logFile, `OpenCut desktop log — ${new Date().toISOString()}\n`);
} catch {
  /* ignore */
}
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(logFile, line);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const isDev = !app.isPackaged;

const runtimeRoot = isDev
  ? path.join(__dirname, "runtime")
  : path.join(process.resourcesPath, "runtime");

const serverDir = path.join(runtimeRoot, "apps", "web");
const serverEntry = path.join(serverDir, "server.js");

// Local-first persistence depends on a STABLE web origin. Browser storage
// (IndexedDB for projects/scenes and OPFS for media files) is scoped per origin
// — i.e. per scheme://host:port. If the port changed on every launch, the
// origin would change and previously saved projects would become unreachable
// (appearing "lost"). Using a fixed, uncommon port keeps the origin constant so
// projects persist across restarts and force-quits until the user deletes them.
const FIXED_PORT = 37650;

// The upstream web app validates a set of environment variables at runtime via
// a Zod schema. For a local, offline desktop build these online services are
// not used, but the variables must still be present and well-formed so the
// editor pages can render. We inject safe local placeholders.
const serverEnvDefaults = {
  NODE_ENV: "production",
  NEXT_TELEMETRY_DISABLED: "1",
  HOSTNAME: "127.0.0.1",
  NEXT_PUBLIC_MARBLE_API_URL: "https://api.marblecms.com",
  DATABASE_URL: "postgresql://opencut:opencut@localhost:5432/opencut",
  BETTER_AUTH_SECRET: "opencut-desktop-local-secret-0123456789abcdef",
  UPSTASH_REDIS_REST_URL: "http://127.0.0.1:8079",
  UPSTASH_REDIS_REST_TOKEN: "opencut-desktop-local-token",
  MARBLE_WORKSPACE_KEY: "opencut-desktop",
  FREESOUND_CLIENT_ID: "opencut-desktop",
  FREESOUND_API_KEY: "opencut-desktop",
};

let serverProcess = null;
let mainWindow = null;
let appPort = 0;
let appReady = false;

// ---------------------------------------------------------------------------
// Loading / error screens shown inside the window
// ---------------------------------------------------------------------------

function screenHtml(title, subtitle, spinner) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>OpenCut</title>
<style>
  html,body{height:100%;margin:0}
  body{background:#0f0f0f;color:#e5e5e5;font-family:Inter,system-ui,Segoe UI,Roboto,sans-serif;
       display:flex;align-items:center;justify-content:center;flex-direction:column;gap:18px}
  .t{font-size:20px;font-weight:600;letter-spacing:.3px}
  .s{font-size:13px;color:#9a9a9a;max-width:520px;text-align:center;line-height:1.5;padding:0 24px}
  .sp{width:34px;height:34px;border:3px solid #2a2a2a;border-top-color:#e5e5e5;border-radius:50%;
      animation:r 0.9s linear infinite;display:${spinner ? "block" : "none"}}
  @keyframes r{to{transform:rotate(360deg)}}
</style></head>
<body><div class="sp"></div><div class="t">${title}</div><div class="s">${subtitle}</div></body></html>`)}`;
}

const LOADING_SCREEN = screenHtml(
  "OpenCut başlatılıyor…",
  "Video düzenleyici motoru hazırlanıyor, birkaç saniye sürebilir.",
  true,
);

function errorScreen(message) {
  return screenHtml(
    "OpenCut başlatılamadı",
    `${message}<br><br>Log dosyası: ${logFile}`,
    false,
  );
}

// ---------------------------------------------------------------------------
// Server helpers
// ---------------------------------------------------------------------------

// If a previous run was force-killed (SIGKILL / crash), the spawned server can
// be left orphaned still holding the fixed port. Find and stop any such stale
// server by matching our unique server.js path in /proc, so each launch runs
// the correct bundled server. This only ever targets our own process.
function killStaleServers() {
  try {
    const pids = fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n));
    for (const pid of pids) {
      if (Number(pid) === process.pid) continue;
      let cmdline = "";
      try {
        cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      } catch {
        continue;
      }
      if (cmdline.includes(serverEntry)) {
        try {
          process.kill(Number(pid), "SIGKILL");
          log("Killed stale server process", pid);
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    // /proc not available (non-Linux); nothing to clean up.
  }
}

function waitForServer(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/projects", timeout: 2000 },
        (res) => {
          res.resume();
          resolve();
        },
      );
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error("Sunucu zamanında başlamadı (timeout)."));
      } else {
        setTimeout(attempt, 300);
      }
    };
    attempt();
  });
}

function startServer(port) {
  const env = {
    ...process.env,
    ...serverEnvDefaults,
    PORT: String(port),
    NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${port}`,
    // Run the Electron binary as a plain Node.js runtime so we do not depend on
    // a system-wide Node installation being present on the user's machine.
    ELECTRON_RUN_AS_NODE: "1",
  };

  log("Starting server:", serverEntry, "on port", port);
  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: serverDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess.stdout.on("data", (d) => log("[server]", String(d).trim()));
  serverProcess.stderr.on("data", (d) => log("[server:err]", String(d).trim()));

  serverProcess.on("exit", (code) => {
    log("Server exited with code", code);
    serverProcess = null;
    if (code && code !== 0 && !app.isQuitting && !appReady && mainWindow) {
      mainWindow.loadURL(
        errorScreen(`Motor beklenmedik şekilde durdu (kod ${code}).`),
      );
    }
  });
}

function stopServer() {
  if (serverProcess) {
    try {
      serverProcess.kill();
    } catch {
      /* ignore */
    }
    serverProcess = null;
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0f0f0f",
    autoHideMenuBar: true,
    // Show immediately so the user always gets visible feedback, even while the
    // background server is still booting.
    show: true,
    icon: path.join(__dirname, "build", "icon.png"),
    title: "OpenCut",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://127.0.0.1")) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (_e, errorCode, errorDesc, validatedURL) => {
      // Ignore aborted loads (-3) which happen during normal navigation.
      if (errorCode === -3) return;
      log("did-fail-load", errorCode, errorDesc, validatedURL);
      if (appReady && appPort) {
        // Transient failure while the app is up — retry shortly.
        setTimeout(() => navigateToApp(), 800);
      }
    },
  );

  let crashCount = 0;
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    crashCount += 1;
    log("render-process-gone", JSON.stringify(details), "count", crashCount);
    if (!mainWindow) return;
    if (crashCount === 1) {
      // First crash: try a plain reload once.
      setTimeout(() => navigateToApp(), 600);
    } else if (crashCount <= 3) {
      mainWindow.loadURL(
        errorScreen(`Görüntüleyici süreci çöktü (${details.reason}).`),
      );
    } else {
      // Give up retrying to avoid an endless crash loop.
      dialog.showErrorBox(
        "OpenCut",
        `Görüntüleyici süreci tekrar tekrar çöküyor (${details.reason}). ` +
          `Grafik sürücüsüyle ilgili olabilir.\n\nLog: ${logFile}`,
      );
    }
  });

  mainWindow.loadURL(LOADING_SCREEN);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function navigateToApp() {
  if (mainWindow && appPort) {
    log("Navigating window to app on port", appPort);
    mainWindow.loadURL(`http://127.0.0.1:${appPort}/projects`);
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);

    // Grant the permissions the editor relies on. This is a local, trusted app
    // that only loads its own bundled content from 127.0.0.1, so it is safe to
    // approve these automatically. Crucially this includes durable storage
    // ("persistent-storage") so the browser never evicts saved projects/media
    // under storage pressure — they stay until the user explicitly deletes them.
    const allow = (permission) =>
      [
        "persistent-storage",
        "clipboard-read",
        "clipboard-sanitized-write",
        "media",
        "fullscreen",
        "notifications",
      ].includes(permission);

    session.defaultSession.setPermissionRequestHandler(
      (_wc, permission, callback) => callback(allow(permission)),
    );
    session.defaultSession.setPermissionCheckHandler((_wc, permission) =>
      allow(permission),
    );

    // Show the window with a loading screen right away.
    createWindow();

    try {
      appPort = FIXED_PORT;
      killStaleServers();
      startServer(appPort);
      // If the fixed port is already served by a leftover instance, waitForServer
      // still succeeds and we simply reuse it (same origin, same data).
      await waitForServer(appPort);
      appReady = true;
      navigateToApp();
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      log("Startup failed:", msg);
      if (mainWindow) mainWindow.loadURL(errorScreen(msg));
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      if (appReady) navigateToApp();
    }
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
    stopServer();
  });

  app.on("quit", stopServer);
}
