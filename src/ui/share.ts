/** Lab files in a URL: `#lab=` + base64url(deflate-raw(JSON)). No server involved. */
export const SHARE_PREFIX = '#lab=';
/** Links longer than this may be cut by chat apps or browsers. */
export const LONG_LINK = 8000;
/** A shared link may not expand beyond this, so a crafted link can't exhaust memory. */
const MAX_DECODED_BYTES = 2_000_000;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function readAll(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error('This shared lab is too large.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export async function encodeLab(json: string): Promise<string> {
  const input = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return toBase64Url(await readAll(input, Infinity));
}

/** Decodes a `#lab=` payload back to JSON text. Throws with a user-facing message. */
export async function decodeLab(payload: string): Promise<string> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64Url(payload);
  } catch (error) {
    throw new Error('This shared link is damaged.', { cause: error });
  }
  try {
    const output = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new TextDecoder().decode(await readAll(output, MAX_DECODED_BYTES));
  } catch (error) {
    if (error instanceof Error && error.message.includes('too large')) throw error;
    throw new Error('This shared link is damaged.', { cause: error });
  }
}

export function shareUrl(payload: string, location: { origin: string; pathname: string }): string {
  return `${location.origin}${location.pathname}${SHARE_PREFIX}${payload}`;
}
