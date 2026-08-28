#!/bin/bash
# FranVision Feature Sheet Builder -- double-click this file in Finder to run.
# Starts the local server and opens the UI in your browser.
cd "$(dirname "$0")/feature-sheet-builder"
node server.js &
SERVER_PID=$!
sleep 1
open "http://localhost:4180"
echo "Feature Sheet Builder running. Close this window (or press Ctrl+C) to stop it."
wait $SERVER_PID
