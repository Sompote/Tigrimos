#!/usr/bin/env bash
# One-time setup for Tiger Cowork

set -e

echo "=== Tiger Cowork Setup ==="
echo ""

# 1. Install dependencies
echo "[1/4] Installing server dependencies..."
npm install

echo "[2/4] Installing client dependencies..."
cd client && npm install && cd ..

# 3. ClawHub token
echo ""
echo "[3/4] ClawHub token setup"
echo "  Get your token at: https://www.clawhub.ai"
read -rp "  Enter your ClawHub token (press Enter to skip): " CLAWHUB_TOKEN

if [ -n "$CLAWHUB_TOKEN" ]; then
  clawhub login --token "$CLAWHUB_TOKEN" --no-browser
  echo "  ClawHub login successful!"
else
  echo "  Skipped. You can login later with: clawhub login"
fi

# 4. .env file
echo ""
echo "[4/4] Environment setup"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "  Created .env from .env.example"
else
  echo "  .env already exists, skipping"
fi

echo ""
echo "=== Setup complete! ==="
echo "  Run:  npm run dev"
echo ""
