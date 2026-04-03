@echo off
title TigrimOS Server
wsl -d TigrimOS -u root -- bash -c "cd /opt/TigrimOS/tiger_cowork && NODE_ENV=production PORT=3001 node_modules/.bin/tsx server/index.ts > /tmp/tigrimos.log 2>&1"
