import assert from 'node:assert/strict';

export async function useAccessViteAssets(context, backend) {
  const dev = process.env.ACCESS_UI_DEV_ASSETS;
  if (!dev) return;
  assert.match(dev, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
  await context.route(url => url.origin === backend && !url.pathname.startsWith('/api/'), async route => {
    const { pathname, search } = new URL(route.request().url());
    const response = await fetch(`${dev}${pathname}${search}`);
    const body = Buffer.from(await response.arrayBuffer());
    await route.fulfill({ status: response.status, contentType: response.headers.get('content-type') ?? undefined, body });
  });
}
