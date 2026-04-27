#!/bin/bash
# Build TigrimOS apps — separate Intel and Apple Silicon bundles
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DIST_DIR="$PROJECT_DIR/dist"

echo "=== TigrimOS Build System ==="
echo ""

# Parse args
BUILD_TARGET="${1:-native}"  # native, intel, silicon, all

build_app() {
    local ARCH="$1"        # x86_64 or arm64
    local SUFFIX="$2"      # _i or _m
    local LABEL="$3"       # "Intel" or "Apple Silicon"
    local BUNDLE_SUFFIX="$4"  # "-intel" or "-silicon"

    local APP_NAME="TigrimOS${SUFFIX}"
    local APP_BUNDLE="$DIST_DIR/${APP_NAME}.app"

    echo "--- Building ${APP_NAME}.app (${LABEL}) ---"

    # Compile for specific architecture
    echo "[1/5] Compiling for ${ARCH}..."
    cd "$PROJECT_DIR"
    swift build -c release --arch "$ARCH" 2>&1 | tail -3

    local BINARY="$PROJECT_DIR/.build/${ARCH}-apple-macosx/release/TigrimOS"
    if [ ! -f "$BINARY" ]; then
        echo "ERROR: Binary not found at $BINARY"
        return 1
    fi

    # Verify architecture
    echo "[2/5] Verifying binary..."
    file "$BINARY" | grep -q "$ARCH" || {
        echo "ERROR: Binary is not ${ARCH}"
        return 1
    }

    # Create .app bundle
    echo "[3/5] Creating app bundle..."
    rm -rf "$APP_BUNDLE"
    mkdir -p "$APP_BUNDLE/Contents/MacOS"
    mkdir -p "$APP_BUNDLE/Contents/Resources"
    cp "$BINARY" "$APP_BUNDLE/Contents/MacOS/${APP_NAME}"

    # Info.plist
    echo "[4/5] Writing Info.plist..."
    cat > "$APP_BUNDLE/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>${APP_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>com.tigercowork.tigrimos${BUNDLE_SUFFIX}</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>TigrimOS</string>
    <key>CFBundleDisplayName</key>
    <string>TigrimOS (${LABEL})</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.4.0</string>
    <key>CFBundleVersion</key>
    <string>5</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <key>LSArchitecturePriority</key>
    <array>
        <string>${ARCH}</string>
    </array>
    <key>NSHumanReadableCopyright</key>
    <string>Copyright © 2024 Tiger Cowork. All rights reserved.</string>
    <key>LSApplicationCategoryType</key>
    <string>public.app-category.developer-tools</string>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
    <key>NSSupportsAutomaticTermination</key>
    <true/>
    <key>NSSupportsSuddenTermination</key>
    <false/>
    <key>com.apple.security.virtualization</key>
    <true/>
</dict>
</plist>
PLIST

    # Copy resources + sign
    echo "[5/5] Signing..."
    cp "$PROJECT_DIR/TigrimOS/Resources/provision.sh" "$APP_BUNDLE/Contents/Resources/"
    cp "$PROJECT_DIR/TigrimOS/Resources/cloud-init.yaml" "$APP_BUNDLE/Contents/Resources/"
    codesign --force --sign - --entitlements "$PROJECT_DIR/TigrimOS.entitlements" "$APP_BUNDLE"
    xattr -cr "$APP_BUNDLE"

    echo "  -> $APP_BUNDLE"
    echo "     $(file "$APP_BUNDLE/Contents/MacOS/${APP_NAME}" | awk -F: '{print $2}')"
    echo ""
}

mkdir -p "$DIST_DIR"

case "$BUILD_TARGET" in
    intel|i)
        build_app "x86_64" "_i" "Intel" "-intel"
        ;;
    silicon|m|arm)
        build_app "arm64" "_m" "Apple Silicon" "-silicon"
        ;;
    all)
        build_app "x86_64" "_i" "Intel" "-intel"
        build_app "arm64" "_m" "Apple Silicon" "-silicon"
        ;;
    native)
        ARCH=$(uname -m)
        if [ "$ARCH" = "x86_64" ]; then
            build_app "x86_64" "_i" "Intel" "-intel"
        else
            build_app "arm64" "_m" "Apple Silicon" "-silicon"
        fi
        ;;
    *)
        echo "Usage: $0 [intel|silicon|all|native]"
        echo "  intel   - Build TigrimOS_i.app (Intel x86_64)"
        echo "  silicon - Build TigrimOS_m.app (Apple Silicon arm64)"
        echo "  all     - Build both"
        echo "  native  - Build for current Mac (default)"
        exit 1
        ;;
esac

echo "=== Build Complete ==="
echo ""
ls -la "$DIST_DIR"/*.app/Contents/MacOS/* 2>/dev/null | while read line; do
    echo "  $line"
done
echo ""
echo "To run: open $DIST_DIR/TigrimOS_i.app  (Intel)"
echo "    or: open $DIST_DIR/TigrimOS_m.app  (Apple Silicon)"
