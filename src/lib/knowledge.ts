import { createHash, randomUUID } from 'node:crypto';
import { db } from './db';

export const MAX_KNOWLEDGE_CHARACTERS = 100_000;
export const MAX_EMBEDDING_DIMENSIONS = 8_192;
const SOURCE_TYPES = new Set(['TEXT', 'FAQ', 'SERVICE', 'PRICE', 'PDF', 'TXT', 'DOCX', 'CORRECTION', 'STRUCTURED']);
export type KnowledgeMatch = { id: string; sourceId: string; title: string; content: string; score: number };
export type KnowledgeRetrieval = { chunks: KnowledgeMatch[]; model: string; dimensions: number };

export function knowledgeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Bounded overlapping passages, split at paragraph/sentence boundaries where possible. */
export function chunkKnowledge(content: string, maxLength = 900, overlap = 120): string[] {
  if (!Number.isInteger(maxLength) || maxLength < 100 || !Number.isInteger(overlap) || overlap < 0 || overlap >= maxLength / 2) throw new Error('Limites de fragmentação inválidos.');
  const chars = Array.from(content.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim());
  const chunks: string[] = [];
  let start = 0;
  while (start < chars.length) {
    let end = Math.min(start + maxLength, chars.length);
    if (end < chars.length) {
      const passage = chars.slice(start, end).join('');
      const boundary = Math.max(passage.lastIndexOf('\n\n'), passage.lastIndexOf('. '), passage.lastIndexOf('\n'));
      if (boundary > maxLength / 2) end = start + Array.from(passage.slice(0, boundary + 1)).length;
    }
    const chunk = chars.slice(start, end).join('').trim();
    if (chunk) chunks.push(chunk);
    if (end === chars.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

/** SQL uses this as a bound parameter, never as an interpolated query fragment. */
export function embeddingLiteral(vector: unknown): string {
  if (!Array.isArray(vector) || !vector.length || vector.length > MAX_EMBEDDING_DIMENSIONS || vector.some(value => typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e12)) throw new Error('Embedding inválido retornado pelo modelo.');
  if (!vector.some(value => value !== 0)) throw new Error('O modelo retornou embedding sem informação.');
  return `[${vector.join(',')}]`;
}

export async function createKnowledgeSource(agentId: string, input: { title: string; type: string; content: string; approved?: boolean }) {
  const content = input.content.replace(/\u0000/g, '').trim();
  if (!input.title.trim() || input.title.length > 200) throw new Error('Título deve ter entre 1 e 200 caracteres.');
  if (!SOURCE_TYPES.has(input.type)) throw new Error('Tipo de fonte de conhecimento inválido.');
  if (!content || Array.from(content).length > MAX_KNOWLEDGE_CHARACTERS) throw new Error('A fonte deve conter entre 1 e 100 mil caracteres.');
  return db.knowledgeSource.create({ data: { agentId, title: input.title.trim(), type: input.type, content, approved: input.approved ?? false, contentHash: knowledgeHash(content) } });
}

async function embedPassages(model: string, passages: string[], timeoutSeconds: number, signal?: AbortSignal): Promise<number[][]> {
  const { embedText } = await import('./ollama');
  const vectors: number[][] = [];
  for (let i = 0; i < passages.length; i += 4) {
    signal?.throwIfAborted();
    vectors.push(...await Promise.all(passages.slice(i, i + 4).map(passage => embedText(model, passage, { timeoutSeconds, signal }))));
  }
  return vectors;
}

export async function indexKnowledgeSource(sourceId: string, options: { signal?: AbortSignal } = {}) {
  const source = await db.knowledgeSource.findUniqueOrThrow({ where: { id: sourceId }, include: { agent: true } });
  if (!source.content.trim() || Array.from(source.content).length > MAX_KNOWLEDGE_CHARACTERS) throw new Error('A fonte deve conter entre 1 e 100 mil caracteres.');
  if (!source.approved) throw new Error('A fonte precisa de aprovação administrativa antes da indexação.');
  const model = source.agent.embeddingModel?.trim();
  if (!model) throw new Error('Configure um modelo de embeddings instalado para este agente.');
  if (source.contentHash !== knowledgeHash(source.content)) throw new Error('O conteúdo da fonte mudou sem atualizar sua versão.');
  const claimed = await db.knowledgeSource.updateMany({ where: { id: sourceId, status: { not: 'INDEXING' }, contentHash: source.contentHash, approved: true }, data: { status: 'INDEXING', error: null, indexedHash: null } });
  if (claimed.count === 0) return db.knowledgeSource.findUniqueOrThrow({ where: { id: sourceId } });
  try {
    const passages = chunkKnowledge(source.content);
    if (!passages.length) throw new Error('A fonte não contém texto utilizável.');
    const vectors: number[][] = [];
    for (let i = 0; i < passages.length; i += 16) {
      const batch = await embedPassages(model, passages.slice(i, i + 16), source.agent.timeoutSeconds, options.signal);
      if (batch.length !== passages.slice(i, i + 16).length) throw new Error('O modelo retornou quantidade inesperada de embeddings.');
      for (const vector of batch) { embeddingLiteral(vector); vectors.push(vector); }
    }
    const dimensions = vectors[0].length;
    if (vectors.some(vector => vector.length !== dimensions)) throw new Error('O modelo retornou dimensões inconsistentes.');
    return await db.$transaction(async tx => {
      // Lock the snapshot being published. Edits during inference cannot expose stale chunks.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${sourceId}))`;
      const current = await tx.knowledgeSource.findUniqueOrThrow({ where: { id: sourceId }, include: { agent: true } });
      if (!current.approved || current.contentHash !== source.contentHash || current.agent.embeddingModel !== model) {
        return tx.knowledgeSource.update({ where: { id: sourceId }, data: { status: 'PENDING', indexedHash: null, error: 'A configuração ou o conteúdo mudou durante a indexação; indexe novamente.' } });
      }
      await tx.knowledgeChunk.deleteMany({ where: { sourceId } });
      for (let position = 0; position < passages.length; position++) {
        const literal = embeddingLiteral(vectors[position]);
        await tx.$executeRaw`INSERT INTO "KnowledgeChunk" ("id", "sourceId", "agentId", "content", "position", "embedding", "embeddingModel", "dimensions", "contentHash", "createdAt") VALUES (${randomUUID()}, ${sourceId}, ${source.agentId}, ${passages[position]}, ${position}, ${literal}::vector, ${model}, ${dimensions}, ${source.contentHash}, CURRENT_TIMESTAMP)`;
      }
      return tx.knowledgeSource.update({ where: { id: sourceId }, data: { status: 'READY', error: null, indexedHash: source.contentHash, embeddingModel: model, dimensions } });
    }, { timeout: 30_000 });
  } catch (error) {
    await db.knowledgeSource.updateMany({ where: { id: sourceId, status: 'INDEXING', contentHash: source.contentHash }, data: { status: 'FAILED', indexedHash: null, error: 'Não foi possível indexar a fonte. Verifique o serviço Ollama e o modelo de embeddings; tente novamente.' } });
    throw error;
  }
}

export async function retrieveKnowledge(agentId: string, question: string, options: { limit?: number; minimumScore?: number; signal?: AbortSignal } = {}): Promise<KnowledgeRetrieval> {
  const agent = await db.aiAgent.findUniqueOrThrow({ where: { id: agentId } });
  const model = agent.embeddingModel?.trim();
  if (!model) throw new Error('Configure um modelo de embeddings para consultar a base de conhecimento.');
  if (!question.trim() || question.length > 10_000) throw new Error('Pergunta deve ter entre 1 e 10 mil caracteres.');
  const [vector] = await embedPassages(model, [question], agent.timeoutSeconds, options.signal);
  const literal = embeddingLiteral(vector);
  const dimensions = vector.length;
  const limit = Math.max(1, Math.min(8, Math.floor(Number.isFinite(options.limit) ? options.limit! : 5)));
  const minimumScore = Math.max(0, Math.min(1, Number.isFinite(options.minimumScore) ? options.minimumScore! : 0.25));
  const matches = await db.$queryRaw<KnowledgeMatch[]>`
    SELECT k."id", k."sourceId", s."title", k."content", (1 - (k."embedding" <=> ${literal}::vector))::float8 AS "score"
    FROM "KnowledgeChunk" k
    JOIN "KnowledgeSource" s ON s."id" = k."sourceId"
    JOIN "AiAgent" a ON a."id" = k."agentId"
    WHERE k."agentId" = ${agentId} AND s."agentId" = ${agentId}
      AND a."embeddingModel" = ${model} AND k."embeddingModel" = ${model} AND s."embeddingModel" = ${model}
      AND k."dimensions" = ${dimensions} AND s."dimensions" = ${dimensions}
      AND s."status" = 'READY' AND s."approved" = true AND s."indexedHash" = s."contentHash"
      AND k."contentHash" = s."contentHash" AND k."embedding" IS NOT NULL
      AND vector_dims(k."embedding") = ${dimensions}
    ORDER BY k."embedding" <=> ${literal}::vector ASC, k."id" ASC
    LIMIT ${limit}`;
  let remaining = 12_000;
  const chunks = matches.filter(match => Number.isFinite(match.score) && match.score >= minimumScore).slice(0, limit).flatMap(match => {
    const content = match.content.slice(0, remaining);
    remaining -= content.length;
    return content ? [{ ...match, content }] : [];
  });
  return { chunks, model, dimensions };
}
