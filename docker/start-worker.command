#!/bin/bash
# Local Worker Startup Script (Docker Local Deployment)
# Connects to localhost:3456 Task API

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$SCRIPT_DIR"

# Load environment variables
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

# Check WORKER_TOKEN
if [ -z "$WORKER_TOKEN" ]; then
    echo "Error: WORKER_TOKEN not set"
    echo "Run ./setup.sh first or configure .env"
    exit 1
fi

# Kill old processes
pkill -f "node.*worker.js" 2>/dev/null
screen -S worker -X quit 2>/dev/null

echo "=========================================="
echo "  Starting Local Worker (Docker Local)"
echo "=========================================="
echo ""
echo "Task API: http://localhost:3456"
echo "Worker:   $PROJECT_ROOT/worker.js"
echo ""

# Start with login shell (for Keychain access)
screen -dmS worker bash -l -c "cd $PROJECT_ROOT && \
  WORKER_URL=http://localhost:3456 \
  WORKER_TOKEN=$WORKER_TOKEN \
  POLL_INTERVAL=500 \
  MAX_CONCURRENT=3 \
  node worker.js"

sleep 2

# Check if started successfully
if screen -list | grep -q worker; then
    echo "✓ Worker started!"
    echo ""
    echo "View logs: screen -r worker"
    echo "Stop:      screen -S worker -X quit"
else
    echo "✗ Worker failed to start"
    exit 1
fi
