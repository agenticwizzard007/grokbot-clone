# Mac direct-download releases

Swarm for Mac is distributed from the website as a **Developer ID signed, hardened-runtime, notarized app**, outside the Mac App Store. The iOS app is the App Store client. The Mac app pairs the user's computer so they can drive it from their phone. Signing does not bypass macOS permissions: terminal/browser access, existing-browser attachment, Accessibility, Screen Recording, Automation and microphone access remain subject to the app's consent controls and macOS approval.

`.github/workflows/release-mac.yml` builds on GitHub `macos-15` runners. It runs native policy tests, stages pinned Node/Playwright dependencies, builds the complete app, checks its native-code inventory, signs nested executables before the app, notarizes, staples, verifies and publishes versioned assets. No user Mac or development signing identity is needed for the build. A ZIP is the supported installer container; no DMG or automatic updater is provided.

## Owner setup

Use GitHub **environment secrets** in an environment named `mac-release`. Configure required reviewers, prevent self-review where available, and restrict deployment to tags matching `mac-v*`. Protect these tags against updates/deletion and unauthorized creation using a repository ruleset. Keep signing credentials out of repository-wide secrets so same-repository PRs cannot access them. The `mac-release-dry-run` environment has no secrets. Restrict release dispatch to trusted maintainers; review the exact tagged commit before approving its environment deployment.

| Secret | Exact value |
| --- | --- |
| `APPLE_DEVELOPER_ID_P12` | Base64 of a password-protected `.p12` containing **one Developer ID Application certificate and its private key**, for team `A77YW376ZH`. Export the certificate plus private key from Keychain Access. An Apple Development, Apple Distribution or Developer ID Installer certificate is not suitable. |
| `APPLE_DEVELOPER_ID_P12_PASSWORD` | The nonempty password used when exporting that `.p12`. |
| `APPLE_DEVELOPER_ID_PROFILE` | Base64 of the Apple-issued **Developer ID provisioning profile** for the explicit macOS App ID `so.swarms.app.macos`, authorizing Sign in with Apple (`Default`) and the supplied certificate. Obtain this from Apple Developer Certificates, Identifiers & Profiles. Do not use the development profile from a locally installed app. |
| `APPLE_ASC_KEY_ID` | App Store Connect API key ID (10 uppercase alphanumeric characters), with access to notarize this team's app. |
| `APPLE_ASC_ISSUER_ID` | That API key's issuer UUID. Use a team API key with an issuer, not an individual key without one. |
| `APPLE_ASC_PRIVATE_KEY` | The **raw multiline PEM contents** of its `.p8` file, including BEGIN/END lines. This is not base64. This notarization key is distinct from the backend's Sign in with Apple key. |

Use your secret manager or GitHub's secret UI to transfer these values. Never put the `.p12`, passwords, profile or `.p8` into source, issue/PR text, chat, terminal tracing or build artifacts. The temporary signing Keychain and private files are deleted on normal completion, failure and catchable cancellation; an `always()` cleanup step provides another attempt. GitHub destroys the ephemeral runner after hard cancellation. The helper does not modify the user's default Keychain or search list.

The owner also chooses:

- The reviewed source commit, version (`major.minor.patch`), increasing positive build number, and supported architectures (`universal`, `arm64`, `x64`). Version numbers are unique per Mac tag; do not reuse one to replace an artifact.
- The approved **HTTPS server origin**, initially `https://swarm-team.fly.dev`, later the isolated-platform origin. Do not include a path, query, credentials or fragment. Building a client does not deploy or qualify that backend.
- The website's Mac download location and the previous compatible release to retain for rollback.

No real credentials are required for PR validation. Real Developer ID issuance, Sign in with Apple distribution authentication and notarization still require an owner-operated credentialed release; passing the dry run is not evidence of these services working.

## PR and manual dry runs

Every PR touching the workflow, release helper/tests, native app or packaging inputs builds a **universal** Mac app and ad-hoc signs it. Signing secrets are never loaded for a PR or an explicitly selected dry run. The native runner's slice executes Node, the launcher, companion help and Playwright help; the other slice's architecture and signatures are inspected. Runtime smoke runs in a separate credential-free step after signing material is removed. Signing helper subprocesses also receive an environment with all six credential variables removed. This does not replace testing on an Intel Mac and an Apple silicon Mac.

For a manual dry run, choose **Actions → Mac direct download → Run workflow**, select the reviewed pipeline branch, set `ref` to the desired commit, supply version/build/origin/architectures, and leave `dry_run` enabled. Download the `mac-distribution-<run-id>-<attempt>` Actions artifact. Its archive is named `Swarm-<version>-macos-ADHOC-DO-NOT-DISTRIBUTE.zip`. It has no provisioning profile or Apple sign-in entitlement; it is neither notarized nor published as a GitHub Release. Do not put it on the website or weaken Gatekeeper to distribute it.

A non-dry release request with **all six secrets absent** also ends in this dry-run state, without publication. A partial secret configuration fails instead of producing a misleading release. Non-dry requests must still satisfy the tag/source rules below.

Local policy tests require only Python 3.9+:

```bash
python3 -m unittest discover -s scripts/mac-release -p 'test_*.py' -v
```

Native builds and signing are tested on GitHub's macOS runners. Existing development archives in the Apple apps workflow are separate from public distribution assets.

## Release procedure

1. Merge the reviewed pipeline and app changes. Select a reviewed commit on `main` containing this workflow. Confirm backend compatibility and pick a new version/build. Create and push an immutable tag **`mac-v<version>`** at that exact commit. For example, `mac-v1.2.3`. Do not move an existing tag.
2. Dispatch **Mac direct download from that tag** (the workflow's “Use workflow from” ref must be the tag). Set `ref` to the same tag or its full 40-character SHA, set `version` to the tag's version, choose the build number/origin/architectures, and disable `dry_run`. With `gh`, the equivalent is:

   ```bash
   gh workflow run release-mac.yml --ref mac-v1.2.3 \
     -f ref=mac-v1.2.3 -f version=1.2.3 -f build_number=42 \
     -f server_origin=https://swarm-team.fly.dev \
     -f architectures=universal -f dry_run=false
   ```

3. The environment reviewer confirms the tag/SHA, version/build, origin and credentials. The checkout always uses the workflow's own commit for non-dry requests; an arbitrary input ref cannot supply code to the credentialed step. The helper also requires workflow SHA = source SHA = tag commit, and main ancestry. Source changes during the build fail (apart from the generated Xcode project).
4. The helper decodes the profile using `security cms`, verifies macOS distribution shape, expiry, team, explicit application identifier, Apple sign-in and certificate membership, then embeds it as `Contents/embedded.provisionprofile`. It checks the Developer ID leaf certificate extension, identity and validity. Profile and certificate details are never used to broaden app capabilities.
5. Distribution entitlements are generated from the verified prefix/App ID: application ID, team ID, app-scoped keychain group, Apple sign-in `Default`, microphone and Automation. Wildcard profile keychain authorization is narrowed to this app. Node alone receives the existing JIT/unsigned-executable-memory exceptions. No debug entitlement, App Sandbox or disabled library-validation exception is added. Node and launchers are signed before the outer app, with hardened runtime and timestamps. `--deep` is used only for verification. Unexpected Mach-O files or escaping symlinks fail for review.
6. The exact signed ZIP is submitted with `notarytool --wait`. Only **Accepted** can proceed. The app is stapled, `stapler validate`, strict signature verification and `spctl --assess` must pass, and a **new ZIP containing the stapled app** is created. No failed or pending submission may publish.
7. A separate Linux job with `contents: write` rechecks source/tag, artifact manifest and all checksums. It creates a draft release, uploads all assets, then publishes it. Existing releases are never overwritten. The release is not marked GitHub's generic “latest”, keeping Mac assets separate from other product releases.

Published assets:

- `Swarm-<version>-macos.zip`
- `SHA256SUMS` (archive, manifest and notarization log)
- `release-manifest.json` (source, inputs, toolchain, profile UUID/expiry, certificate fingerprint, unsigned/signed executable hashes, effective entitlements, notary submission/upload digest, verification results)
- `notarization-log.json`

The transient upload ZIP, Keychain, `.p12`, raw decoded profile and `.p8` are not uploaded separately. The verified provisioning profile is necessarily included **inside** the signed app. Preserve the public manifest/log/checksums with the release. The signature and notarization checks are performed on all included native slices; runtime help smoke runs only for the runner's own architecture.

## Website download and final qualification

Pin the website to the approved versioned URL, not an ambiguous `latest/download` link:

```text
https://github.com/agenticwizzard007/grokbot-clone/releases/download/mac-v1.2.3/Swarm-1.2.3-macos.zip
https://github.com/agenticwizzard007/grokbot-clone/releases/download/mac-v1.2.3/SHA256SUMS
```

Show “Download for Mac”, version, minimum macOS 14, supported CPU architectures and a checksum link. If the repository is private, these GitHub URLs require login: the owner must choose a public distribution repository or copy the **unchanged** verified assets to a public website/CDN and link both ZIP and checksum there. Website/CDN publication is separate from this repository's release workflow.

For archive verification, compare its `shasum -a 256` output with the matching line in `SHA256SUMS`. To use `shasum -a 256 -c SHA256SUMS`, also download the listed manifest and notarization log. HTTPS delivery and the Apple signature establish provenance; a checksum alone does not authenticate a publisher.

Before making the website link public, download through the actual browser channel with quarantine intact. Test installation, cold launch, upgrade, native Apple sign-in, microphone, local pairing and phone-driven control on the claimed architectures. Verify grant/denial/revocation, Stop/Disconnect/logout/server changes, and existing-browser attachment consent. No automatic TCC grant or root access is part of this pipeline. The server-origin input stamps `SwarmDefaultServerOrigin` into the built Info.plist before signing; native code validates HTTPS and falls back safely. Existing saved server choices take precedence. iOS's default is unchanged.

## Failure and rollback

An invalid profile/certificate, unknown native file, changed source/tag, failed signature, unaccepted notarization, failed staple/Gatekeeper check or checksum mismatch stops publication. Failed signing removes its output directory; reruns cannot upload an older successful artifact. Temporary credentials are cleaned up. For diagnostic failures the helper intentionally omits credential-bearing command arguments/output from logs.

A failed GitHub upload may leave a **draft** release. Inspect the run and draft before deleting that unpublished draft and retrying the same immutable tag. Never delete/rewrite an already public artifact to retry; issue a new version/build instead. Re-signing changes bytes and requires a new notarization submission.

To roll back the website, restore its link to a previously retained, compatible, notarized version and its checksum. Have users quit Swarm and stop/disconnect companion work before replacing the app in Applications. Preserve user data and Keychain entries. Confirm server compatibility and the intended default origin; coordinate any server rollback separately. There is no automatic client downgrade or backend deployment in this workflow.
