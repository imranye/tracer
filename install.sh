#!/usr/bin/env sh
set -eu
base="${TRACER_REPO_RAW:-https://raw.githubusercontent.com/imranye/tracer/main}"
target="${HOME}/.local/bin"
mkdir -p "$target"
curl -fsSL "$base/bin/tracer.mjs" -o "$target/tracer"
chmod 700 "$target/tracer"
printf 'Installed tracer to %s/tracer\n' "$target"
printf 'Add %s to PATH if needed.\n' "$target"
