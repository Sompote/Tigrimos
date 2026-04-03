#!/bin/bash
# TigrimOS VM Provisioning Script
# Runs inside the Ubuntu VM to set up TigrimOS
# This mirrors the Dockerfile setup but for a real Ubuntu VM

set -euo pipefail

echo "=== TigrimOS Provisioning ==="
echo "Setting up TigrimOS in Ubuntu sandbox"

# Update system
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get upgrade -y -qq

# Install Node.js 20
if ! command -v node &>/dev/null; then
    echo "[1/6] Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
    sudo apt-get install -y nodejs
else
    echo "[1/6] Node.js already installed: $(node --version)"
fi

# Install Python 3 + venv
echo "[2/6] Setting up Python..."
sudo apt-get install -y python3 python3-pip python3-venv build-essential

# Create Python virtual environment (mirrors Dockerfile)
if [ ! -d /opt/venv ]; then
    echo "[3/6] Creating Python virtual environment..."
    sudo python3 -m venv /opt/venv
    sudo /opt/venv/bin/pip install --no-cache-dir \
        numpy pillow matplotlib pandas scipy seaborn openpyxl python-docx
else
    echo "[3/6] Python venv already exists"
fi

# Add venv to PATH
export PATH="/opt/venv/bin:$PATH"

# Install global npm packages (mirrors Dockerfile)
echo "[4/6] Installing global npm packages..."
sudo npm i -g clawhub tsx

# Setup TigrimOS
echo "[5/6] Setting up TigrimOS..."
sudo mkdir -p /app
sudo chown -R tigris:tigris /app

# Copy from VirtioFS mount if available
if [ -d /mnt/tiger-cowork ] && [ -f /mnt/tiger-cowork/package.json ]; then
    echo "  Copying from shared mount..."
    cp -r /mnt/tiger-cowork/* /app/
    cd /app
    npm install --ignore-scripts --omit=dev
    if [ -d client ]; then
        cd client && npm install && npx vite build && cd ..
    fi
    mkdir -p uploads data data/agents
fi

# Create systemd service
echo "[6/6] Creating systemd service..."
sudo tee /etc/systemd/system/tiger-cowork.service > /dev/null << 'EOF'
[Unit]
Description=TigrimOS AI Workspace
After=network.target

[Service]
Type=simple
User=tigris
WorkingDirectory=/app
Environment=NODE_ENV=production
Environment=PORT=3001
Environment=SANDBOX_DIR=/app
Environment=PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/npx tsx server/index.ts
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/app/data /app/uploads /app/output_file /app/Tiger_bot
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable tiger-cowork
sudo systemctl start tiger-cowork

# Mount helper for user shared folders
sudo mkdir -p /mnt/shared
sudo tee /usr/local/bin/mount-shared-folders.sh > /dev/null << 'MSCRIPT'
#!/bin/bash
# Auto-mount VirtioFS shared folders
for tag in $(ls /sys/fs/virtiofs/ 2>/dev/null || true); do
    mountpoint="/mnt/shared/${tag}"
    mkdir -p "$mountpoint"
    mount -t virtiofs "$tag" "$mountpoint" 2>/dev/null || true
done
MSCRIPT
sudo chmod +x /usr/local/bin/mount-shared-folders.sh

# Signal provisioning complete
sudo touch /var/lib/tigris-provisioned
echo "=== TigrimOS Provisioning Complete ==="
echo "TigrimOS running at http://localhost:3001"
