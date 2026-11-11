#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../apple"
if [[ "$(uname -s)" != Darwin ]]; then
  echo 'Apple builds require macOS with Xcode. See docs/apple-apps.md.' >&2
  exit 1
fi
if command -v xcodegen >/dev/null; then
  xcodegen generate
elif [[ ! -d Swarm.xcodeproj ]]; then
  echo 'The Xcode project is missing. Install XcodeGen with: brew install xcodegen' >&2
  exit 1
fi
case "${1:-open}" in
  open) open Swarm.xcodeproj ;;
  macos) xcodebuild -project Swarm.xcodeproj -scheme Swarm-macOS -configuration Debug -derivedDataPath build -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build ;;
  macos-stage) shift; exec ../scripts/package-apple-mac.sh stage "$@" ;;
  macos-package) shift; exec ../scripts/package-apple-mac.sh build "$@" ;;
  ios) xcodebuild -project Swarm.xcodeproj -scheme Swarm-iOS -configuration Debug -derivedDataPath build -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build ;;
  test) xcodebuild -project Swarm.xcodeproj -scheme Swarm-macOS -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO test ;;
  *) echo 'Usage: scripts/apple.sh [open|macos|ios|test|macos-stage|macos-package]' >&2; exit 1 ;;
esac
