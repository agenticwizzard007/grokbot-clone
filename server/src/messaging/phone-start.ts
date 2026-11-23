/** Browser-safe contract shared by standalone, platform and the phone form. */
export interface PhoneStartLine {
  number: string;
  connectCommand: string;
  smsLink: string;
  whatsapp?: { messageLink: string } | null;
}

export type PhoneStart =
  | { id: string; delivery: 'sent'; textNumber: null; line: null }
  | { id: string; delivery: 'text-first'; textNumber: string; line: null }
  | { id: string; delivery: 'text-first'; textNumber: null; line: PhoneStartLine };

export const PHONE_START_UNAVAILABLE = 'Phone sign-in is temporarily unavailable. Try again later or use another sign-in method.';
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown): v is string => typeof v === 'string' && /^\+\d{8,15}$/.test(v);

/** Never open a code form unless sending was confirmed or the person has a usable contact path. */
export function parsePhoneStart(value: unknown): PhoneStart | null {
  if (!record(value) || typeof value.id !== 'string' || !value.id.trim()) return null;
  const id = value.id;
  if (value.delivery === 'sent') return { id, delivery: 'sent', textNumber: null, line: null };
  if (value.delivery !== 'text-first') return null;
  if (number(value.textNumber)) return { id, delivery: 'text-first', textNumber: value.textNumber, line: null };
  const line = value.line;
  if (!record(line) || !number(line.number) || typeof line.connectCommand !== 'string'
    || !/^connect @\S+$/.test(line.connectCommand) || typeof line.smsLink !== 'string') return null;
  try {
    const link = new URL(line.smsLink);
    if (link.protocol !== 'sms:' || link.pathname !== line.number || link.searchParams.get('body') !== line.connectCommand) return null;
  } catch { return null; }
  // WhatsApp is optional. Only show it when the provider supplied a usable link.
  let whatsapp: PhoneStartLine['whatsapp'] = null;
  if (record(line.whatsapp) && typeof line.whatsapp.messageLink === 'string') {
    try {
      const link = new URL(line.whatsapp.messageLink);
      if (link.protocol === 'https:' && link.hostname === 'wa.me' && /^\/\d{8,15}$/.test(link.pathname)
        && link.searchParams.get('text')?.trim()) whatsapp = { messageLink: link.href };
    } catch { /* The iMessage instructions remain usable. */ }
  }
  return { id, delivery: 'text-first', textNumber: null, line: { number: line.number, connectCommand: line.connectCommand, smsLink: line.smsLink, whatsapp } };
}

export async function phoneStartResponse(id: string, delivery: 'sent' | 'text-first', textNumber: string | null, line: () => Promise<unknown>): Promise<PhoneStart | null> {
  const response = { id, delivery, textNumber, line: null };
  return parsePhoneStart(response) ?? parsePhoneStart({ ...response, line: await line().catch(() => null) });
}
