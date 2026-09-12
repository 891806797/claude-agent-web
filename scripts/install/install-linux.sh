#!/bin/sh
# install-linux.sh - 安装 csm-coding-agent-web 单 exe + 注册 deep-link 协议 + 投放 csmcode
# 用法: sudo ./install-linux.sh <exe> [scheme]
set -e
EXE="${1:?usage: install-linux.sh <exe> [scheme]}"
SCHEME="${2:-csm-coding-agent-web}"
DIR=/opt/csm-coding-agent-web
TARGET="$DIR/app"

mkdir -p "$DIR"
cp "$EXE" "$TARGET"
chmod +x "$TARGET"

# .env 模板（用户编辑实际值；首次安装才写）
if [ ! -f "$DIR/.env" ]; then
  cat > "$DIR/.env" <<EOF
DATABASE_URL=postgres://user:pass@host:5432/csm_agent_web
DB_SCHEMA=claude_agent_web
PORT=3000
DEEP_LINK_SCHEME=$SCHEME
AGENT_WORKSPACE_ROOT=$DIR/workspaces
INTERFACE_PLATFORM_BASE_URL=https://openapi.msuncloud.com
UPDATE_MANIFEST_URL=
CSMCODE_USER=$(whoami)
EOF
fi

# .desktop 注册协议 scheme -> exe "%u"（图标来自 desktop build/icon.png）
ICON_SRC="$(cd "$(dirname "$0")" && pwd)/assets/icon.png"
if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$DIR/icon.png"
fi
cat > /usr/share/applications/csm-coding-agent-web.desktop <<EOF
[Desktop Entry]
Name=CSM Coding Agent Web
Exec=$TARGET %u
Type=Application
NoDisplay=true
Icon=$DIR/icon.png
MimeType=x-scheme-handler/$SCHEME;
EOF
xdg-mime default csm-coding-agent-web.desktop "x-scheme-handler/$SCHEME" || true

# csmcode PATH shim（裸启 = --open 意图）
cat > /usr/local/bin/csmcode <<EOF
#!/bin/sh
exec "$TARGET" --open "\$@"
EOF
chmod +x /usr/local/bin/csmcode

echo "Installed to $TARGET"
echo "Protocol $SCHEME:// -> $TARGET"
echo "csmcode on PATH (/usr/local/bin/csmcode)"
echo "Edit $DIR/.env before first run (DATABASE_URL / UPDATE_MANIFEST_URL)"
