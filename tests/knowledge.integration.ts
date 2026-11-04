/** Real PostgreSQL/pgvector tests using the explicit local Ollama HTTP fixture. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { db } from '../src/lib/db';
import { createKnowledgeSource, indexKnowledgeSource, knowledgeHash, retrieveKnowledge } from '../src/lib/knowledge';
import { closeOllamaClient } from '../src/lib/ollama';

const model = process.env.TEST_EMBEDDING_MODEL || 'fixture-embed:latest';
const tag = `knowledge-integration-${randomUUID()}`;
const connectionIds: string[] = [];
async function readySource(agentId: string, title: string, content: string) {
  const source = await createKnowledgeSource(agentId, { title, type: 'TEXT', content, approved: true });
  const indexed = await indexKnowledgeSource(source.id);
  assert.equal(indexed.status, 'READY');
  return indexed;
}
async function main() {
  const fixture = new URL(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11435');
  assert.ok(['127.0.0.1', 'localhost'].includes(fixture.hostname), 'This suite requires an explicit local test fixture.');
  const versionResponse = await fetch(`${fixture.origin}/api/version`, { signal: AbortSignal.timeout(5000) });
  assert.match((await versionResponse.json()).version, /fixture/, 'Never run this suite against an unidentified model service.');
  try {
    const [agentA, agentB] = await Promise.all([1, 2].map(async number => {
      const connection = await db.connection.create({ data: { name: `${tag}-${number}`, phone: `+551199999990${number}`, wabaId: `fixture-${tag}`, phoneNumberId: `${tag}-${number}`, mode: 'MOCK', status: 'CONNECTED' } });
      connectionIds.push(connection.id);
      return db.aiAgent.create({ data: { connectionId: connection.id, name: `${tag}-${number}`, embeddingModel: model, model: 'fixture-chat:latest', mode: 'OFF' } });
    }));
    const question = 'Qual é o preço do plano Aurora e o horário de atendimento?';
    const sourceA = await readySource(agentA.id, 'Preço e horário — agente A', 'O preço do plano Aurora é R$ 90. Atendimento de segunda a sexta, das nove às dezoito horas.');
    const sourceB = await readySource(agentB.id, 'Preço e horário — agente B', 'O preço do plano Aurora é R$ 999. Atendimento de segunda a sexta, das nove às dezoito horas.');
    const actual = await db.$queryRaw<{ dimensions: number; model: string }[]>`SELECT vector_dims("embedding") AS dimensions, "embeddingModel" AS model FROM "KnowledgeChunk" WHERE "sourceId" = ${sourceA.id}`;
    assert.ok(actual.length > 0); assert.ok(actual.every(row => row.dimensions === 256 && row.model === model));
    const retrievalA = await retrieveKnowledge(agentA.id, question);
    const retrievalB = await retrieveKnowledge(agentB.id, question);
    assert.ok(retrievalA.chunks.length > 0); assert.ok(retrievalB.chunks.length > 0);
    assert.ok(retrievalA.chunks.every(chunk => chunk.sourceId === sourceA.id));
    assert.ok(retrievalB.chunks.every(chunk => chunk.sourceId === sourceB.id));
    assert.ok(retrievalA.chunks.some(chunk => chunk.content.includes('R$ 90')));
    assert.ok(retrievalB.chunks.some(chunk => chunk.content.includes('R$ 999')));
    console.log('PASS pgvector actual vector storage and semantic retrieval; two agents retain separate commercial answers.');

    // The same actual stored passages are excluded for every freshness/approval gate.
    await db.knowledgeSource.update({ where: { id: sourceA.id }, data: { approved: false } });
    assert.equal((await retrieveKnowledge(agentA.id, question)).chunks.length, 0, 'Unapproved sources must never be retrieved.');
    await db.knowledgeSource.update({ where: { id: sourceA.id }, data: { approved: true, status: 'PENDING' } });
    assert.equal((await retrieveKnowledge(agentA.id, question)).chunks.length, 0, 'Sources waiting for indexing must not expose previous passages.');
    const changed = 'O preço do plano Aurora foi alterado e precisa de nova aprovação e indexação.';
    await db.knowledgeSource.update({ where: { id: sourceA.id }, data: { status: 'READY', content: changed, contentHash: knowledgeHash(changed) } });
    assert.equal((await retrieveKnowledge(agentA.id, question)).chunks.length, 0, 'Stale content cannot match an older indexed hash.');
    await indexKnowledgeSource(sourceA.id);
    assert.ok((await retrieveKnowledge(agentA.id, question)).chunks.some(chunk => chunk.content === changed));
    const count = await db.knowledgeChunk.count({ where: { sourceId: sourceA.id } });
    await indexKnowledgeSource(sourceA.id);
    assert.equal(await db.knowledgeChunk.count({ where: { sourceId: sourceA.id } }), count, 'Reindex must replace passages without duplicating vectors.');
    console.log('PASS pgvector approved-only retrieval, pending-source exclusion, stale-content invalidation and repeatable reindex.');

    // Mix different model/dimension vectors in the same unconstrained pgvector column.
    // Actual SQL must exclude them before calculating cosine distance.
    const dimensionsSource = await createKnowledgeSource(agentA.id, { title: 'Incompatible vector dimensions', type: 'TEXT', content: 'Mismatched-dimension source', approved: true });
    await db.knowledgeSource.update({ where: { id: dimensionsSource.id }, data: { status: 'READY', embeddingModel: model, dimensions: 3, indexedHash: dimensionsSource.contentHash } });
    await db.$executeRaw`INSERT INTO "KnowledgeChunk" ("id","sourceId","agentId","content","position","embedding","embeddingModel","dimensions","contentHash","createdAt") VALUES (${randomUUID()},${dimensionsSource.id},${agentA.id},${'Dimension-isolated passage'},0,${'[1,0,0]'}::vector,${model},3,${dimensionsSource.contentHash},CURRENT_TIMESTAMP)`;
    const otherModelSource = await readySource(agentA.id, 'Old model source', 'Preço plano Aurora em outra configuração de embeddings.');
    await db.knowledgeSource.update({ where: { id: otherModelSource.id }, data: { embeddingModel: 'retired-embedding-model' } });
    await db.knowledgeChunk.updateMany({ where: { sourceId: otherModelSource.id }, data: { embeddingModel: 'retired-embedding-model' } });
    const sourceSnapshot = await db.knowledgeSource.findUniqueOrThrow({ where: { id: sourceA.id } });
    await db.knowledgeChunk.updateMany({ where: { sourceId: sourceA.id }, data: { contentHash: 'mismatched-chunk-snapshot' } });
    assert.equal((await retrieveKnowledge(agentA.id, question)).chunks.length, 0, 'Wrong model, dimensions or chunk snapshot cannot enter the context.');
    await db.knowledgeChunk.updateMany({ where: { sourceId: sourceA.id }, data: { contentHash: sourceSnapshot.contentHash } });
    const final = await retrieveKnowledge(agentA.id, question, { limit: 100 });
    assert.ok(final.chunks.length > 0); assert.ok(final.chunks.every(chunk => chunk.sourceId === sourceA.id));
    assert.ok(final.chunks.length <= 8); assert.ok(final.chunks.reduce((sum, chunk) => sum + chunk.content.length, 0) <= 12000);
    console.log('PASS pgvector dimension/model/snapshot isolation with mixed-dimension rows; reference limits preserved.');
  } finally {
    await db.connection.deleteMany({ where: { id: { in: connectionIds } } });
    await closeOllamaClient();
    await db.$disconnect();
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Knowledge integration failed.'); process.exitCode = 1; }).finally(() => db.$disconnect());
