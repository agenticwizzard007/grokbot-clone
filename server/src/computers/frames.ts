/** Binary companion frame: SWF1, one-byte Bot ID length, UTF-8 Bot ID, then JPEG. */
export function decodeCompanionFrame(data: Buffer): { botId: string; jpeg: Buffer } | null {
  if (data.length < 10 || data.toString('ascii', 0, 4) !== 'SWF1') return null;
  const length = data[4];
  if (!length || length > 64 || data.length < 5 + length + 4) return null;
  const botId = data.toString('utf8', 5, 5 + length);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(botId)) return null;
  const jpeg = data.subarray(5 + length);
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9) return null;
  return { botId, jpeg };
}
