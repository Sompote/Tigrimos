#!/usr/bin/env bash
# Tiger Cowork — One-Line Installer for Mac
# Usage: curl -fsSL https://raw.githubusercontent.com/<user>/<repo>/main/install.sh | bash

set -e

APP_NAME="Tiger Cowork"
REPO_URL="https://github.com/Sompote/tiger_cowork.git"
INSTALL_DIR="$HOME/TigerCowork"

echo ""
echo "========================================="
echo "  $APP_NAME — Auto Installer"
echo "========================================="
echo ""

# --- 1. Check & Install Docker ---
export PATH="/Applications/Docker.app/Contents/Resources/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.docker/bin:$PATH"

if ! docker --version &>/dev/null 2>&1; then
  echo "📦 Docker not found. Installing Docker Desktop..."

  # Detect chip
  ARCH=$(uname -m)
  if [ "$ARCH" = "arm64" ]; then
    DOCKER_DMG_URL="https://desktop.docker.com/mac/main/arm64/Docker.dmg"
  else
    DOCKER_DMG_URL="https://desktop.docker.com/mac/main/amd64/Docker.dmg"
  fi

  echo "   Downloading Docker Desktop..."
  curl -fsSL -o /tmp/Docker.dmg "$DOCKER_DMG_URL"

  echo "   Installing..."
  hdiutil attach /tmp/Docker.dmg -quiet
  cp -R "/Volumes/Docker/Docker.app" /Applications/
  hdiutil detach "/Volumes/Docker" -quiet
  rm -f /tmp/Docker.dmg

  echo "   Starting Docker Desktop..."
  open -a Docker

  # Wait for Docker to be ready
  echo "   Waiting for Docker to start (this may take a minute)..."
  TRIES=0
  while ! docker info &>/dev/null 2>&1; do
    sleep 3
    TRIES=$((TRIES + 1))
    if [ $TRIES -ge 40 ]; then
      echo "❌ Docker did not start in time. Please open Docker Desktop manually and run this script again."
      exit 1
    fi
  done
  echo "   ✅ Docker is ready!"
else
  echo "✅ Docker found: $(docker --version)"

  # Start Docker if daemon not running
  if ! docker info &>/dev/null 2>&1; then
    echo "⏳ Starting Docker Desktop..."
    open -a Docker
    TRIES=0
    while ! docker info &>/dev/null 2>&1; do
      sleep 3
      TRIES=$((TRIES + 1))
      if [ $TRIES -ge 30 ]; then
        echo "❌ Docker did not start. Please open Docker Desktop manually and try again."
        exit 1
      fi
    done
    echo "   ✅ Docker is ready!"
  fi
fi

# --- 2. Check & Install Git ---
if ! command -v git &>/dev/null; then
  echo "📦 Git not found. Installing via Xcode Command Line Tools..."
  xcode-select --install 2>/dev/null || true
  echo "   Please complete the Xcode tools installation popup, then run this script again."
  exit 1
fi

# --- 3. Clone repo ---
if [ -d "$INSTALL_DIR" ]; then
  echo "📁 $INSTALL_DIR already exists, pulling latest..."
  cd "$INSTALL_DIR" && git pull
else
  echo "📥 Cloning $APP_NAME..."
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# --- 4. Create .env ---
if [ ! -f .env ]; then
  cat > .env <<'ENVEOF'
# Access token to protect the app (leave empty to disable auth)
ACCESS_TOKEN=
ENVEOF
  echo "📄 Created .env (no auth)"
fi

# --- 5. Build and start ---
echo ""
echo "🔨 Building and starting $APP_NAME..."
echo "   (First run may take a few minutes)"
echo ""

docker compose up --build -d

# --- 6. Wait for server ---
URL="http://localhost:3001"
TRIES=0
while ! curl -s "$URL" > /dev/null 2>&1; do
  sleep 1
  TRIES=$((TRIES + 1))
  if [ $TRIES -ge 30 ]; then
    break
  fi
done

# --- 7. Open browser ---
open "$URL"

echo ""
echo "========================================="
echo "  ✅ $APP_NAME is running!"
echo "  🌐 $URL"
echo "========================================="
echo ""
echo "  Installed at: $INSTALL_DIR"
echo "  To stop:      cd $INSTALL_DIR && docker compose down"
echo "  To restart:    double-click TigerCowork.app"
echo ""
