// Pure provider event decoding; safe to import in the platform without tenant SQLite.
type Channel = 'imessage' | 'sms' | 'whatsapp';
const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');
const dict = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as any) : null);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

export interface Parsed {
  channel: Channel;
  phone: string;
  conversationId?: string;
  messageId: string;
  text: string;
  replyTo?: string;
  media: { url: string; mime: string }[];
  reaction?: { targetId: string; kind: string };
  name?: string;
}

/** Normalize an Inkbox webhook event. Delivery lifecycle events and groups return null. */
export function parseEvent(p: any): Parsed | null {
  const type = str(p?.event_type);
  const data = dict(p?.data);
  if (!type || !data) return null;
  const media = (m: any) => (Array.isArray(m) ? m : []).map((x: any) => ({ url: str(x?.url) ?? '', mime: str(x?.content_type) ?? str(x?.mime_type) ?? '' })).filter((x: any) => x.url);
  const nameFor = (num: string) => (Array.isArray(data.contacts) ? data.contacts : []).find((c: any) => digits(c?.phone_number ?? c?.number) === num)?.name;
  if (type === 'imessage.received') {
    const m = dict(data.message);
    if (!m || m.is_group === true) return null;
    const phone = digits(str(m.remote_number) ?? str(m.sender_number));
    if (!phone || !str(m.id)) return null;
    return { channel: 'imessage', phone, conversationId: str(m.conversation_id), messageId: m.id, text: str(m.content) ?? str(m.text) ?? '', replyTo: str(m.reply_to_message_id), media: media(m.media), name: nameFor(phone) };
  }
  if (type === 'imessage.reaction_received') {
    const r = dict(data.reaction);
    if (!r) return null;
    const phone = digits(str(r.remote_number));
    if (!phone) return null;
    return { channel: 'imessage', phone, conversationId: str(r.conversation_id), messageId: str(r.id) ?? `${r.target_message_id}:${r.reaction}`, text: '', media: [], reaction: { targetId: String(r.target_message_id ?? ''), kind: String(r.reaction ?? '') } };
  }
  if (type === 'text.received') {
    const m = dict(data.text_message) ?? dict(data.message);
    if (!m) return null;
    const phone = digits(str(m.sender_phone_number) ?? str(m.remote_phone_number) ?? str(m.remote_number) ?? str(m.from));
    if (!phone) return null;
    return { channel: 'sms', phone, conversationId: str(m.conversation_id), messageId: str(m.id) ?? `${phone}:${p.timestamp}`, text: str(m.text) ?? str(m.content) ?? str(m.body) ?? '', media: media(m.media), name: nameFor(phone) };
  }
  if (type === 'whatsapp.received') {
    const m = dict(data.message);
    if (!m || m.is_group === true) return null;
    const phone = digits(str(m.remote_number) ?? str(m.sender_number));
    if (!phone || !str(m.id)) return null;
    return { channel: 'whatsapp', phone, conversationId: str(m.conversation_id), messageId: m.id, text: str(m.content) ?? str(m.text) ?? '', replyTo: str(m.reply_to_message_id), media: media(m.media), name: nameFor(phone) };
  }
  if (type === 'whatsapp.reaction_received') {
    const r = dict(data.reaction);
    if (!r) return null;
    const phone = digits(str(r.remote_number));
    if (!phone) return null;
    return { channel: 'whatsapp', phone, conversationId: str(r.conversation_id), messageId: str(r.id) ?? `${r.target_message_id}:${r.reaction}`, text: '', media: [], reaction: { targetId: String(r.target_message_id ?? ''), kind: String(r.reaction ?? '') } };
  }
  return null;
}

