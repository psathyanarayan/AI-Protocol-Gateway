#!/usr/bin/env bash

# Helper script to launch Claude Code pointing to your local NVIDIA middleware

# 1. Check if middleware is running
if ! curl -s http://127.0.0.1:8080/health > /dev/null; then
  echo "⚠️  Middleware proxy is not responding on http://127.0.0.1:8080"
  echo "Please start the middleware first in another terminal with:"
  echo "  npm start"
  exit 1
fi

echo "✅ Middleware is running!"
echo "🔗 Connecting Claude Code to http://127.0.0.1:8080 ..."

export ANTHROPIC_BASE_URL="http://127.0.0.1:8080"
export ANTHROPIC_API_KEY="dummy"

# If claude is installed, run it with any passed arguments
if command -v claude &> /dev/null; then
  claude "$@"
else
  echo "Claude CLI is not found in PATH. You can run it via npx:"
  echo "  npx @anthropic-ai/claude-code"
fi

