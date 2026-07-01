#!/bin/bash
# Custom post-install for OpenCut.
# Replicates electron-builder's default behaviour (binary symlink + system DB
# refresh) and then applies the sandbox fixes needed on modern Linux (Ubuntu
# 24.04+/26.04) where unprivileged user namespaces are restricted by AppArmor.

set -e

APP_DIR="/opt/OpenCut"
BIN_NAME="opencut-linux"
BIN_PATH="${APP_DIR}/${BIN_NAME}"
DESKTOP_FILE="/usr/share/applications/${BIN_NAME}.desktop"

# --- Binary symlink (default electron-builder logic) ------------------------
if type update-alternatives 2>/dev/null >&1; then
    if [ -L "/usr/bin/${BIN_NAME}" ] && [ -e "/usr/bin/${BIN_NAME}" ] && [ "$(readlink "/usr/bin/${BIN_NAME}")" != "/etc/alternatives/${BIN_NAME}" ]; then
        rm -f "/usr/bin/${BIN_NAME}"
    fi
    update-alternatives --install "/usr/bin/${BIN_NAME}" "${BIN_NAME}" "${BIN_PATH}" 100 || ln -sf "${BIN_PATH}" "/usr/bin/${BIN_NAME}"
else
    ln -sf "${BIN_PATH}" "/usr/bin/${BIN_NAME}"
fi

# --- Sandbox fix ------------------------------------------------------------
# Configure the Chromium setuid sandbox helper correctly (owned by root, mode
# 4755). This is the officially recommended configuration and lets the sandbox
# work even when unprivileged user namespaces are disabled.
if [ -f "${APP_DIR}/chrome-sandbox" ]; then
    chown root:root "${APP_DIR}/chrome-sandbox" || true
    chmod 4755 "${APP_DIR}/chrome-sandbox" || true
fi

# As a guaranteed fallback (some kernels/AppArmor profiles still block the
# sandbox), ensure the desktop launcher starts the app with --no-sandbox. This
# is safe here: the app only ever loads its own bundled content from localhost.
if [ -f "${DESKTOP_FILE}" ] && ! grep -q -- '--no-sandbox' "${DESKTOP_FILE}"; then
    sed -i "s|^Exec=\(.*\)/${BIN_NAME}\(.*\)$|Exec=\1/${BIN_NAME} --no-sandbox\2|" "${DESKTOP_FILE}" || true
fi

# --- System database refresh (default electron-builder logic) ---------------
if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi
if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

exit 0
