#!/bin/bash
# TigrimOS Installer — builds and installs TigrimOS.app on any Mac
# Usage: curl -fsSL <your-url>/install.sh | bash
set -euo pipefail

echo ""
echo "  🐯 TigrimOS Installer"
echo "  ===================="
echo "  Secure sandbox for Tiger Cowork"
echo ""

# Check requirements
if ! command -v swift &>/dev/null; then
    echo "ERROR: Xcode Command Line Tools required."
    echo "  Install with: xcode-select --install"
    exit 1
fi

MACOS_VER=$(sw_vers -productVersion | cut -d. -f1)
if [ "$MACOS_VER" -lt 13 ]; then
    echo "ERROR: macOS 13 (Ventura) or later required."
    echo "  You have: $(sw_vers -productVersion)"
    exit 1
fi

ARCH=$(uname -m)
echo "  Mac: $ARCH / macOS $(sw_vers -productVersion)"
echo ""

# Determine install location
INSTALL_DIR="/Applications"
APP_NAME="TigrimOS"
if [ "$ARCH" = "x86_64" ]; then
    APP_NAME="TigrimOS_i"
    echo "  Detected: Intel Mac → building TigrimOS_i.app"
else
    echo "  Detected: Apple Silicon → building TigrimOS.app"
fi

# Clone or use local source
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

echo "[1/4] Downloading source..."
if [ -d "TigrimOS.app" ] && [ -f "TigrimOS.app/Package.swift" ]; then
    echo "  Using local source"
    cp -r TigrimOS.app/* "$TEMP_DIR/"
elif command -v git &>/dev/null; then
    echo "  Cloning from repository..."
    # Users should replace this URL with their actual repo
    git clone --depth 1 https://github.com/your-org/TigrimOS.git "$TEMP_DIR" 2>/dev/null || {
        echo "ERROR: Could not clone repository."
        echo "  Run this script from the directory containing TigrimOS.app/"
        exit 1
    }
else
    echo "ERROR: Run this script from the directory containing TigrimOS.app/"
    exit 1
fi

cd "$TEMP_DIR"

echo "[2/4] Building ${APP_NAME}.app (this may take a minute)..."
swift build -c release 2>&1 | tail -3

echo "[3/4] Creating app bundle..."
BUNDLE="$TEMP_DIR/dist/${APP_NAME}.app"
mkdir -p "$BUNDLE/Contents/MacOS"
mkdir -p "$BUNDLE/Contents/Resources"

# Copy binary
cp ".build/release/TigrimOS" "$BUNDLE/Contents/MacOS/${APP_NAME}"

# Create Info.plist
if [ "$ARCH" = "x86_64" ]; then
    BUNDLE_ID="com.tigercowork.tigris-intel"
    DISPLAY_NAME="TigrimOS (Intel)"
    ARCH_PLIST="<key>LSArchitecturePriority</key><array><string>x86_64</string></array>"
else
    BUNDLE_ID="com.tigercowork.tigris"
    DISPLAY_NAME="TigrimOS"
    ARCH_PLIST="<key>LSArchitecturePriority</key><array><string>arm64</string></array>"
fi

cat > "$BUNDLE/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>${APP_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>${BUNDLE_ID}</string>
    <key>CFBundleName</key>
    <string>${APP_NAME}</string>
    <key>CFBundleDisplayName</key>
    <string>${DISPLAY_NAME}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    ${ARCH_PLIST}
    <key>LSApplicationCategoryType</key>
    <string>public.app-category.developer-tools</string>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
    <key>com.apple.security.virtualization</key>
    <true/>
</dict>
</plist>
PLIST

# Copy resources
cp TigrimOS/Resources/provision.sh "$BUNDLE/Contents/Resources/" 2>/dev/null || true
cp TigrimOS/Resources/cloud-init.yaml "$BUNDLE/Contents/Resources/" 2>/dev/null || true

# Create entitlements
cat > "$TEMP_DIR/entitlements.plist" << 'ENT'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.virtualization</key>
    <true/>
    <key>com.apple.security.network.client</key>
    <true/>
    <key>com.apple.security.network.server</key>
    <true/>
    <key>com.apple.security.files.user-selected.read-write</key>
    <true/>
    <key>com.apple.security.files.bookmarks.app-scope</key>
    <true/>
</dict>
</plist>
ENT

# Sign
codesign --force --sign - --entitlements "$TEMP_DIR/entitlements.plist" "$BUNDLE"

# Remove quarantine
xattr -cr "$BUNDLE"

echo "[4/4] Installing to ${INSTALL_DIR}..."
if [ -d "${INSTALL_DIR}/${APP_NAME}.app" ]; then
    echo "  Removing old version..."
    rm -rf "${INSTALL_DIR}/${APP_NAME}.app"
fi
cp -r "$BUNDLE" "${INSTALL_DIR}/${APP_NAME}.app"
xattr -cr "${INSTALL_DIR}/${APP_NAME}.app"

echo ""
echo "  ✅ ${APP_NAME}.app installed to ${INSTALL_DIR}"
echo ""
echo "  To launch:"
echo "    open ${INSTALL_DIR}/${APP_NAME}.app"
echo ""
echo "  If macOS blocks it:"
echo "    Right-click → Open (first time only)"
echo "    Or: System Settings → Privacy & Security → Open Anyway"
echo ""
