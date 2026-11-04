/** PDF/DOCX extraction through the compiled Next.js HTTP route and worker threads. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { pdf, zip } from './fixtures/documents';

const base = process.env.TEST_BASE_URL || 'http://localhost:3002';
const origin = process.env.TEST_ORIGIN || new URL(base).origin;
const tag = `document-http-${randomUUID()}`;
let connectionId: string | undefined;
let cookie = '';
const sourceIds: string[] = [];
async function upload(agentId: string, buffer: Buffer, filename: string) {
  const form = new FormData(); form.append('title', `Documento sintético ${filename}`); form.append('file', new File([new Uint8Array(buffer)], filename));
  return fetch(`${base}/api/ai/agents/${agentId}/knowledge`, { method: 'POST', headers: { Origin: origin, Cookie: cookie }, body: form, signal: AbortSignal.timeout(30_000) });
}
async function pollSource(id: string) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const source = await db.knowledgeSource.findUniqueOrThrow({ where: { id } });
    if (source.status === 'READY') return source;
    if (source.status === 'FAILED') throw new Error(`Indexing failed: ${source.error}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('Document was not indexed by the worker in time.');
}
async function main() {
  assert.ok(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD, 'Administrator credentials must be securely provided in the environment.');
  try {
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }), signal: AbortSignal.timeout(10_000) });
    assert.equal(login.status, 200, `Login HTTP ${login.status}`); cookie = login.headers.get('set-cookie')!.split(';')[0];
    const connection = await db.connection.create({ data: { name: tag, phone: '+5511999999909', phoneNumberId: tag, wabaId: tag, mode: 'MOCK', status: 'CONNECTED' } });
    connectionId = connection.id;
    const agent = await db.aiAgent.create({ data: { connectionId, name: tag, mode: 'OFF', model: 'fixture-chat:latest', embeddingModel: 'fixture-embed:latest' } });
    const files = [
      { buffer: pdf('Support hours: Monday to Friday. The approved service price is 150 BRL.'), filename: 'manual.pdf', type: 'PDF', expected: 'Monday to Friday' },
      { buffer: zip({ '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', 'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Atendimento comercial de segunda a sexta. Implantação custa R$ 150.</w:t></w:r></w:p></w:body></w:document>' }), filename: 'servicos.docx', type: 'DOCX', expected: 'Implantação custa R$ 150' },
    ];
    for (const file of files) {
      const response = await upload(agent.id, file.buffer, file.filename);
      const body = await response.json();
      assert.equal(response.status, 201, `${file.filename}: ${body.error || response.status}`);
      sourceIds.push(body.source.id);
      assert.equal(body.source.type, file.type); assert.ok(body.source.content.includes(file.expected)); assert.equal(body.source.approved, true);
      const indexed = await pollSource(body.source.id);
      assert.equal(indexed.embeddingModel, 'fixture-embed:latest');
      assert.ok(await db.knowledgeChunk.count({ where: { sourceId: indexed.id } }) > 0);
    }
    console.log('PASS compiled Next.js PDF/DOCX multipart upload: actual isolated worker extraction, persisted text and pgvector background indexing.');
    const blank = await upload(agent.id, pdf(''), 'digitalizado.pdf'); const blankBody = await blank.json(); assert.equal(blank.status, 400); assert.match(blankBody.error, /OCR/);
    const forged = await upload(agent.id, Buffer.from('plain text is not a PDF'), 'falso.pdf'); assert.equal(forged.status, 400);
    const bomb = await upload(agent.id, zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': 'x'.repeat(2 * 1024 * 1024) }), 'bomba.docx'); const bombBody = await bomb.json(); assert.equal(bomb.status, 400); assert.match(bombBody.error, /descompactação/);
    assert.equal(await db.knowledgeSource.count({ where: { agentId: agent.id } }), 2, 'Rejected files must never become training sources.');
    console.log('PASS compiled Next.js document rejection: scanned/no-text PDF explicitly requires OCR; forged PDF and DOCX expansion bomb create no source.');
  } finally {
    if (cookie) await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    if (connectionId) await db.connection.deleteMany({ where: { id: connectionId } });
    if (sourceIds.length) await db.auditLog.deleteMany({ where: { entityId: { in: sourceIds } } });
    await db.$disconnect();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Document HTTP acceptance failed.'); process.exitCode = 1; }).finally(() => db.$disconnect());
