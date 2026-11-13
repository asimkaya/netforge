import { describe, expect, it } from 'vitest';
import { decodeLab, encodeLab, shareUrl } from './share.ts';

describe('share links', () => {
  it('round-trips lab JSON through a URL-safe payload', async () => {
    const json = JSON.stringify({ format: 'netforge-lab', text: 'ü/+= '.repeat(200) });
    const payload = await encodeLab(json);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(payload.length).toBeLessThan(json.length);
    expect(await decodeLab(payload)).toBe(json);
    expect(shareUrl(payload, { origin: 'https://x.dev', pathname: '/' })).toBe(
      `https://x.dev/#lab=${payload}`,
    );
  });

  it('rejects damaged payloads', async () => {
    await expect(decodeLab('not*base64')).rejects.toThrow('damaged');
    await expect(decodeLab('AAAA')).rejects.toThrow('damaged');
  });

  it('refuses payloads that expand to more than 2 MB', async () => {
    const bomb = await encodeLab('0'.repeat(3_000_000));
    expect(bomb.length).toBeLessThan(10_000);
    await expect(decodeLab(bomb)).rejects.toThrow('too large');
  });
});
