#!/bin/bash
# Download and prepare Ubuntu VM image for TigrimOS
# Run this once to set up the VM disk image
set -euo pipefail

APP_SUPPORT="$HOME/Library/Application Support/TigrimOS"
mkdir -p "$APP_SUPPORT"

ARCH=$(uname -m)
echo "=== TigrimOS VM Setup ==="
echo "Architecture: $ARCH"
echo "Storage: $APP_SUPPORT"

# Determine correct Ubuntu image URL based on architecture
if [ "$ARCH" = "arm64" ]; then
    UBUNTU_URL="https://cloud-images.ubuntu.com/releases/22.04/release/ubuntu-22.04-server-cloudimg-arm64.img"
    echo "Using ARM64 Ubuntu image (Apple Silicon)"
elif [ "$ARCH" = "x86_64" ]; then
    UBUNTU_URL="https://cloud-images.ubuntu.com/releases/22.04/release/ubuntu-22.04-server-cloudimg-amd64.img"
    echo "Using AMD64 Ubuntu image (Intel Mac)"
else
    echo "ERROR: Unsupported architecture: $ARCH"
    exit 1
fi

DISK_IMAGE="$APP_SUPPORT/ubuntu.img"
DISK_SIZE_GB=20

# Download Ubuntu cloud image if not present
if [ ! -f "$DISK_IMAGE" ]; then
    echo "[1/3] Downloading Ubuntu 22.04 cloud image..."
    curl -L -o "$DISK_IMAGE.tmp" "$UBUNTU_URL"
    mv "$DISK_IMAGE.tmp" "$DISK_IMAGE"
    echo "  Download complete"
else
    echo "[1/3] Ubuntu image already exists, skipping download"
fi

# Resize disk image
echo "[2/3] Resizing disk to ${DISK_SIZE_GB}GB..."
if command -v qemu-img &>/dev/null; then
    qemu-img resize "$DISK_IMAGE" ${DISK_SIZE_GB}G
else
    # Fallback: use truncate or dd
    DISK_SIZE_BYTES=$((DISK_SIZE_GB * 1024 * 1024 * 1024))
    truncate -s "$DISK_SIZE_BYTES" "$DISK_IMAGE" 2>/dev/null || \
        dd if=/dev/zero of="$DISK_IMAGE" bs=1 count=0 seek="$DISK_SIZE_BYTES" 2>/dev/null
fi

# Create cloud-init seed ISO (for first-boot provisioning)
echo "[3/3] Creating cloud-init configuration..."

CLOUD_INIT_DIR="$APP_SUPPORT/cloud-init"
mkdir -p "$CLOUD_INIT_DIR"

# Meta-data
cat > "$CLOUD_INIT_DIR/meta-data" << 'META'
instance-id: tigris-vm
local-hostname: tigris
META

# User-data (provisioning)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

if [ -f "$PROJECT_DIR/TigrimOS/Resources/cloud-init.yaml" ]; then
    cp "$PROJECT_DIR/TigrimOS/Resources/cloud-init.yaml" "$CLOUD_INIT_DIR/user-data"
else
    cat > "$CLOUD_INIT_DIR/user-data" << 'USERDATA'
#cloud-config
hostname: tigris
users:
  - name: tigris
    groups: sudo
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
packages:
  - curl
  - git
  - build-essential
  - python3
  - python3-pip
  - python3-venv
runcmd:
  - curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  - apt-get install -y nodejs
  - npm i -g clawhub tsx
  - python3 -m venv /opt/venv
  - /opt/venv/bin/pip install numpy pillow matplotlib pandas scipy seaborn openpyxl python-docx
  - touch /var/lib/tigris-provisioned
USERDATA
fi

# Create seed ISO if possible
if command -v hdiutil &>/dev/null; then
    # macOS method: create a small disk image with cloud-init files
    SEED_IMG="$APP_SUPPORT/seed.img"
    if [ ! -f "$SEED_IMG" ]; then
        hdiutil create -size 1m -fs MS-DOS -volname cidata -o "$APP_SUPPORT/seed" \
            -srcfolder "$CLOUD_INIT_DIR" 2>/dev/null || true
        [ -f "$APP_SUPPORT/seed.dmg" ] && mv "$APP_SUPPORT/seed.dmg" "$SEED_IMG"
    fi
fi

echo ""
echo "=== VM Setup Complete ==="
echo "Disk image: $DISK_IMAGE"
echo "Cloud-init: $CLOUD_INIT_DIR"
echo ""
echo "The TigrimOS app will use these files to boot the Ubuntu VM."
