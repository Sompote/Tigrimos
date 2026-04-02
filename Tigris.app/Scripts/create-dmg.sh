#!/bin/bash
# Create a distributable DMG for TigrimOS
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$PROJECT_DIR/dist"

ARCH=$(uname -m)
if [ "$ARCH" = "x86_64" ]; then
    APP_NAME="TigrimOS_i"
    DMG_NAME="TigrimOS_Intel"
else
    APP_NAME="TigrimOS"
    DMG_NAME="TigrimOS_AppleSilicon"
fi

APP_PATH="$DIST_DIR/${APP_NAME}.app"
DMG_PATH="$DIST_DIR/${DMG_NAME}.dmg"

if [ ! -d "$APP_PATH" ]; then
    echo "ERROR: ${APP_NAME}.app not found. Run build.sh first."
    exit 1
fi

echo "=== Creating ${DMG_NAME}.dmg ==="

# Create temp DMG staging directory
STAGING=$(mktemp -d)
trap "rm -rf $STAGING" EXIT

cp -r "$APP_PATH" "$STAGING/"

# Add a README for first-time users
cat > "$STAGING/READ ME FIRST.txt" << 'README'
TIGRIS - Secure Tiger Cowork Sandbox
=====================================

INSTALLATION:
  Drag TigrimOS to your Applications folder.

FIRST LAUNCH:
  If macOS shows "app cannot be opened":
  1. Right-click the app → select "Open"
  2. Click "Open" in the dialog
  (This is only needed the first time)

  OR go to:
  System Settings → Privacy & Security → scroll down → click "Open Anyway"

WHAT IT DOES:
  Runs Tiger Cowork inside a secure Ubuntu VM on your Mac.
  No Docker required. Your files are isolated unless you share them.

REQUIREMENTS:
  - macOS 13 (Ventura) or later
  - 4GB RAM available
  - 20GB disk space
  - Xcode Command Line Tools (for first build)
README

# Create symlink to Applications (for drag-to-install)
ln -s /Applications "$STAGING/Applications"

# Create DMG
hdiutil create \
    -volname "$DMG_NAME" \
    -srcfolder "$STAGING" \
    -ov \
    -format UDZO \
    "$DMG_PATH"

echo ""
echo "=== DMG Created ==="
echo "File: $DMG_PATH"
echo "Size: $(du -h "$DMG_PATH" | cut -f1)"
echo ""
echo "Share this file. Users drag the app to Applications."
