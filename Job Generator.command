#!/bin/bash
# FranVision Job Generator -- double-click this file in Finder to run.
# Starts the local server and opens the UI in your browser.
cd "$(dirname "$0")/job-generator"
node server.js &
SERVER_PID=$!
sleep 1
open "http://localhost:4173"
echo "Job Generator running. Close this window (or press Ctrl+C) to stop it."
wait $SERVER_PID
