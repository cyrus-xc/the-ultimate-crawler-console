#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/../../.." && pwd)
deps="${CRAWLER_DESKTOP_DEPS:?set CRAWLER_DESKTOP_DEPS to installed desktop dependency root}"
export LD_LIBRARY_PATH="$deps/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1
unset WAYLAND_DISPLAY DISPLAY SWAYSOCK
export CRAWLER_RUNTIME_DIR="${CRAWLER_RUNTIME_DIR:-$root/runtime}"
mkdir -p "$CRAWLER_RUNTIME_DIR/desktop"
cat > "$CRAWLER_RUNTIME_DIR/desktop/sway.conf" <<CONFIG
xwayland disable
output HEADLESS-1 mode 1280x800@30Hz scale 1
seat seat0 fallback true
seat seat0 hide_cursor 5000
default_border none
for_window [app_id="ultimate-crawler-xhs"] border none
for_window [app_id="ultimate-crawler-douyin"] border none
exec "$root/adapters/xhs-web/desktop/vnc.sh"
CONFIG
exec "$deps/usr/bin/sway" -c "$CRAWLER_RUNTIME_DIR/desktop/sway.conf"
