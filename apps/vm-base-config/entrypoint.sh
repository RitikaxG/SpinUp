#!/bin/bash
set -e

projectId="${PROJECT_ID:-default}"
projectName="${PROJECT_NAME:-default}"
projectType="${PROJECT_TYPE:-nextjs}"
APP_PATH="/app"


echo "Setting up project $projectName ($projectId) type: $projectType"

# Step 1 : run vmBaseSetup.ts (pass : projectId, projectType, projectName )
bun scripts/vmBaseSetup.ts "$projectId" "$projectName" "$projectType"

# Step 2 : run bun install in project Dir
projectPath="$APP_PATH/projects/${projectName}_${projectId}/code-${projectType}"
echo "📦 Installing dependencies in $projectPath"
cd "$projectPath"
bun install

# Step 3 : Install codetogether extension
/app/code-server/bin/code-server --install-extension /app/extensions/codetogether.vsix || true

# Step 4 : Start Background Watcher
bun /app/scripts/startProjectSync.ts "$projectName" "$projectId" "$projectType" & # So that it keep running add `&`

# Step 5 : Set Default theme to Dark
mkdir -p /config/.local/share/code-server/User
echo '{
  "workbench.colorTheme": "Default Dark+",
  "workbench.preferredDarkColorTheme": "Default Dark+"
}' > /config/.local/share/code-server/User/settings.json

# Step 6 : Start code-server at port 8080
exec /app/code-server/bin/code-server --auth none --bind-addr 0.0.0.0:8080 "$projectPath"





