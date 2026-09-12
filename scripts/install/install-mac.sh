#!/bin/sh
# install-mac.sh - 安装 csm-coding-agent-web 单 exe 为最小 .app bundle + 注册 deep-link 协议
# 用法: ./install-mac.sh <exe> [scheme]
#
# 注意：macOS 热启动（已在跑时点 deep-link）需处理 AppleEvent kAEGetURL，
#       bare bun exe 不原生支持；冷启动（未运行）经 argv 正常工作。
set -e
EXE="${1:?usage: install-mac.sh <exe> [scheme]}"
SCHEME="${2:-csm-coding-agent-web}"
APP="$HOME/Applications/CSM Coding Agent Web.app"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$EXE" "$APP/Contents/MacOS/app"
chmod +x "$APP/Contents/MacOS/app"

# 图标（来自 desktop build/icon.icns；与安装器同目录的 assets/icon.icns）
ICON_SRC="$(cd "$(dirname "$0")" && pwd)/assets/icon.icns"
if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$APP/Contents/Resources/icon.icns"
fi

# launcher：CFBundleExecutable，把 URL 作为 arg 传给 app（--open 兜底场景由用户决定）
cat > "$APP/Contents/MacOS/csm-coding-agent-web" <<'LAUNCH'
#!/bin/sh
exec "$(dirname "$0")/app" "$@"
LAUNCH
chmod +x "$APP/Contents/MacOS/csm-coding-agent-web"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>csm-coding-agent-web</string>
  <key>CFBundleName</key><string>CSM Coding Agent Web</string>
  <key>CFBundleIdentifier</key><string>com.csm.coding-agent-web</string>
  <key>CFBundleIconFile</key><string>icon.icns</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeRole</key><string>Viewer</string>
      <key>CFBundleURLName</key><string>com.csm.coding-agent-web</string>
      <key>CFBundleURLSchemes</key>
      <array><string>__SCHEME__</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST
sed -i '' "s/__SCHEME__/$SCHEME/" "$APP/Contents/Info.plist"

# csmcode shim（放 ~/.local/bin，需用户自行确保其在 PATH）
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/csmcode" <<EOF
#!/bin/sh
exec "$APP/Contents/MacOS/app" --open "\$@"
EOF
chmod +x "$HOME/.local/bin/csmcode"

echo "Installed to $APP"
echo "Protocol $SCHEME:// registered via Info.plist"
echo "csmcode shim at ~/.local/bin/csmcode (ensure ~/.local/bin is on PATH)"
echo "Note: warm deep-link needs AppleEvent handling; cold start works."
