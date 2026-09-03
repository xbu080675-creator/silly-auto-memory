#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

APP="$HOME/.silly-auto-memory"
RAW="https://raw.githubusercontent.com/xbu080675-creator/silly-auto-memory/main/termux/server.js"
TMP="$APP/server.js.new"

mkdir -p "$APP"

echo "正在下载 Auto Memory Termux 后端更新..."
curl -fsSL "$RAW" -o "$TMP"

if ! node --check "$TMP" >/dev/null 2>&1; then
  echo "下载的 server.js 语法检查失败，已取消更新。"
  rm -f "$TMP"
  exit 1
fi

if [ -f "$APP/server.js" ]; then
  cp "$APP/server.js" "$APP/server.js.bak"
fi

if [ -x "$APP/stop.sh" ]; then
  bash "$APP/stop.sh" || true
fi

mv "$TMP" "$APP/server.js"

if [ -x "$APP/start.sh" ]; then
  bash "$APP/start.sh"
else
  nohup node "$APP/server.js" >> "$APP/server.log" 2>&1 &
  echo $! > "$APP/server.pid"
fi

sleep 0.6
echo
curl -fsS http://127.0.0.1:27183/health
echo
echo "更新完成。"
