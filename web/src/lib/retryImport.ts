import { readDeadline } from './readDeadline';

/** A failed module fetch is cached by browsers, so retry its same-origin URL once with a fresh query. */
export async function retryImport<T>(load: () => Promise<T>, retry: (url: string) => Promise<T>, origin: string): Promise<T> {
  return readDeadline(async () => {
    try { return await load(); }
    catch (error) {
      const raw = String((error as Error).message).match(/https?:\/\/[^\s"'<>]+\.js(?:\?[^\s"'<>]*)?/)?.[0];
      if (!raw) throw error;
      const url = new URL(raw);
      if (url.origin !== origin) throw error;
      url.searchParams.set('retry', String(Date.now()));
      return retry(url.href);
    }
  }, 4500);
}
