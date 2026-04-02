#!/usr/bin/env bash
# Tiger Cowork — One-Click Mac Launcher
# Double-click this file to start Tiger Cowork via Docker

set -e
cd "$(dirname "$0")"

APP_NAME="Tiger Cowork"
URL="http://localhost:3001"

echo "========================================="
echo "  $APP_NAME — One-Click Installer"
echo "========================================="
echo ""

# Check Docker is installed
if ! command -v docker &>/dev/null; then
  echo "❌ Docker not found!"
  echo ""
  echo "Please install Docker Desktop for Mac:"
  echo "  https://www.docker.com/products/docker-desktop/"
  echo ""
  echo "After installing, run this script again."
  read -rp "Press Enter to exit..."
  exit 1
fi

# Check Docker daemon is running
if ! docker info &>/dev/null 2>&1; then
  echo "⏳ Starting Docker Desktop..."
  open -a Docker
  echo "   Waiting for Docker to be ready..."
  while ! docker info &>/dev/null 2>&1; do
    sleep 2
  done
  echo "   Docker is ready!"
fi

# Create .env if missing
if [ ! -f .env ]; then
  cp .env.example .env
  echo "📄 Created .env from .env.example"
fi

# Build and start
echo ""
echo "🔨 Building and starting $APP_NAME..."
echo "   (First run may take a few minutes)"
echo ""

docker compose up --build -d

echo ""
echo "========================================="
echo "  ✅ $APP_NAME is running!"
echo "  🌐 Opening $URL"
echo "========================================="
echo ""

# Wait a moment for server to start
sleep 3

# Open in browser
open "$URL"

echo "To stop:  docker compose down"
echo "To logs:  docker compose logs -f"
echo ""
read -rp "Press Enter to close this window..."
