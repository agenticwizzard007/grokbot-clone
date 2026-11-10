/** Shared RFB (VNC protocol) pieces for the live viewer: the browser runs noVNC against our server. */

export class ByteQueue {
  private buf = Buffer.alloc(0);
  private waiters: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }[] = [];
  private closed: Error | null = null;
  push(b: Buffer) { this.buf = Buffer.concat([this.buf, b]); this.drain(); }
  close(e: Error) { this.closed = e; for (const w of this.waiters) w.reject(e); this.waiters = []; }
  read(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(this.closed);
      this.waiters.push({ n, resolve, reject });
      this.drain();
    });
  }
  takeAll(): Buffer { const b = this.buf; this.buf = Buffer.alloc(0); return b; }
  private drain() {
    while (this.waiters.length && this.buf.length >= this.waiters[0].n) {
      const w = this.waiters.shift()!;
      const out = this.buf.subarray(0, w.n);
      this.buf = this.buf.subarray(w.n);
      w.resolve(Buffer.from(out));
    }
  }
}

export const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

export async function browserHandshake(q: ByteQueue, send: (b: Buffer) => void, serverInit: Buffer) {
  send(Buffer.from('RFB 003.008\n'));
  await q.read(12);
  send(Buffer.from([1, 1])); // one security type: None
  await q.read(1);
  send(u32(0)); // SecurityResult OK
  await q.read(1); // ClientInit
  send(serverInit);
}

/** Filters a client->server RFB stream, dropping input events. Returns bytes to forward. */
export class WatchFilter {
  private pending = Buffer.alloc(0);
  feed(chunk: Buffer): Buffer {
    this.pending = Buffer.concat([this.pending, chunk]);
    const out: Buffer[] = [];
    for (;;) {
      const b = this.pending;
      if (!b.length) break;
      const len = msgLength(b);
      if (len === -1) { this.pending = Buffer.alloc(0); break; } // unknown: fail closed
      if (len === 0 || b.length < len) break; // need more bytes
      const msg = b.subarray(0, len);
      const t = b[0];
      if (t !== 4 && t !== 5 && t !== 6) out.push(Buffer.from(msg));
      this.pending = b.subarray(len);
    }
    return Buffer.concat(out);
  }
}

/** Length of the client message at the head of `b`, 0 if more bytes are needed to know, -1 if unknown. */
export function msgLength(b: Buffer): number {
  const t = b[0];
  switch (t) {
    case 0: return 20; // SetPixelFormat
    case 2: return b.length < 4 ? 0 : 4 + 4 * b.readUInt16BE(2); // SetEncodings
    case 3: return 10; // FramebufferUpdateRequest
    case 4: return 8; // KeyEvent
    case 5: return 6; // PointerEvent
    case 6: return b.length < 8 ? 0 : 8 + Math.abs(b.readInt32BE(4)); // ClientCutText (+extended)
    case 150: return 10; // EnableContinuousUpdates
    case 248: return b.length < 9 ? 0 : 9 + b[8]; // ClientFence
    case 251: return b.length < 8 ? 0 : 8 + 16 * b[6]; // SetDesktopSize
    default: return -1;
  }
}


// ---------- serving frames ourselves (providers without a VNC server) ----------

/** ServerInit for a w x h true-colour framebuffer (32 bpp, depth 24, little-endian RGB888). */
export function serverInit(w: number, h: number, name: string): Buffer {
  const head = Buffer.alloc(24);
  head.writeUInt16BE(w, 0);
  head.writeUInt16BE(h, 2);
  // PIXEL_FORMAT: bpp, depth, big-endian, true-colour, r/g/b max, r/g/b shift, 3 bytes padding
  head[4] = 32; head[5] = 24; head[6] = 0; head[7] = 1;
  head.writeUInt16BE(255, 8); head.writeUInt16BE(255, 10); head.writeUInt16BE(255, 12);
  head[14] = 16; head[15] = 8; head[16] = 0;
  const nameBuf = Buffer.from(name, 'utf8');
  head.writeUInt32BE(nameBuf.length, 20);
  return Buffer.concat([head, nameBuf]);
}

const ENC_TIGHT = 7;
const ENC_DESKTOP_SIZE = -223;

function rectHeader(x: number, y: number, w: number, h: number, enc: number) {
  const b = Buffer.alloc(12);
  b.writeUInt16BE(x, 0); b.writeUInt16BE(y, 2); b.writeUInt16BE(w, 4); b.writeUInt16BE(h, 6); b.writeInt32BE(enc, 8);
  return b;
}

/** Tight "compact length": 7 bits per byte, low bits first, up to 3 bytes. */
function compactLength(n: number) {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x4000) return Buffer.from([(n & 0x7f) | 0x80, n >> 7]);
  return Buffer.from([(n & 0x7f) | 0x80, ((n >> 7) & 0x7f) | 0x80, (n >> 14) & 0xff]);
}

/**
 * A FramebufferUpdate carrying one JPEG frame as a Tight/JPEG rectangle (noVNC decodes it natively).
 * If `resize` is set, a DesktopSize pseudo-rectangle comes first so the client resizes to the frame.
 */
export function jpegUpdate(jpeg: Buffer, w: number, h: number, resize: boolean): Buffer {
  const rects: Buffer[] = [];
  if (resize) rects.push(rectHeader(0, 0, w, h, ENC_DESKTOP_SIZE));
  rects.push(rectHeader(0, 0, w, h, ENC_TIGHT), Buffer.from([0x90]), compactLength(jpeg.length), jpeg);
  const head = Buffer.alloc(4);
  head[0] = 0; // FramebufferUpdate
  head.writeUInt16BE(resize ? 2 : 1, 2);
  return Buffer.concat([head, ...rects]);
}

export const RFB_TIGHT = ENC_TIGHT;
export const RFB_DESKTOP_SIZE = ENC_DESKTOP_SIZE;

/** Pixel size of a JPEG (from its SOF marker), or null if it can't be read. */
export function jpegSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}
