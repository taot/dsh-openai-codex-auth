#!/usr/bin/env bash
#
# Provision local build/test resolution for the dsh-openai-codex plugin
# WITHOUT a full pnpm install (peer deps come from a DSH profile at install
# time; here we resolve @deepseek-ai/* and the build toolchain from a
# deepseek-harness checkout).
#
# Usage: scripts/setup-local-dev.sh [/path/to/deepseek-harness]
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="${1:-/home/taot/src-repos/deepseek-harness}"

if [[ ! -d "$REPO/packages/llm/llm" ]]; then
  echo "error: deepseek-harness checkout not found at $REPO" >&2
  exit 1
fi

cd "$HERE"
mkdir -p node_modules/@deepseek-ai node_modules/@types node_modules/.bin

# --- @deepseek-ai/* symlink farm -------------------------------------------
# --- @deepseek-ai/* symlink farm -------------------------------------------
# name -> relative package.json dir under $REPO
declare -A PKGS=(
  [cordis]="vendor/cordis"
  [schemastery]="vendor/schemastery"
  [dsh-llm]="packages/llm/llm"
  [dsh-credentials]="packages/credentials/credentials"
  [dsh-credentials-local]="packages/credentials/credentials-local"
  [dsh-settings]="packages/settings/settings"
  [dsh-host-apiproxy]="packages/host/apiproxy"
  [dsh-client-runtime]="packages/client/runtime"
  [dsh-client-connection]="packages/client/connection"
  [dsh-client-locale]="packages/client/locale"
  [dsh-client-ui-settings]="packages/client/ui-settings"
  [dsh-client-ui-settings-plugins]="packages/client/ui-settings-plugins"
  [dsh-client-ui-slots]="packages/client/ui-slots"
  [dsh-brand]="packages/util/brand"
  [dsh-invariants]="packages/runtime-diagnostics/invariants"
)
for name in "${!PKGS[@]}"; do
  pkg="$REPO/${PKGS[$name]}/package.json"
  if [[ -f "$pkg" ]]; then
    ln -sfn "$(dirname "$pkg")" "node_modules/@deepseek-ai/$name"
  else
    echo "warn: no package.json at $pkg" >&2
  fi
done
unset PKGS

# --- third-party runtime / types --------------------------------------------
ln -sfn "$(ls -d "$REPO/node_modules/.pnpm/react@18.3.1"/node_modules/react 2>/dev/null | head -1)" node_modules/react
ln -sfn "$(ls -d "$REPO/node_modules/.pnpm/@types+react@18.3.31"/node_modules/@types/react 2>/dev/null | head -1)" node_modules/@types/react
ln -sfn "$REPO/node_modules/@types/node" node_modules/@types/node
ln -sfn "$(ls -d "$REPO/node_modules/.pnpm/eventsource-parser@3.1.0"/node_modules/eventsource-parser 2>/dev/null | head -1)" node_modules/eventsource-parser

# --- build toolchain --------------------------------------------------------
ln -sfn "$(ls -d "$REPO/node_modules/.pnpm/tsdown@0.22.2"*/node_modules/tsdown 2>/dev/null | head -1)" node_modules/tsdown
ln -sfn "$(ls -d "$REPO/node_modules/.pnpm/typescript@6.0.3"/node_modules/typescript 2>/dev/null | head -1)" node_modules/typescript
ln -sfn "$(ls -d "$REPO/node_modules/.pnpm/vitest@4.1.8"*/node_modules/vitest 2>/dev/null | head -1)" node_modules/vitest

ln -sfn "$REPO/node_modules/.bin/tsc" node_modules/.bin/tsc

echo "local dev resolution linked against $REPO"
echo "  - node_modules/@deepseek-ai/*  ($(ls node_modules/@deepseek-ai | wc -l) links)"
echo "  - node_modules/{tsdown,typescript,vitest,react}"
echo "run: pnpm build   pnpm typecheck   pnpm test"
