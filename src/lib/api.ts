/** Read bodies by bytes, including chunked requests, without trusting Content-Length. */
export async function readLimitedBody(request: Request, limit: number): Promise<Buffer> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('Invalid request body limit');
  const tooLarge = () => Object.assign(new Error('Corpo de requisição muito grande.'), {status: 413});
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > limit) {
    await request.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    reader.releaseLock();
  }
}
