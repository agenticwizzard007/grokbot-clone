/** Bound read-only work, including response bodies and upstreams that ignore abort. */
export async function readDeadline<T>(read: (signal: AbortSignal) => Promise<T>, ms = 4000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([read(controller.signal), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Unavailable. Please retry.')); }, ms);
    })]);
  } finally { clearTimeout(timer!); }
}
