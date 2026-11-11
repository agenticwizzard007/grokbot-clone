#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
mode="${1:-help}"
if [[ "$mode" == stage ]]; then
  shift
  exec node "$repo/scripts/stage-apple-mac.mjs" "$@"
fi
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Building/signing the Mac distribution requires macOS and Xcode. Staging also works on Linux.' >&2
  exit 1
fi
case "$mode" in
  build)
    arch="${2:-universal}"
    case "$arch" in
      arm64) xcode_archs='arm64'; payload_archs='arm64' ;;
      x64) xcode_archs='x86_64'; payload_archs='x64' ;;
      universal) xcode_archs='arm64 x86_64'; payload_archs='arm64 x64' ;;
      *) echo 'Architecture must be arm64, x64, or universal.' >&2; exit 1 ;;
    esac
    payload="$repo/apple/build/MacControlPayload"
    node "$repo/scripts/stage-apple-mac.mjs" --check --arch "$arch"
    if command -v xcodegen >/dev/null; then (cd "$repo/apple" && xcodegen generate); fi
    xcodebuild -project "$repo/apple/Swarm.xcodeproj" -scheme Swarm-macOS -configuration Release \
      -derivedDataPath "$repo/apple/build-distribution" -destination 'generic/platform=macOS' \
      "ARCHS=$xcode_archs" ONLY_ACTIVE_ARCH=NO CODE_SIGNING_ALLOWED=NO build
    app="$repo/apple/build-distribution/Build/Products/Release/Swarm.app"
    target="$app/Contents/Resources/MacControl"
    # Only a generated build product is replaced here. Source and website data are untouched.
    rm -rf "$target"
    mkdir -p "$target"
    ditto "$payload" "$target"
    for runtime_arch in $payload_archs; do
      clang_arch="$runtime_arch"
      if [[ "$runtime_arch" == x64 ]]; then clang_arch=x86_64; fi
      xcrun --sdk macosx clang -Wall -Wextra -Werror -Os -arch "$clang_arch" -mmacosx-version-min=14.0 \
        "$repo/apple/MacControl/control-host.c" -lproc -o "$target/$runtime_arch/control-host"
    done
    echo "Packaged unsigned app: $app"
    echo 'Sign this complete app before installing it or requesting macOS permissions.'
    ;;
  sign)
    app="${2:?Usage: scripts/package-apple-mac.sh sign /path/Swarm.app 'Developer ID Application: ...'}"
    identity="${3:?Supply your Developer ID Application identity.}"
    if [[ "$identity" != 'Developer ID Application:'* ]]; then
      echo 'Distribution signing requires a Developer ID Application identity.' >&2; exit 1
    fi
    if [[ ! -d "$app/Contents/Resources/MacControl" || ! -f "$app/Contents/MacOS/Swarm" ]]; then
      echo 'Supply a complete packaged Swarm.app from the build command.' >&2; exit 1
    fi
    while IFS= read -r -d '' executable; do
      if [[ "$executable" == */node ]]; then
        codesign --force --timestamp --options runtime --sign "$identity" --entitlements "$repo/apple/Configuration/Node.entitlements" "$executable"
      else
        codesign --force --timestamp --options runtime --sign "$identity" "$executable"
      fi
    done < <(find "$app/Contents/Resources/MacControl" -type f \( -name node -o -name control-host \) -print0)
    # No --deep signing: sign known nested executables first, then seal the full app.
    codesign --force --timestamp --options runtime --sign "$identity" --entitlements "$repo/apple/Configuration/Swarm.entitlements" "$app"
    codesign --verify --deep --strict --verbose=2 "$app"
    zip="${app%.app}.zip"
    ditto -c -k --keepParent "$app" "$zip"
    echo "Signed app: $app"
    echo "Notarization upload: $zip"
    echo 'Submit with xcrun notarytool using your own Keychain profile, then staple the app and create the final zip again.'
    ;;
  *)
    echo 'Usage:'
    echo '  scripts/package-apple-mac.sh stage [--arch arm64|x64|universal] [--offline]'
    echo '  scripts/package-apple-mac.sh build [arm64|x64|universal]'
    echo "  scripts/package-apple-mac.sh sign /path/Swarm.app 'Developer ID Application: ...'"
    ;;
esac
