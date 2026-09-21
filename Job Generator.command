#!/bin/bash
# FranVision Job Generator -- double-click this file in Finder to run.
# Starts the local server; the server opens the UI in your browser on
# whichever port it got (normally 4173).
cd "$(dirname "$0")/job-generator"
JG_OPEN_BROWSER=1 node server.js &
SERVER_PID=$!
echo "Job Generator running. Close this window (or press Ctrl+C) to stop it."
wait $SERVER_PID
