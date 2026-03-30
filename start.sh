#!/bin/bash
# Restart loop for bots-manager — survives self-update (process.exit(0))
# Usage: nohup bash start.sh > /dev/null 2>&1 &
# Or better: use systemd (see bots-manager.service)

cd "$(dirname "$0")"

while true; do
    echo "[$(date)] Starting bots-manager..."
    node manager.js
    EXIT_CODE=$?
    echo "[$(date)] bots-manager exited with code $EXIT_CODE. Restarting in 5s..."
    sleep 5
done
