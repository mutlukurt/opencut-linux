#!/usr/bin/env bash
#
# Reproducible build of the OpenCut Linux .deb package.
#
# It fetches the pinned OpenCut "classic" source, applies the small patches
# required for an offline desktop build, produces a Next.js standalone server,
# and packages everything into a .deb via electron-builder.
#
# Usage:
#   bash scripts/build-deb.sh
#
# Requirements: git, node, npm, and bun (auto-installed if missing).

set -euo pipefail

# --- Config -----------------------------------------------------------------
# Pinned upstream commit for a reproducible build.
OPENCUT_REPO="https://github.com/opencut-app/opencut-classic"
OPENCUT_COMMIT="cf5e79e919144200294fb9fed22a222592a0aeea"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="${ROOT_DIR}/.opencut-src"
WEB_DIR="${SRC_DIR}/apps/web"

cd "${ROOT_DIR}"

echo "==> OpenCut Linux — reproducible .deb build"

# --- Ensure bun -------------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  if [ -x "${HOME}/.bun/bin/bun" ]; then
    export PATH="${HOME}/.bun/bin:${PATH}"
  else
    echo "==> Installing bun..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="${HOME}/.bun/bin:${PATH}"
  fi
fi
echo "==> bun $(bun --version)"

# --- Fetch pinned upstream source ------------------------------------------
if [ ! -d "${SRC_DIR}/.git" ]; then
  echo "==> Fetching OpenCut classic @ ${OPENCUT_COMMIT}"
  rm -rf "${SRC_DIR}"
  mkdir -p "${SRC_DIR}"
  git -C "${SRC_DIR}" init -q
  git -C "${SRC_DIR}" remote add origin "${OPENCUT_REPO}"
  git -C "${SRC_DIR}" fetch -q --depth 1 origin "${OPENCUT_COMMIT}"
  git -C "${SRC_DIR}" checkout -q FETCH_HEAD
else
  echo "==> Reusing existing source checkout in ${SRC_DIR}"
fi

# --- Apply packaging patches (idempotent) -----------------------------------
echo "==> Applying patches"
git -C "${SRC_DIR}" checkout -q -- .
git -C "${SRC_DIR}" apply "${ROOT_DIR}/patches/opencut-classic-fixes.patch"

# --- Build-time environment -------------------------------------------------
# The upstream app validates a set of env vars at build/runtime via a Zod
# schema. For an offline desktop build these online services are unused; safe
# local placeholders satisfy the schema. (The runtime values are re-injected by
# the Electron wrapper in main.js.)
cat > "${WEB_DIR}/.env.local" <<'EOF'
NODE_ENV=production
NEXT_TELEMETRY_DISABLED=1
NEXT_PUBLIC_SITE_URL=http://localhost:3000
NEXT_PUBLIC_MARBLE_API_URL=https://api.marblecms.com
DATABASE_URL=postgresql://opencut:opencut@localhost:5432/opencut
BETTER_AUTH_SECRET=opencut-desktop-local-secret-0123456789abcdef
UPSTASH_REDIS_REST_URL=http://127.0.0.1:8079
UPSTASH_REDIS_REST_TOKEN=opencut-desktop-local-token
MARBLE_WORKSPACE_KEY=opencut-desktop
FREESOUND_CLIENT_ID=opencut-desktop
FREESOUND_API_KEY=opencut-desktop
EOF

# --- Install & build the web app -------------------------------------------
echo "==> Installing web dependencies (bun install)"
( cd "${SRC_DIR}" && bun install )

echo "==> Building the web app (next build --> standalone)"
( cd "${WEB_DIR}" && bun run build )

# --- Assemble the standalone runtime ---------------------------------------
echo "==> Assembling standalone runtime"
rm -rf "${ROOT_DIR}/runtime"
cp -r "${WEB_DIR}/.next/standalone" "${ROOT_DIR}/runtime"
cp -r "${WEB_DIR}/.next/static" "${ROOT_DIR}/runtime/apps/web/.next/static"
cp -r "${WEB_DIR}/public" "${ROOT_DIR}/runtime/apps/web/public"

# --- Install packaging deps & build the .deb -------------------------------
echo "==> Installing packaging dependencies (npm install)"
( cd "${ROOT_DIR}" && npm install --no-audit --no-fund )

echo "==> Building .deb (electron-builder)"
( cd "${ROOT_DIR}" && ./node_modules/.bin/electron-builder --linux deb )

echo ""
echo "==> Done. Artifact(s):"
ls -lh "${ROOT_DIR}/out/"*.deb
