# Sign in with Apple

Swarm supports **Apple, Google, and phone sign-in on the web, iPhone, iPad, and Mac**. Apple uses the native `ASAuthorizationAppleIDProvider` sheet in the Apple apps and an authorization-code browser flow on the web. The same server verifies both. Apple is shown when the credentials for the current client are configured; Google and phone remain available independently. Development email login stays limited to `DEV_LOGIN=1`.

The Xcode project uses the confirmed development team **A77YW376ZH**. A development signing certificate is not a Sign in with Apple private key. The server needs a separate `.p8` key enabled for Sign in with Apple; an App Store Connect API key is not interchangeable.

## Apple Developer configuration

First, have the account holder accept any pending **Apple Developer Program License Agreement** at [Apple Developer](https://developer.apple.com/account/). Apple blocks provisioning and membership resources until that is done.

In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list):

1. Enable **Sign in with Apple** for the primary App ID `so.swarms.app` (iOS/iPadOS).
2. Enable it for `so.swarms.app.macos` and group that App ID with the primary App ID. Both Xcode targets contain the `com.apple.developer.applesignin` entitlement. Regenerate provisioning profiles after enabling the capability.
3. Create or select a **Services ID** for web sign-in. Enable Sign in with Apple and associate it with the same primary App ID. Grouping keeps the Apple user identifier consistent across the apps and web.
4. Register the web domain and the **exact** return URL: `https://swarm-team.fly.dev/api/auth/apple/callback` for the default deployment. If the server uses another public origin, register that origin instead and set `APP_URL` and `SERVER_URL` to it. Apple requires a public HTTPS domain; localhost and IP-address callbacks are not supported.
5. Create or locate a **Sign in with Apple** key for the primary App ID. Record its Key ID and store the `.p8` file securely. Apple offers the download only once. Do not commit it, embed it in the apps, or paste it into chat.

Apple's references: [configure web authentication](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web/), [create a private key](https://developer.apple.com/help/account/capabilities/create-a-sign-in-with-apple-private-key/), and [validate authorization codes](https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens).

## Server secrets

Set these on the server (examples for the nonsecret IDs):

```dotenv
APPLE_TEAM_ID=A77YW376ZH
APPLE_KEY_ID=YOURKEYID1
APPLE_SERVICE_ID=your.existing.web.services.id
APPLE_IOS_CLIENT_ID=so.swarms.app
APPLE_MACOS_CLIENT_ID=so.swarms.app.macos
```

Also set either `APPLE_PRIVATE_KEY` to the PEM contents (literal `\n` escapes are supported), or `APPLE_PRIVATE_KEY_PATH` to a readable server-side file containing the PEM. Keep `SESSION_SECRET` stable: it encrypts the Apple refresh tokens retained for account-deletion revocation. Client secrets are generated server-side, signed with ES256, scoped to the requested client ID, and expire after five minutes.

For Fly, the included helper validates a local P-256 key and **stages** the secrets through stdin without printing them:

```sh
node scripts/configure-apple-sign-in.mjs \
  --key=/secure/path/AuthKey_YOURKEYID1.p8 \
  --key-id=YOURKEYID1 \
  --service=your.existing.web.services.id \
  --team=A77YW376ZH \
  --app=swarm-team
```

It requires a logged-in Fly CLI. Staging does not restart production. Deploy the tested server and web changes together afterward. No key goes into a command-line argument: the `--key` argument is a file path. The helper does not create Apple Developer identifiers or capabilities; configure those in the portal first. Changing a key requires a replacement with the same client access; do not remove a client ID while accounts still have revocation tokens associated with it.

## Account behavior

- A new Apple user receives a normal Swarm account and primary bot. **Hide My Email** is supported.
- Returning sign-ins use Apple's stable subject, so a missing name/email on subsequent authorizations does not create another account. The name is display text; identity evidence comes only from Apple's signed token.
- If that verified email already belongs to a Swarm account, Apple sign-in asks the person to use Google or phone first, then choose **Settings → Account → Connect Apple**. It does not silently merge accounts by matching email strings.
- Explicit linking requires a valid existing Swarm session. A different account cannot take over an already-linked Apple identity. Logging out invalidates a pending linking attempt.
- **Settings → Account → Delete account** requires confirmation and revokes stored Apple refresh tokens before account deletion. Revocation failures retain the account and credentials so deletion can be retried. The same revocation applies to the existing account-deletion command by text.

Web callbacks use `response_mode=form_post` and a Secure, HttpOnly, SameSite=None attempt cookie. Invalid/missing state, missing browser cookies, reused/expired attempts, invalid Apple signatures, wrong issuer/audience/nonce, and unverified first-sign-in emails fail closed. Apple token requests go only to Apple's fixed HTTPS endpoints. App-issued sign-in attempts also require a random verifier, so intercepting an authorization response is insufficient to redeem the app's session.

Apple authorization codes and ID tokens are never stored in the browser, WebKit JavaScript, or callback URLs. Refresh tokens are encrypted in the server database and used for revocation. Existing Swarm session cookies remain HttpOnly and Secure on HTTPS deployments.

## Validation and activation

The hosted deployment at `https://swarm-team.fly.dev` was configured on November
10, 2026 with team `A77YW376ZH`, Services ID `so.swarms.app.web`, and key ID
`8BWN677W2T`. The primary App ID is `so.swarms.app` (Swarm); the Services ID and
`so.swarms.app.macos` are grouped under it. Its registered return URL is
`https://swarm-team.fly.dev/api/auth/apple/callback`. The private key is stored
as a Fly secret, with an owner-only backup in the account holder's local Swarm
application-support directory; it is not part of this repository or app bundles.

The deployed web, iOS, and macOS configurations advertise Apple sign-in along
with Google and phone. Apple's live web authorization page accepts this Services
ID and callback. Both native targets have passed signed development builds and
code-signature verification. These checks do not replace completing a real
user authorization on each platform or App Store/TestFlight distribution.
The signed macOS app reaches Apple's native authorization UI. The development
Mac currently asks the user to sign in to an Apple Account in System Settings;
the Safari Apple Developer login does not sign macOS into an Apple Account.

```sh
npm run typecheck
npm run build
npm run test:apple-auth
npm run test:native-auth
npm run test:composio
npm run test:mobile
npm run apple:ios
npm run apple:macos
```

The Apple tests use generated signing keys and mocked Apple endpoints, covering native/web first and returning sign-in, private relay email, linking, cookie binding, expiry/replay, wrong audience/nonce/signature, denial, and revocation retry. They do not authenticate a real Apple Account.

After supplying real credentials and deploying, verify on a properly provisioned device and Mac: first sign-in, Hide My Email, cancellation, returning sign-in, linking to an existing phone/Google account, and account deletion. Native Sign in with Apple needs matching App IDs, entitlements, a signed app, and a valid provisioning profile. An unsigned simulator build passing compilation cannot prove live Apple authentication works.
