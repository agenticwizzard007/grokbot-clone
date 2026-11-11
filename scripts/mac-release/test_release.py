import copy
import datetime as dt
import hashlib
import importlib.util
import json
from pathlib import Path
import plistlib
import tempfile
import unittest
from unittest.mock import patch


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


release = module("release")
publish = module("publish")


class ReleasePolicyTests(unittest.TestCase):
    def setUp(self):
        self.env = dict(RELEASE_VERSION="1.2.3", RELEASE_BUILD="42", RELEASE_ORIGIN="https://platform.example.com",
                        RELEASE_ARCH="universal", RELEASE_REF="mac-v1.2.3", GITHUB_EVENT_NAME="workflow_dispatch", RELEASE_DRY_RUN="false")
        self.appid = release.TEAM + "." + release.BUNDLE
        self.profile = {"ExpirationDate": dt.datetime(2099, 1, 1), "TeamIdentifier": [release.TEAM],
                        "ApplicationIdentifierPrefix": [release.TEAM], "Platform": ["OSX"], "ProvisionsAllDevices": True,
                        "DeveloperCertificates": [b"actual certificate"], "Entitlements": {
                            "com.apple.application-identifier": self.appid, "com.apple.developer.team-identifier": release.TEAM,
                            "keychain-access-groups": [release.TEAM + ".*"], "com.apple.developer.applesignin": ["Default"]}}

    def test_origin_validation_and_normalization(self):
        self.assertEqual(release.inputs(self.env)["origin"], "https://platform.example.com/")
        for value in ("http://example.com", "https://u:p@example.com", "https://example.com/api", "https://example.com?q", "https://example.com#fragment", "https://example.com?", "https://example.com/#", "https://example.com:0", "https://example.com:65536", "https://example.com\\@evil.com", "https://example.com\n"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                release.inputs({**self.env, "RELEASE_ORIGIN": value})

    def test_version_build_arch_ref_validation(self):
        for field, value in (("RELEASE_VERSION", "1.2.3;echo bad"), ("RELEASE_VERSION", "../escape"), ("RELEASE_VERSION", "01.2.3"), ("RELEASE_BUILD", "-1"), ("RELEASE_BUILD", "1e3"), ("RELEASE_ARCH", "x86_64"), ("RELEASE_REF", "--help"), ("RELEASE_REF", "$(printenv)")):
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                release.inputs({**self.env, field: value})

    def test_secret_mode_matrix(self):
        full = {**self.env, **{name: "secret" for name in release.SECRET_NAMES}}
        self.assertEqual(release.signing_mode(self.env), "dry-run")
        self.assertEqual(release.signing_mode(full), "developer-id")
        self.assertEqual(release.signing_mode({**full, "GITHUB_EVENT_NAME": "pull_request"}), "dry-run")
        self.assertEqual(release.signing_mode({**full, "RELEASE_DRY_RUN": "true"}), "dry-run")
        for missing in release.SECRET_NAMES:
            partial = {**full, missing: ""}
            with self.subTest(missing=missing), self.assertRaises(ValueError):
                release.signing_mode(partial)
            self.assertEqual(release.signing_mode({**partial, "GITHUB_EVENT_NAME": "pull_request"}), "dry-run")

    def test_narrow_entitlements_from_profile(self):
        self.profile["Entitlements"]["com.apple.security.cs.disable-library-validation"] = True
        ent = release.validate_profile(self.profile, b"actual certificate")
        self.assertEqual(ent["keychain-access-groups"], [self.appid])
        self.assertNotIn("com.apple.security.cs.disable-library-validation", ent)
        self.assertNotIn("get-task-allow", ent)
        self.assertNotIn("com.apple.security.cs.allow-jit", ent)
        self.assertEqual(len(ent), 6)

    def test_prefix_comes_from_profile_not_certificate_team(self):
        self.profile["ApplicationIdentifierPrefix"] = ["ABCDEFGHIJ"]
        self.profile["Entitlements"]["com.apple.application-identifier"] = "ABCDEFGHIJ." + release.BUNDLE
        self.profile["Entitlements"]["keychain-access-groups"] = ["ABCDEFGHIJ.*"]
        ent = release.validate_profile(self.profile, b"actual certificate")
        self.assertEqual(ent["keychain-access-groups"], ["ABCDEFGHIJ." + release.BUNDLE])
        self.assertEqual(ent["com.apple.developer.team-identifier"], release.TEAM)

    def test_reject_profile_mismatches(self):
        variants = [("ExpirationDate", dt.datetime(2000, 1, 1)), ("TeamIdentifier", ["OTHERTEAM1"]), ("ApplicationIdentifierPrefix", []), ("Platform", ["iOS"]), ("ProvisionsAllDevices", False), ("ProvisionedDevices", ["device"]), ("DeveloperCertificates", [b"different certificate"])]
        for key, value in variants:
            profile = {**self.profile, key: value}
            with self.subTest(key=key), self.assertRaises(ValueError):
                release.validate_profile(profile, b"actual certificate")
        for key, value in (("com.apple.application-identifier", release.TEAM + ".*"), ("com.apple.developer.team-identifier", "OTHERTEAM1"), ("com.apple.developer.applesignin", []), ("get-task-allow", True), ("com.apple.security.get-task-allow", True), ("keychain-access-groups", ["OTHERTEAM1.*"])):
            profile = copy.deepcopy(self.profile)
            profile["Entitlements"][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                release.validate_profile(profile, b"actual certificate")

    def test_credential_errors_do_not_echo_command_arguments(self):
        with patch.object(release.subprocess, "run") as run:
            run.return_value.returncode = 1
            with self.assertRaisesRegex(ValueError, "security failed") as caught:
                release.run("security", "import", "secret-file", "-P", "private-password")
            self.assertNotIn("private-password", str(caught.exception))

    def test_release_ref_requires_same_workflow_tag_and_main_ancestry(self):
        sha = "a" * 40
        config = {**release.inputs(self.env), "mode": "developer-id"}
        env = {**self.env, "GITHUB_REF": "refs/tags/mac-v1.2.3", "GITHUB_SHA": sha}
        with patch.object(release, "run", return_value=sha.encode()) as run:
            self.assertEqual(release.verify_ref(config, env), sha)
            self.assertIn(unittest.mock.call("git", "merge-base", "--is-ancestor", sha, "origin/main"), run.call_args_list)
            for changed in ({"GITHUB_REF": "refs/heads/main"}, {"GITHUB_SHA": "b" * 40}):
                with self.assertRaises(ValueError):
                    release.verify_ref(config, {**env, **changed})
            with self.assertRaises(ValueError):
                release.verify_ref({**config, "requested_ref": "unreviewed"}, env)
        with patch.object(release, "run", side_effect=[sha.encode(), ("b" * 40).encode()]), self.assertRaises(ValueError):
            release.verify_ref(config, env)

    def test_inventory_rejects_unexpected_native_and_escaping_symlinks(self):
        with tempfile.TemporaryDirectory() as folder:
            app = Path(folder) / "Swarm.app"
            known = ["Contents/MacOS/Swarm", "Contents/Resources/MacControl/arm64/node", "Contents/Resources/MacControl/arm64/control-host"]
            for rel in known:
                file = app / rel
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(bytes.fromhex("feedfacf"))
            with patch.object(release, "run", return_value=b"arm64"):
                self.assertEqual(set(release.inventory(app, "arm64")), set(known))
                extra = app / "unexpected.node"
                extra.write_bytes(bytes.fromhex("feedfacf"))
                with self.assertRaises(ValueError):
                    release.inventory(app, "arm64")
                extra.unlink()
                (app / "escape").symlink_to(Path(folder))
                with self.assertRaises(ValueError):
                    release.inventory(app, "arm64")

    def test_cleanup_deletes_only_private_keychain_and_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            private = Path(folder) / "run"
            private.mkdir()
            (private / "signing.keychain-db").write_text("synthetic")
            (private / "AuthKey.p8").write_text("synthetic")
            sibling = Path(folder) / "unrelated"
            sibling.write_text("keep")
            with patch.object(release, "run") as run:
                release.cleanup(private)
                run.assert_called_once_with("security", "delete-keychain", private / "signing.keychain-db")
            self.assertFalse(private.exists())
            self.assertEqual(sibling.read_text(), "keep")


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.sha, self.tag = "a" * 40, "mac-v1.2.3"
        self.manifest = {"mode": "developer-id", "runtime_smoke": "arm64", "architectures": "universal", "sha": self.sha, "tag": self.tag, "archive": "Swarm-1.2.3-macos.zip",
                         "notarization": {"status": "Accepted"}, "verification": {"stapler": "passed", "gatekeeper": "passed", "codesign": "passed"}}
        (self.folder / "Swarm-1.2.3-macos.zip").write_bytes(b"synthetic archive")
        (self.folder / "notarization-log.json").write_text("{}")
        self.write()

    def write(self):
        (self.folder / "release-manifest.json").write_text(json.dumps(self.manifest))
        files = sorted(p for p in self.folder.iterdir() if p.name != "SHA256SUMS")
        (self.folder / "SHA256SUMS").write_text("".join(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n" for p in files))

    def test_valid_artifact(self):
        self.assertEqual(len(publish.verify(self.folder, self.tag, self.sha)[1]), 4)

    def test_never_publish_dry_run_unaccepted_unstapled_or_other_source(self):
        for key, value in (("runtime_smoke", "pending credential-free step"), ("mode", "dry-run"), ("sha", "b" * 40), ("tag", "mac-v2.0.0"), ("notarization", {"status": "In Progress"}), ("verification", {"codesign": "passed"})):
            original = self.manifest[key]
            self.manifest[key] = value
            self.write()
            with self.subTest(key=key), self.assertRaises(ValueError):
                publish.verify(self.folder, self.tag, self.sha)
            self.manifest[key] = original

    def test_tampering_missing_checksum_and_extra_assets(self):
        archive = self.folder / "Swarm-1.2.3-macos.zip"
        archive.write_bytes(b"changed")
        with self.assertRaises(ValueError):
            publish.verify(self.folder, self.tag, self.sha)
        self.write()
        (self.folder / "SHA256SUMS").write_text("")
        with self.assertRaises(ValueError):
            publish.verify(self.folder, self.tag, self.sha)
        (self.folder / "AuthKey.p8").write_text("must never upload")
        self.write()
        with self.assertRaises(ValueError):
            publish.verify(self.folder, self.tag, self.sha)

class SigningSequenceTests(unittest.TestCase):
    def test_synthetic_developer_id_signing_notary_and_staple_order(self):
        # Synthetic subprocess receipts exercise control flow only, never Apple services.
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            app, output, private = folder / "Swarm.app", folder / "output", folder / "private"
            output.mkdir()
            private.mkdir()
            native = {"Contents/MacOS/Swarm": ["arm64"], "Contents/Resources/MacControl/arm64/node": ["arm64"], "Contents/Resources/MacControl/arm64/control-host": ["arm64"]}
            for name in native:
                path = app / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"synthetic unsigned native code")
            cert = b"synthetic certificate"
            identity = hashlib.sha1(cert).hexdigest().upper()
            common_name = "Developer ID Application: Synthetic Owner (" + release.TEAM + ")"
            fixture = ReleasePolicyTests()
            fixture.setUp()
            profile = fixture.profile
            profile["DeveloperCertificates"] = [cert]
            env = {**fixture.env, **{name: "synthetic" for name in release.SECRET_NAMES}}
            import base64
            env.update(APPLE_DEVELOPER_ID_P12=base64.b64encode(b"synthetic p12").decode(), APPLE_DEVELOPER_ID_PROFILE=base64.b64encode(b"synthetic cms").decode(), APPLE_ASC_KEY_ID="ABCDEFGHIJ", APPLE_ASC_ISSUER_ID="12345678-1234-1234-1234-123456789abc")
            calls = []
            def command(*args, **kwargs):
                args = tuple(str(a) for a in args)
                calls.append(args)
                if args[:2] == ("security", "find-identity"):
                    return f'1) {identity} "{common_name}"'.encode()
                if args[:2] == ("security", "find-certificate"):
                    return b"-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----"
                if args[:4] == ("openssl", "x509", "-outform", "DER"):
                    return cert
                if args[:3] == ("openssl", "x509", "-subject"):
                    return ("subject=CN=Synthetic,OU=" + release.TEAM + ",O=Synthetic\n").encode()
                if args[:3] == ("openssl", "x509", "-text"):
                    return b"1.2.840.113635.100.6.1.13"
                if args[:2] == ("security", "cms"):
                    return plistlib.dumps(profile)
                if args[0] == "ditto":
                    Path(args[-1]).write_bytes(b"synthetic archive")
                if args[:3] == ("xcrun", "notarytool", "submit"):
                    return b'{"status":"Accepted","id":"12345678-1234-1234-1234-123456789abc"}'
                if args[:3] == ("xcrun", "notarytool", "log"):
                    return b'{"status":"Accepted"}'
                return b""
            config = {**release.inputs(env), "mode": "developer-id"}
            with patch.object(release, "APP", app), patch.object(release, "OUTPUT", output), patch.object(release, "inventory", return_value=native), patch.object(release, "signature_check") as check, patch.object(release, "run", side_effect=command):
                release.sign(config, env, private)
            signs = [args for args in calls if args[0] == "codesign" and "--sign" in args]
            self.assertEqual([args[-1] for args in signs], [str(app / path) for path in list(native)[1:]] + [str(app)])
            self.assertTrue(all("--deep" not in args and "--timestamp" in args and "runtime" in args for args in signs))
            self.assertEqual(check.call_count, 3)
            staple = next(i for i, args in enumerate(calls) if args[:3] == ("xcrun", "stapler", "staple"))
            final_zip = max(i for i, args in enumerate(calls) if args[0] == "ditto")
            gatekeeper = next(i for i, args in enumerate(calls) if args[0] == "spctl")
            self.assertLess(staple, gatekeeper)
            self.assertLess(gatekeeper, final_zip)
            self.assertEqual(config["notarization"]["status"], "Accepted")
            self.assertTrue((output / "Swarm-1.2.3-macos.zip").exists())
            # Unaccepted notarization must stop before staple/final ZIP.
            calls.clear()
            def rejected(*args, **kwargs):
                result = command(*args, **kwargs)
                if tuple(args[:3]) == ("xcrun", "notarytool", "submit"):
                    return b'{"status":"In Progress","id":"12345678-1234-1234-1234-123456789abc"}'
                return result
            with patch.object(release, "APP", app), patch.object(release, "OUTPUT", output), patch.object(release, "inventory", return_value=native), patch.object(release, "signature_check"), patch.object(release, "run", side_effect=rejected), self.assertRaisesRegex(ValueError, "not Accepted"):
                release.sign(config, env, private)
            self.assertFalse(any(args[:3] == ("xcrun", "stapler", "staple") for args in calls))

    def test_failure_removes_stale_output_and_private_material(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            app, output = folder / "Swarm.app", folder / "output"
            (app / "Contents").mkdir(parents=True)
            (app / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": release.BUNDLE}))
            output.mkdir()
            (output / "old-release.zip").write_text("must not survive")
            fixture = ReleasePolicyTests()
            fixture.setUp()
            env = {**fixture.env, "RELEASE_DRY_RUN": "true", "RUNNER_TEMP": str(folder), "GITHUB_RUN_ID": "1234", "GITHUB_RUN_ATTEMPT": "1"}
            def failure(config, unused_env, private):
                self.assertFalse((output / "old-release.zip").exists())
                (private / "AuthKey.p8").write_text("synthetic")
                (private / "signing.keychain-db").write_text("synthetic")
                (output / "partial.zip").write_text("must not survive")
                raise ValueError("synthetic signing failure")
            with patch.dict(release.os.environ, env, clear=True), patch.object(release.sys, "argv", ["release.py", "sign"]), patch.object(release.sys, "platform", "darwin"), patch.object(release, "APP", app), patch.object(release, "OUTPUT", output), patch.object(release, "verify_ref", return_value="a" * 40), patch.object(release, "run", return_value=b""), patch.object(release.signal, "signal"), patch.object(release, "sign", side_effect=failure), self.assertRaisesRegex(ValueError, "synthetic signing failure"):
                release.main()
            self.assertFalse(output.exists())
            self.assertFalse((folder / "swarm-signing-1234-1").exists())


class CredentialBoundaryTests(unittest.TestCase):
    def test_subprocess_environment_strips_all_signing_credentials(self):
        import sys
        with patch.dict(release.os.environ, {name: "synthetic-private-value" for name in release.SECRET_NAMES}):
            observed = json.loads(release.run(sys.executable, "-c", "import os,json; print(json.dumps(dict(os.environ)))"))
        self.assertTrue(all(name not in observed for name in release.SECRET_NAMES))

    def test_keychain_deletion_failure_still_removes_every_private_file(self):
        with tempfile.TemporaryDirectory() as folder:
            private = Path(folder) / "private"
            private.mkdir()
            for name in ("signing.keychain-db", "identity.p12", "AuthKey.p8", "distribution.provisionprofile"):
                (private / name).write_text("synthetic")
            with patch.object(release, "run", side_effect=ValueError("security failed")), self.assertRaisesRegex(ValueError, "security failed"):
                release.cleanup(private)
            self.assertFalse(private.exists())

    def test_runtime_smoke_refuses_credentialed_environment(self):
        with patch.dict(release.os.environ, {"APPLE_ASC_PRIVATE_KEY": "synthetic"}), self.assertRaisesRegex(ValueError, "credential-free"):
            release.smoke()


if __name__ == "__main__":
    unittest.main()
