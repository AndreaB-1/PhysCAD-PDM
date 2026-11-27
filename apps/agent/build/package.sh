#!/usr/bin/env bash
# Build release downloads into apps/agent/dist/:
#   plm-agent-windows-x64.zip  plm-agent-linux-x64.tar.gz  PLM-Lite-Agent-macos-<arch>.zip  plm-lite.physcadplugin
# Usage: build/package.sh [win-x64 linux-x64 osx-arm64 osx-x64 plugin]   (default: all that can be built here)
# macOS bundles must be built on a Mac (they need an ad-hoc code signature to run on Apple Silicon).
set -euo pipefail
cd "$(dirname "$0")/.."
version="$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' Directory.Build.props)"
dist="$PWD/dist"; mkdir -p "$dist"
targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then
  if [ "$(uname)" = Darwin ]; then targets=(osx-arm64 osx-x64); else targets=(win-x64 linux-x64 plugin); fi
fi

publish() { dotnet publish src/PlmAgent -c Release -r "$1" -o "out/$1" -p:Version="$version" -v q; }

for t in "${targets[@]}"; do
  case "$t" in
    win-x64)
      publish win-x64
      (cd out/win-x64 && rm -f "$dist/plm-agent-windows-x64.zip" && zip -q "$dist/plm-agent-windows-x64.zip" plm-agent.exe) ;;
    linux-x64)
      publish linux-x64
      tar -C out/linux-x64 -czf "$dist/plm-agent-linux-x64.tar.gz" plm-agent ;;
    osx-arm64|osx-x64)
      publish "$t"
      app="out/$t-app/PLM Lite Agent.app"
      rm -rf "out/$t-app"; mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
      cp -R "out/$t/." "$app/Contents/MacOS/"
      cp build/AppIcon.icns "$app/Contents/Resources/AppIcon.icns"
      sed "s/@VERSION@/$version/g" build/Info.plist > "$app/Contents/Info.plist"
      if command -v codesign >/dev/null; then codesign --force --deep --sign - "$app"; fi
      arch="${t#osx-}"
      (cd "out/$t-app" && rm -f "$dist/PLM-Lite-Agent-macos-$arch.zip" && ditto -c -k --keepParent "PLM Lite Agent.app" "$dist/PLM-Lite-Agent-macos-$arch.zip" 2>/dev/null \
        || zip -qry "$dist/PLM-Lite-Agent-macos-$arch.zip" "PLM Lite Agent.app") ;;
    plugin)
      (cd ../physcad-plugin && rm -f "$dist/plm-lite.physcadplugin" && zip -q "$dist/plm-lite.physcadplugin" plugin.json main.js panel.html panel.js icon.svg) ;;
    *) echo "unknown target $t" >&2; exit 2 ;;
  esac
done
ls -la "$dist"
