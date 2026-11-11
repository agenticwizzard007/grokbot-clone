#!/usr/bin/env python3
"""Mac release policy and signing. No third-party Python dependencies.

Build/staging is deliberately outside the credentialed step. All subprocesses
use argument arrays; credential-bearing command lines are never logged.
"""
import argparse
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shutil
import signal
import subprocess
import sys
from urllib.parse import urlsplit

TEAM = "A77YW376ZH"
BUNDLE = "so.swarms.app.macos"
SECRET_NAMES = ("APPLE_DEVELOPER_ID_P12", "APPLE_DEVELOPER_ID_P12_PASSWORD",
                "APPLE_DEVELOPER_ID_PROFILE", "APPLE_ASC_KEY_ID", "APPLE_ASC_ISSUER_ID",
                "APPLE_ASC_PRIVATE_KEY")
ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "apple/build-distribution/Build/Products/Release/Swarm.app"
OUTPUT = ROOT / "apple/build-release"
MACHO = {bytes.fromhex(x) for x in ("feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca")}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def child_environment():
    return {key: value for key, value in os.environ.items() if key not in SECRET_NAMES}


def run(*args, **kwargs):
    result = subprocess.run([str(a) for a in args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=child_environment(), **kwargs)
    # Never include argv/stderr here: import/partition-list/notary commands carry secrets.
    require(result.returncode == 0, f"{Path(args[0]).name} failed (exit {result.returncode}); no release produced")
    return result.stdout


def inputs(env):
    version = env.get("RELEASE_VERSION", "")
    build = env.get("RELEASE_BUILD", "")
    origin = env.get("RELEASE_ORIGIN", "")
    arch = env.get("RELEASE_ARCH", "")
    ref = env.get("RELEASE_REF", "")
    require(re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version), "Version must be major.minor.patch")
    require(re.fullmatch(r"[1-9][0-9]{0,8}", build), "Build must be a positive integer (up to 9 digits)")
    require(arch in ("arm64", "x64", "universal"), "Architecture must be arm64, x64 or universal")
    require(ref and not ref.startswith("-") and re.fullmatch(r"[A-Za-z0-9_./-]+", ref), "Invalid source reference")
    require(origin.isascii() and not re.search(r"[\s\\]", origin), "Invalid server origin")
    parsed = urlsplit(origin)
    require(parsed.scheme == "https" and parsed.hostname and parsed.username is None and parsed.password is None
            and parsed.path in ("", "/") and not parsed.query and not parsed.fragment
            and "?" not in origin and "#" not in origin, "Server origin must be HTTPS, without credentials, path, query or fragment")
    require(parsed.port is None or 1 <= parsed.port <= 65535, "Invalid server port")
    return {"version": version, "build": build, "origin": origin.rstrip("/") + "/", "architectures": arch,
            "requested_ref": ref, "tag": "mac-v" + version}


def signing_mode(env):
    # PRs and explicit dry runs ignore credentials, including partially configured ones.
    if env.get("GITHUB_EVENT_NAME") != "workflow_dispatch" or env.get("RELEASE_DRY_RUN", "true") != "false":
        return "dry-run"
    present = [bool(env.get(key)) for key in SECRET_NAMES]
    require(not any(present) or all(present), "Partial signing configuration; supply all six secrets or use explicit dry-run")
    return "developer-id" if all(present) else "dry-run"


def verify_ref(config, env):
    sha = run("git", "rev-parse", "HEAD").decode().strip()
    require(re.fullmatch(r"[0-9a-f]{40}", sha), "Invalid checked-out SHA")
    if env.get("GITHUB_EVENT_NAME") == "workflow_dispatch" and env.get("RELEASE_DRY_RUN") == "false":
        require(env.get("GITHUB_REF") == "refs/tags/" + config["tag"], "Release must be dispatched from its mac-vVERSION tag")
        require(env.get("GITHUB_SHA") == sha, "Workflow and built source must have the same SHA")
        require(config["requested_ref"] in (sha, config["tag"]), "Release ref must be its full SHA or mac-vVERSION tag")
        require(run("git", "rev-parse", "refs/tags/" + config["tag"] + "^{commit}").decode().strip() == sha, "Tag does not identify built source")
        run("git", "merge-base", "--is-ancestor", sha, "origin/main")
    return sha


def validate_profile(profile, cert_der, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    expiry = profile.get("ExpirationDate")
    require(isinstance(expiry, dt.datetime), "Profile has no expiry")
    if expiry.tzinfo is None:
        expiry = expiry.replace(tzinfo=dt.timezone.utc)
    require(expiry > now, "Distribution profile has expired")
    require(profile.get("TeamIdentifier") == [TEAM], "Wrong profile team")
    prefixes = profile.get("ApplicationIdentifierPrefix")
    require(isinstance(prefixes, list) and len(prefixes) == 1 and re.fullmatch(r"[A-Z0-9]{10}", prefixes[0]), "Invalid profile application prefix")
    prefix = prefixes[0]
    require(profile.get("Platform") == ["OSX"], "Profile must be for macOS")
    require(profile.get("ProvisionsAllDevices") is True and not profile.get("ProvisionedDevices"), "A Developer ID distribution profile is required")
    require(cert_der in profile.get("DeveloperCertificates", []), "Signing certificate is not authorized by profile")
    allowed = profile.get("Entitlements", {})
    appid = prefix + "." + BUNDLE
    require(allowed.get("com.apple.application-identifier") == appid, "Profile must authorize the explicit Mac app ID")
    require(allowed.get("com.apple.developer.team-identifier") == TEAM, "Wrong entitlement team")
    require(allowed.get("com.apple.developer.applesignin") == ["Default"], "Profile must authorize Sign in with Apple Default")
    require(allowed.get("get-task-allow", False) is False and allowed.get("com.apple.security.get-task-allow", False) is False, "Debug profiles are forbidden")
    # Do not copy the profile's wildcard keychain group. Request only this app's group.
    groups = allowed.get("keychain-access-groups", [])
    require(isinstance(groups, list) and (appid in groups or prefix + ".*" in groups), "Profile does not authorize this app's keychain group")
    return {"com.apple.application-identifier": appid, "com.apple.developer.team-identifier": TEAM,
            "keychain-access-groups": [appid], "com.apple.developer.applesignin": ["Default"],
            "com.apple.security.device.audio-input": True, "com.apple.security.automation.apple-events": True}


def decode_secret(value, destination):
    try:
        decoded = base64.b64decode("".join(value.split()), validate=True)
    except Exception:
        raise ValueError("Invalid base64 release secret") from None
    require(bool(decoded), "Empty release secret")
    destination.write_bytes(decoded)
    destination.chmod(0o600)


def inventory(app, arch):
    arches = ["arm64", "x64"] if arch == "universal" else [arch]
    expected = {"Contents/MacOS/Swarm": ["arm64", "x86_64"] if arch == "universal" else ["x86_64" if arch == "x64" else arch]}
    for item in arches:
        for name in ("node", "control-host"):
            expected[f"Contents/Resources/MacControl/{item}/{name}"] = ["x86_64" if item == "x64" else item]
    found = set()
    for path in app.rglob("*"):
        if path.is_symlink():
            require(path.resolve().is_relative_to(app.resolve()) and path.exists(), "Bundle contains an escaping or broken symlink")
            continue
        if path.is_file():
            with path.open("rb") as handle:
                if handle.read(4) in MACHO:
                    found.add(path.relative_to(app).as_posix())
    require(found == set(expected), "Unexpected or missing Mach-O files; review nested signing inventory")
    for rel, cpu in expected.items():
        require(not (app / rel).is_symlink(), "Native executables must not be symlinks")
        actual = run("lipo", "-archs", app / rel).decode().strip().split()
        require(set(actual) == set(cpu), f"Wrong architecture: {rel}")
    return expected


def signature_check(path, entitlements, release, cpu):
    # Inspect all slices, not just whichever slice codesign chooses by default.
    for arch in cpu:
        result = subprocess.run(["codesign", "--display", "--verbose=4", "--arch", arch, str(path)], capture_output=True, env=child_environment())
        details = result.stderr.decode()
        require(result.returncode == 0 and "runtime" in details, "Missing hardened runtime signature")
        if release:
            require("TeamIdentifier=" + TEAM in details and "Authority=Developer ID Application:" in details and "Timestamp=" in details, "Missing Developer ID team or secure timestamp")
        else:
            require("Signature=adhoc" in details, "Expected ad-hoc dry-run signature")
        effective = run("codesign", "--display", "--arch", arch, "--entitlements", ":-", path)
        actual = plistlib.loads(effective) if effective.strip() else {}
        require(actual == entitlements, "Effective entitlements do not match reviewed entitlements")


def cleanup(directory):
    keychain = directory / "signing.keychain-db"
    try:
        if keychain.exists():
            run("security", "delete-keychain", keychain)
    finally:
        # A Keychain API failure must not retain the P12, .p8, or profile.
        if directory.exists():
            shutil.rmtree(directory)


def sign(config, env, private):
    release = config["mode"] == "developer-id"
    identity = "-"
    keychain_args = []
    app_entitlements = plistlib.loads((ROOT / "apple/Configuration/Swarm.entitlements").read_bytes())
    # Fixed reviewed capability surface, even if source templates later grow.
    require(app_entitlements == {"com.apple.security.device.audio-input": True,
            "com.apple.developer.applesignin": ["Default"], "com.apple.security.automation.apple-events": True}, "App entitlements need distribution review")
    if release:
        p12, profile, keychain = (private / name for name in ("identity.p12", "distribution.provisionprofile", "signing.keychain-db"))
        decode_secret(env["APPLE_DEVELOPER_ID_P12"], p12)
        decode_secret(env["APPLE_DEVELOPER_ID_PROFILE"], profile)
        password = secrets.token_urlsafe(32)
        run("security", "create-keychain", "-p", password, keychain)
        run("security", "set-keychain-settings", "-lut", "21600", keychain)
        run("security", "unlock-keychain", "-p", password, keychain)
        run("security", "import", p12, "-k", keychain, "-P", env["APPLE_DEVELOPER_ID_P12_PASSWORD"], "-T", "/usr/bin/codesign", "-T", "/usr/bin/security")
        run("security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychain)
        identities = run("security", "find-identity", "-v", "-p", "codesigning", keychain).decode()
        matches = re.findall(r'([A-Fa-f0-9]{40}) "(Developer ID Application:[^"\n]+)"', identities)
        require(len(matches) == 1 and matches[0][1].endswith("(" + TEAM + ")"), "Require exactly one valid Developer ID Application identity for the intended team")
        identity, common_name = matches[0]
        pem = run("security", "find-certificate", "-c", common_name, "-p", keychain)
        require(pem.count(b"BEGIN CERTIFICATE") == 1, "Ambiguous signing certificate")
        der = run("openssl", "x509", "-outform", "DER", input=pem)
        require(hashlib.sha1(der).hexdigest().upper() == identity.upper(), "Certificate/identity mismatch")
        run("openssl", "x509", "-checkend", "0", "-noout", input=pem)
        subject = run("openssl", "x509", "-subject", "-nameopt", "RFC2253", "-noout", input=pem).decode()
        require(re.search(r"(?:^|,)OU=" + TEAM + r"(?:,|$)", subject.strip().removeprefix("subject=")), "Wrong certificate organizational unit/team")
        certificate = run("openssl", "x509", "-text", "-noout", input=pem).decode()
        require("1.2.840.113635.100.6.1.13" in certificate, "Certificate lacks Developer ID Application extension")
        decoded = plistlib.loads(run("security", "cms", "-D", "-i", profile))
        app_entitlements = validate_profile(decoded, der)
        shutil.copyfile(profile, APP / "Contents/embedded.provisionprofile")
        keychain_args = ["--keychain", str(keychain)]
        config["profile"] = {"uuid": decoded.get("UUID"), "expiry": decoded["ExpirationDate"].isoformat(), "certificate_sha256": hashlib.sha256(der).hexdigest()}
    else:
        # Ad-hoc code cannot claim restricted Apple developer capabilities.
        app_entitlements.pop("com.apple.developer.applesignin")
        require(not (APP / "Contents/embedded.provisionprofile").exists(), "Dry-run must not include a provisioning profile")
    entitlement_file = private / "app-entitlements.plist"
    entitlement_file.write_bytes(plistlib.dumps(app_entitlements))
    node_entitlements_path = ROOT / "apple/Configuration/Node.entitlements"
    node_entitlements = plistlib.loads(node_entitlements_path.read_bytes())
    require(node_entitlements == {"com.apple.security.cs.allow-jit": True, "com.apple.security.cs.allow-unsigned-executable-memory": True}, "Node entitlements need distribution review")
    native = inventory(APP, config["architectures"])
    config["unsigned_sha256"] = {rel: hashlib.sha256((APP / rel).read_bytes()).hexdigest() for rel in native}
    args = ["codesign", "--force", "--options", "runtime", "--timestamp" if release else "--timestamp=none", "--sign", identity, *keychain_args]
    for rel, cpu in native.items():
        if rel == "Contents/MacOS/Swarm":
            continue
        is_node = rel.endswith("/node")
        run(*args, *(["--entitlements", node_entitlements_path] if is_node else []), APP / rel)
        signature_check(APP / rel, node_entitlements if is_node else {}, release, cpu)
    run(*args, "--entitlements", entitlement_file, APP)
    run("codesign", "--verify", "--deep", "--strict", "--verbose=2", APP)
    signature_check(APP, app_entitlements, release, native["Contents/MacOS/Swarm"])
    config["signed_sha256"] = {rel: hashlib.sha256((APP / rel).read_bytes()).hexdigest() for rel in native}
    config["entitlements"] = {"app": app_entitlements, "node": node_entitlements, "launcher": {}}
    if release:
        require(re.fullmatch(r"[A-Z0-9]{10}", env["APPLE_ASC_KEY_ID"]), "Invalid ASC key ID")
        require(re.fullmatch(r"[0-9a-fA-F-]{36}", env["APPLE_ASC_ISSUER_ID"]), "Invalid ASC issuer ID")
        key = private / "AuthKey.p8"
        key.write_text(env["APPLE_ASC_PRIVATE_KEY"])
        key.chmod(0o600)
        run("openssl", "pkey", "-in", key, "-noout")
        upload = private / "notary-upload.zip"
        run("ditto", "-c", "-k", "--keepParent", APP, upload)
        config["notary_upload_sha256"] = hashlib.sha256(upload.read_bytes()).hexdigest()
        credentials = ["--key", key, "--key-id", env["APPLE_ASC_KEY_ID"], "--issuer", env["APPLE_ASC_ISSUER_ID"]]
        submission = json.loads(run("xcrun", "notarytool", "submit", upload, *credentials, "--wait", "--timeout", "45m", "--output-format", "json"))
        require(submission.get("status") == "Accepted" and re.fullmatch(r"[0-9a-fA-F-]{36}", submission.get("id", "")), "Notarization was not Accepted")
        config["notarization"] = {"id": submission["id"], "status": submission["status"]}
        log = run("xcrun", "notarytool", "log", submission["id"], *credentials)
        (OUTPUT / "notarization-log.json").write_bytes(log)
        run("xcrun", "stapler", "staple", APP)
        run("xcrun", "stapler", "validate", APP)
        run("codesign", "--verify", "--deep", "--strict", "--verbose=2", APP)
        run("spctl", "--assess", "--type", "execute", "--verbose=2", APP)
        config["verification"] = {"stapler": "passed", "gatekeeper": "passed", "codesign": "passed"}
    else:
        config["verification"] = {"codesign": "passed", "stapler": "not-run", "gatekeeper": "not-run"}
    config["runtime_smoke"] = "pending credential-free step"
    filename = f"Swarm-{config['version']}-macos" + ("" if release else "-ADHOC-DO-NOT-DISTRIBUTE") + ".zip"
    run("ditto", "-c", "-k", "--keepParent", APP, OUTPUT / filename)
    config["archive"] = filename
    write_manifest(config)


def write_manifest(config):
    (OUTPUT / "release-manifest.json").write_text(json.dumps(config, indent=2) + "\n")
    files = sorted(p for p in OUTPUT.iterdir() if p.name != "SHA256SUMS")
    (OUTPUT / "SHA256SUMS").write_text("".join(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in files))


def smoke():
    require(not any(os.environ.get(key) for key in SECRET_NAMES), "Runtime smoke requires a credential-free step")
    config = json.loads((OUTPUT / "release-manifest.json").read_text())
    # Run only the native slice; universal cross-architecture execution is a separate release qualification.
    native_arch = "arm64" if os.uname().machine == "arm64" else "x64"
    if config["architectures"] in (native_arch, "universal"):
        payload = APP / "Contents/Resources/MacControl"
        host, node = payload / native_arch / "control-host", payload / native_arch / "node"
        for command in (["--version"], [str(payload / "companion/swarm-companion.mjs"), "--help"], [str(payload / "playwright/node_modules/@playwright/mcp/cli.js"), "--help"]):
            run(host, node, *command)
        config["runtime_smoke"] = native_arch
    else:
        config["runtime_smoke"] = "not-run: runner architecture differs"
    write_manifest(config)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("validate", "sign", "cleanup", "smoke"))
    options = parser.parse_args()
    env = os.environ
    private = Path(env.get("RUNNER_TEMP", "/tmp")) / ("swarm-signing-" + env.get("GITHUB_RUN_ID", "local") + "-" + env.get("GITHUB_RUN_ATTEMPT", "1"))
    if options.action == "cleanup":
        cleanup(private)
        return
    if options.action == "smoke":
        require(not private.exists(), "Runtime smoke requires completed signing cleanup")
        smoke()
        return
    config = inputs(env)
    config["mode"] = signing_mode(env)
    config["sha"] = verify_ref(config, env)
    if options.action == "validate":
        print(json.dumps(config, indent=2))
        return
    require(sys.platform == "darwin", "Signing requires a macOS runner")
    # Fresh output every time. Failed/retried signing cannot expose an older final artifact.
    if OUTPUT.exists():
        shutil.rmtree(OUTPUT)
    OUTPUT.mkdir(parents=True)
    private.mkdir(mode=0o700, exist_ok=False)
    os.umask(0o077)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: sys.exit(130))
    try:
        # No tracked source modifications are allowed, except XcodeGen's regenerated project.
        changed = run("git", "diff", "HEAD", "--name-only").decode().splitlines()
        require(all(p == "apple/Swarm.xcodeproj/project.pbxproj" for p in changed), "Tracked release source changed during build")
        run("node", "scripts/stage-apple-mac.mjs", "--check", "--arch", config["architectures"], "--output", APP / "Contents/Resources/MacControl")
        info_path = APP / "Contents/Info.plist"
        info = plistlib.loads(info_path.read_bytes())
        require(info.get("CFBundleIdentifier") == BUNDLE, "Wrong app bundle identifier")
        info.update(CFBundleShortVersionString=config["version"], CFBundleVersion=config["build"], SwarmDefaultServerOrigin=config["origin"])
        info_path.write_bytes(plistlib.dumps(info))
        config["toolchain"] = {"xcode": run("xcodebuild", "-version").decode().strip(), "macos": run("sw_vers", "-productVersion").decode().strip(), "xcodegen": run("xcodegen", "--version").decode().strip(), "node": run("node", "--version").decode().strip()}
        sign(config, env, private)
    except BaseException:
        shutil.rmtree(OUTPUT, ignore_errors=True)
        raise
    finally:
        try:
            cleanup(private)
        except BaseException:
            shutil.rmtree(OUTPUT, ignore_errors=True)
            raise
    if env.get("GITHUB_OUTPUT"):
        with open(env["GITHUB_OUTPUT"], "a") as output:
            output.write(f"publish={'true' if config['mode'] == 'developer-id' else 'false'}\ntag={config['tag']}\nsha={config['sha']}\n")
    print("Completed " + config["mode"] + " packaging: " + config["archive"])


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, plistlib.InvalidFileException) as error:
        # Error messages we create never contain credential values or secret argv.
        print(f"Mac release failed: {error}", file=sys.stderr)
        sys.exit(1)
