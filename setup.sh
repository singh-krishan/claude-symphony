#!/bin/bash
set -e

echo "=== Claude Symphony — Setup ==="
echo ""

# Check prerequisites
command -v node >/dev/null 2>&1 || { echo "Error: Node.js is required. Install from https://nodejs.org"; exit 1; }
command -v gh >/dev/null 2>&1 || { echo "Warning: GitHub CLI (gh) not found. PRs won't be auto-created. Install from https://cli.github.com"; }

# Install dependencies
echo "Installing dependencies..."
npm install --silent

# Build
echo "Building..."
npm run build --silent

echo ""
echo "=== Configuration ==="
echo ""

# Check for API keys
if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "⚠  ANTHROPIC_API_KEY not set"
  echo "   Get one at: https://console.anthropic.com/settings/keys"
  echo "   Then run: export ANTHROPIC_API_KEY=\"sk-ant-...\""
  echo ""
fi

if [ -z "$LINEAR_API_KEY" ]; then
  echo "⚠  LINEAR_API_KEY not set"
  echo "   Get one at: Linear → Settings → API → Personal API keys"
  echo "   Then run: export LINEAR_API_KEY=\"lin_api_...\""
  echo ""
fi

# Create WORKFLOW.md if it doesn't exist
if [ ! -f WORKFLOW.md ]; then
  echo "No WORKFLOW.md found. Which tracker will you use?"
  echo ""
  echo "  1) Linear  (recommended for product teams)"
  echo "  2) Jira    (enterprise)"
  echo "  3) Local   (testing with issues.json)"
  echo ""
  read -p "Choose [1/2/3]: " choice

  case $choice in
    1)
      cp WORKFLOW.linear.md.example WORKFLOW.md
      echo ""
      echo "Created WORKFLOW.md from Linear template."
      echo ""
      echo "Edit WORKFLOW.md and set:"
      echo "  tracker.project_slug: <your Linear project slug>"
      echo ""
      echo "Your project slug is in the URL:"
      echo "  linear.app/<workspace>/project/<slug>"
      ;;
    2)
      cp WORKFLOW.jira.md.example WORKFLOW.md
      echo ""
      echo "Created WORKFLOW.md from Jira template."
      echo ""
      echo "Edit WORKFLOW.md and set:"
      echo "  tracker.domain:       <yourcompany>.atlassian.net"
      echo "  tracker.project_slug: <PROJ>  (your Jira project key)"
      echo ""
      echo "Also set env vars:"
      echo "  export JIRA_EMAIL=\"you@company.com\""
      echo "  export JIRA_API_TOKEN=\"your-token\""
      ;;
    3)
      cp WORKFLOW.local.md.example WORKFLOW.md
      cp issues.example.json issues.json
      echo ""
      echo "Created WORKFLOW.md and issues.json for local testing."
      echo "Edit issues.json to add/modify issues."
      ;;
    *)
      echo "Invalid choice. Copy one of the example files manually:"
      echo "  cp WORKFLOW.linear.md.example WORKFLOW.md"
      echo "  cp WORKFLOW.jira.md.example WORKFLOW.md"
      echo "  cp WORKFLOW.local.md.example WORKFLOW.md"
      exit 1
      ;;
  esac
else
  echo "WORKFLOW.md already exists."
fi

echo ""
echo "=== Ready ==="
echo ""
echo "To start Claude Symphony:"
echo "  node dist/index.js"
echo ""
echo "To start with status server:"
echo "  node dist/index.js --port 8080"
echo ""
echo "To dry-run (no Claude API calls):"
echo "  node dist/index.js --dry-run"
echo ""
