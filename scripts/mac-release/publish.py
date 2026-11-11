#!/usr/bin/env python3
"""Publish only notarized assets from this run. Existing releases are never overwritten."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def verify(directory, tag, sha):
    manifest = json.loads((directory / "release-manifest.json").read_text())
    if (manifest.get("mode") != "developer-id" or manifest.get("sha") != sha or manifest.get("tag") != tag
        or manifest.get("notarization", {}).get("status") != "Accepted"
        or manifest.get("verification") != {"stapler": "passed", "gatekeeper": "passed", "codesign": "passed"}):
        raise ValueError("Artifact is not a verified notarized release for this source/tag")
    smoke = manifest.get("runtime_smoke")
    arch = manifest.get("architectures")
    if arch not in ("arm64", "x64", "universal") or not (smoke in ("arm64", "x64") and arch in (smoke, "universal")
        or arch != "universal" and smoke == "not-run: runner architecture differs"):
        raise ValueError("Missing runtime smoke result")
    if not re.fullmatch(r"mac-v[0-9]+\.[0-9]+\.[0-9]+", tag) or not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("Invalid tag/SHA")
    archive = "Swarm-" + tag.removeprefix("mac-v") + "-macos.zip"
    expected = {archive, "release-manifest.json", "notarization-log.json"}
    if manifest.get("archive") != archive or {p.name for p in directory.iterdir()} != expected | {"SHA256SUMS"}:
        raise ValueError("Unexpected release assets")
    sums = {}
    for line in (directory / "SHA256SUMS").read_text().splitlines():
        digest, name = line.split("  ", 1)
        if name in sums or name not in expected or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError("Invalid checksum entry")
        sums[name] = digest
    if set(sums) != expected:
        raise ValueError("Incomplete checksums")
    for name, digest in sums.items():
        path = directory / name
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise ValueError("Release asset checksum mismatch")
    return manifest, sorted(expected | {"SHA256SUMS"})


def main():
    directory = Path(sys.argv[1])
    tag, sha = os.environ["RELEASE_TAG"], os.environ["RELEASE_SHA"]
    manifest, files = verify(directory, tag, sha)
    actual = subprocess.check_output(["git", "rev-parse", "refs/tags/" + tag + "^{commit}"], text=True).strip()
    if actual != sha:
        raise ValueError("Release tag changed after signing")
    subprocess.run(["git", "merge-base", "--is-ancestor", sha, "origin/main"], check=True)
    notes = directory.parent / "mac-release-notes.md"
    notes.write_text(f"Swarm {manifest['version']} for macOS 14 or later.\n\n"
                     f"Architectures: {manifest['architectures']}. Build: {manifest['build']}.\n"
                     f"Default server: {manifest['origin']}\n\n"
                     "Developer ID signed, notarized and stapled. Download the zip, open it and move Swarm.app to Applications. "
                     "See SHA256SUMS and release-manifest.json for verification. macOS permissions require your approval.\n\n"
                     f"Source: {sha}\n")
    # Creation fails if a release exists. A failed upload leaves a draft; never
    # clobber or silently replace an artifact that users may already have downloaded.
    subprocess.run(["gh", "release", "create", tag, "--verify-tag", "--draft", "--title", "Swarm for Mac " + manifest["version"],
                    "--notes-file", str(notes), *[str(directory / name) for name in files]], check=True)
    subprocess.run(["gh", "release", "edit", tag, "--draft=false", "--latest=false"], check=True)


if __name__ == "__main__":
    main()
