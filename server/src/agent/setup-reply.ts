/** The obsolete interview refusal must never become an active Bot's answer. */
export const isSetupRefusal = (text: string) => /i['\u2019]m\s+still\s+being\s+set\s+up\s*[.!]?\s*tap\s+skip\s+setup/i.test(text);

export function messageText(item: any): string {
  if (item?.role !== 'assistant' && item?.type !== 'message') return '';
  return typeof item.content === 'string' ? item.content : (item.content ?? []).map((part: any) => part.text ?? '').join('');
}

/** Change model context only. Original transcript and operational history stay intact. */
export const operationalHistory = (history: any[]) => history.filter(item => item.role !== 'assistant' || !isSetupRefusal(messageText(item)));
