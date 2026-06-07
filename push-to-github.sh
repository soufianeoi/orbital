#!/bin/bash
# Orbital — Push to GitHub
# Run this on YOUR machine

USERNAME="soufianeoi"
REPO_NAME="orbital"

echo "Pushing Orbital to GitHub..."
git remote remove origin 2>/dev/null
git remote add origin https://github.com/${USERNAME}/${REPO_NAME}.git
git push -u origin main --force

echo "✅ Done! https://github.com/$USERNAME/$REPO_NAME"
