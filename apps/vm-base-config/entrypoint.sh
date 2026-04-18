#!/bin/bash
set -euo pipefail

projectId="${PROJECT_ID:-default}"
projectName="${PROJECT_NAME:-default}"
projectTypeRaw="${PROJECT_TYPE:-nextjs}"
projectType="$(printf '%s' "$projectTypeRaw" | tr '[:upper:]' '[:lower:]')"
APP_PATH="/app"

echo "Setting up project $projectName ($projectId) type(raw): $projectTypeRaw type(normalized): $projectType"

bun scripts/vmBaseSetup.ts "$projectId" "$projectName" "$projectType"

projectPath="$APP_PATH/projects/${projectName}_${projectId}/code-${projectType}"
echo "Resolved project path: $projectPath"

if [ ! -d "$projectPath" ]; then
  echo "ERROR: project path does not exist: $projectPath"
  echo "Debug listing:"
  ls -la "$APP_PATH" || true
  ls -la "$APP_PATH/projects" || true
  find "$APP_PATH/projects" -maxdepth 3 -type d || true
  exit 1
fi

echo "📦 Installing dependencies in $projectPath"
cd "$projectPath"
bun install

/app/code-server/bin/code-server --install-extension /app/extensions/codetogether.vsix || true

bun /app/scripts/startProjectSync.ts "$projectName" "$projectId" "$projectType" &

mkdir -p /config/.local/share/code-server/User
echo '{
  "workbench.colorTheme": "Default Dark+",
  "workbench.preferredDarkColorTheme": "Default Dark+"
}' > /config/.local/share/code-server/User/settings.json

exec /app/code-server/bin/code-server --auth none --bind-addr 0.0.0.0:8080 "$projectPath"

