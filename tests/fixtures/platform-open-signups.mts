// Infrastructure fixtures create fresh verified identities to exercise lifecycle,
// routing and storage. Select open admission explicitly in those test processes.
// Admission tests separately cover invite/closed policy and production defaults.
process.env.MESSAGING_SIGNUP_MODE ??= 'open';
