#!/bin/bash
# Custom post-remove for OpenCut (mirrors electron-builder default postrm).

BIN_NAME="opencut-linux"

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove "${BIN_NAME}" "/usr/bin/${BIN_NAME}" || true
else
    rm -f "/usr/bin/${BIN_NAME}"
fi

exit 0
