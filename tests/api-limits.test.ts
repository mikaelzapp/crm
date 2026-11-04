import { describe, it, expect } from 'vitest';
import { readLimitedBody } from '../src/lib/api';

function streaming(chunks: Uint8Array[], headers: HeadersInit = {}) {
  let index = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    },
    cancel() { cancelled = true; },
  }, {highWaterMark: 0});
  const request = new Request('http://localhost/api/test', {method: 'POST', body: stream, headers, duplex: 'half'} as RequestInit & {duplex: string});
  return {request, readCount: () => index, wasCancelled: () => cancelled};
}

describe('bounded request body reader', () => {
  it('rejects a chunked body at the byte limit and cancels before reading later chunks', async () => {
    const source = streaming([Buffer.alloc(3), Buffer.alloc(3), Buffer.alloc(100)]);
    await expect(readLimitedBody(source.request, 5)).rejects.toMatchObject({status: 413});
    expect(source.wasCancelled()).toBe(true);
    expect(source.readCount()).toBe(2);
  });

  it('counts UTF-8 bytes rather than JavaScript characters', async () => {
    const source = streaming([Buffer.from('á'), Buffer.from('😀')]);
    await expect(readLimitedBody(source.request, 5)).rejects.toMatchObject({status: 413});
    expect(source.wasCancelled()).toBe(true);
  });

  it('preserves exact original bytes for webhook signature validation', async () => {
    const expected = Buffer.from([0, 255, 0xc3, 0xa1, 13, 10, 123, 125]);
    const source = streaming([expected.subarray(0, 3), expected.subarray(3)]);
    const actual = await readLimitedBody(source.request, expected.length);
    expect(Buffer.isBuffer(actual)).toBe(true);
    expect(actual.equals(expected)).toBe(true);
    expect(source.wasCancelled()).toBe(false);
  });

  it('does not trust a smaller declared Content-Length', async () => {
    const source = streaming([Buffer.alloc(6)], {'content-length': '1'});
    await expect(readLimitedBody(source.request, 5)).rejects.toMatchObject({status: 413});
  });

  it('rejects an oversized declared length without reading chunks', async () => {
    const source = streaming([Buffer.alloc(6)], {'content-length': '6'});
    await expect(readLimitedBody(source.request, 5)).rejects.toMatchObject({status: 413});
    expect(source.readCount()).toBe(0);
    expect(source.wasCancelled()).toBe(true);
  });

  it('accepts empty bodies and rejects invalid internal limits', async () => {
    expect(await readLimitedBody(new Request('http://localhost'), 0)).toEqual(Buffer.alloc(0));
    await expect(readLimitedBody(new Request('http://localhost'), -1)).rejects.toBeInstanceOf(TypeError);
  });
});
