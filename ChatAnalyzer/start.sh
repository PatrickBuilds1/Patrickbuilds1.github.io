#!/bin/bash

# Kill any existing node processes
pkill -f node || true

# Install dependencies
npm install

# Start the server
npm start 