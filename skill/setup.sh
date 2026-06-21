#!/bin/bash
set -e
cd "$(dirname "$0")/bridge"
echo "Installing Agent Watch bridge dependencies..."
npm install
echo "Setup complete."
