#!/bin/bash
# Custom post-remove for OpenCut (mirrors electron-builder default postrm).

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove 'opencut-desktop' '/usr/bin/opencut-desktop' || true
else
    rm -f '/usr/bin/opencut-desktop'
fi

exit 0
