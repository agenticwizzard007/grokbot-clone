# Text sign-in delivery limits

`POST /api/auth/text/request` admits at most 3 requests per normalized phone number and 10 per source address in a rolling 10-minute window. Both checks happen before account lookup or token creation. Known and unknown numbers receive the same success or throttle response. Source attempts count even when the recipient quota is full.

The process stores at most 10,000 source and recipient buckets combined. Each bucket holds at most its quota of timestamps. Requests reclaim expired buckets, including those belonging to other identities. At capacity, new buckets are refused without evicting active limits. Restarting the process clears quotas; multiple server processes do not share them. The standalone deployment uses one server process.

Messaging routes use the socket peer by default and ignore forwarding headers. If socket information is unavailable, requests share an `unknown` source quota. IPv4-mapped IPv6 and alternate IPv6 spellings are normalized.

To use a reverse proxy, set `MESSAGING_TRUSTED_PROXY_CIDRS` to a comma-separated list of its exact address CIDRs. Only include proxies you control that append the actual upstream peer to, or overwrite, `X-Forwarded-For`. The resolver walks from the socket toward the client and stops at the first untrusted hop. Invalid configuration prevents startup; malformed or oversized trusted header chains fall back to the socket peer. Other client-address headers are ignored. The same address policy applies to the existing phone-code and invite handlers; their quotas are unchanged.

No Fly or private-network range is implicitly trusted. Until a deployment's immediate proxy addresses and header behavior are verified, leave the allowlist empty. Requests through a shared proxy then share its source quota, which is conservative but can reduce availability. Configure exact verified proxy ranges rather than trusting an entire shared network. This change does not claim to verify live Fly header sanitization.

Local validation: `node --import tsx --test tests/text-signin-limits.test.mts tests/text-signin-routes.test.mts`. The route fixture uses temporary SQLite, `DEV_LOGIN=1`, a local Hono server, and mocked messaging, model and toolkit backends.
