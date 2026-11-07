#!/usr/bin/env bash
set -euo pipefail
: "${CRAWLER_RUNTIME_DIR:?}" "${CRAWLER_DESKTOP_DEPS:?}" "${XDG_RUNTIME_DIR:?}"
export LD_LIBRARY_PATH="$CRAWLER_DESKTOP_DEPS/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
node - <<'JS'
const fs=require('node:fs'),path=require('node:path');const file=path.join(process.env.CRAWLER_RUNTIME_DIR,'desktop','display.json');fs.writeFileSync(file+'.tmp',JSON.stringify({wayland_display:process.env.WAYLAND_DISPLAY,sway_socket:process.env.SWAYSOCK}),{mode:0o600});fs.renameSync(file+'.tmp',file);
JS
exec "$CRAWLER_DESKTOP_DEPS/usr/bin/wayvnc" -C /dev/null -o HEADLESS-1 -f 12 -R -S "$XDG_RUNTIME_DIR/ultimate-crawler-wayvncctl" "127.0.0.1:${CRAWLER_DESKTOP_VNC_PORT:-15910}"
