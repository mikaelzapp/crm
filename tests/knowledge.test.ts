import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { zip, pdf } from './fixtures/documents';
const mocks = vi.hoisted(() => ({
  agent: vi.fn(), source: vi.fn(), sourceCreate: vi.fn(), sourceClaim: vi.fn(), raw: vi.fn(), embed: vi.fn(), transaction: vi.fn(),
}));
vi.mock('../src/lib/db', () => ({ db: {
  aiAgent: { findUniqueOrThrow: mocks.agent },
  knowledgeSource: { findUniqueOrThrow: mocks.source, create: mocks.sourceCreate, updateMany: mocks.sourceClaim },
  $queryRaw: mocks.raw,
  $transaction: mocks.transaction,
} }));
vi.mock('../src/lib/ollama', () => ({ embedText: mocks.embed }));
import { chunkKnowledge, createKnowledgeSource, embeddingLiteral, indexKnowledgeSource, knowledgeHash, retrieveKnowledge } from '../src/lib/knowledge';
import { extractDocument, MAX_DOCUMENT_BYTES } from '../src/lib/documents';

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('knowledge passages and vector validation', () => {
  it('keeps context across overlapping passages and Unicode text', () => {
    const content = ('Serviço 😀 São Paulo. Atendimento somente em dias úteis.\n\n').repeat(40);
    const chunks = chunkKnowledge(content, 300, 40);
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every(chunk => Array.from(chunk).length <= 300)).toBe(true);
    expect(chunks.every(chunk => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(chunk))).toBe(true);
    expect(chunks[0]).toContain('dias úteis');
    expect(chunks.at(-1)).toContain('Atendimento');
  });
  it('rejects invalid splitting parameters and returns no empty chunks', () => {
    expect(chunkKnowledge(' \n\n ')).toEqual([]);
    expect(() => chunkKnowledge('texto', 50, 5)).toThrow();
    expect(() => chunkKnowledge('texto', 100, 60)).toThrow();
  });
  it.each([[], [0, 0], [Infinity], [NaN], ['1,2); DROP TABLE x; --'], [1e15], Array(8193).fill(1)])('rejects invalid embedding %j', vector => {
    expect(() => embeddingLiteral(vector)).toThrow();
  });
  it('encodes only finite nonzero vectors and hashes exact source versions', () => {
    expect(embeddingLiteral([0, -0.2, 0.8])).toBe('[0,-0.2,0.8]');
    expect(knowledgeHash('fonte A')).toBe(knowledgeHash('fonte A'));
    expect(knowledgeHash('fonte A')).not.toBe(knowledgeHash('fonte B'));
  });
});

describe('agent access and indexing rules', () => {
  it('creates pending sources without silently granting approval or indexing', async () => {
    mocks.sourceCreate.mockImplementation(({ data }) => data);
    const source = await createKnowledgeSource('agent-a', { title: ' Empresa ', type: 'TEXT', content: ' O suporte funciona de segunda a sexta. ' });
    expect(source).toMatchObject({ agentId: 'agent-a', approved: false, content: 'O suporte funciona de segunda a sexta.' });
    expect(source.contentHash).toBe(knowledgeHash(source.content));
    expect(mocks.embed).not.toHaveBeenCalled();
  });
  it('requires explicit administrative approval before embedding', async () => {
    mocks.source.mockResolvedValue({ content: 'texto', contentHash: knowledgeHash('texto'), approved: false, agent: { embeddingModel: 'embed-a' } });
    await expect(indexKnowledgeSource('source')).rejects.toThrow('aprovação');
    expect(mocks.sourceClaim).not.toHaveBeenCalled();
    expect(mocks.embed).not.toHaveBeenCalled();
  });
  it('requires configured model instead of silently falling back', async () => {
    mocks.agent.mockResolvedValue({ embeddingModel: null });
    await expect(retrieveKnowledge('agent-a', 'horário')).rejects.toThrow('modelo');
    expect(mocks.embed).not.toHaveBeenCalled();
  });
  it('uses pgvector distance with bound agent/model/dimension and fresh approved source conditions', async () => {
    mocks.agent.mockResolvedValue({ embeddingModel: 'embed-a', timeoutSeconds: 30 });
    mocks.embed.mockResolvedValue([1, 0, 0.5]);
    mocks.raw.mockResolvedValue([
      { id: 'good', sourceId: 'source-a', title: 'Horário', content: 'Das 9 às 18.', score: 0.9 },
      { id: 'weak', sourceId: 'source-b', title: 'Outro', content: 'Irrelevante', score: 0.1 },
    ]);
    const controller = new AbortController();
    const result = await retrieveKnowledge('agent-a', 'horário', { signal: controller.signal });
    expect(result).toMatchObject({ model: 'embed-a', dimensions: 3, chunks: [{ id: 'good', content: 'Das 9 às 18.' }] });
    expect(mocks.embed).toHaveBeenCalledWith('embed-a', ['horário'][0], { timeoutSeconds: 30, signal: controller.signal });
    const [strings, ...parameters] = mocks.raw.mock.calls[0];
    const sql = strings.join('?');
    expect(sql).toContain('<=>');
    expect(sql).toContain('s."indexedHash" = s."contentHash"');
    expect(sql).toContain('k."contentHash" = s."contentHash"');
    expect(sql).toContain('s."approved" = true');
    expect(sql).toContain('a."embeddingModel" = ?');
    expect(parameters).toContain('agent-a');
    expect(parameters).toContain('embed-a');
    expect(parameters).toContain(3);
    expect(parameters).toContain('[1,0,0.5]');
  });
  it('publishes indexed vectors only after all chunks are valid', async () => {
    const content = 'Horário comercial: de segunda a sexta, das nove às dezoito horas.';
    const snapshot = { id: 'source', agentId: 'agent-a', content, contentHash: knowledgeHash(content), approved: true, agent: { embeddingModel: 'embed-a', timeoutSeconds: 30 } };
    mocks.source.mockResolvedValue(snapshot); mocks.sourceClaim.mockResolvedValue({ count: 1 }); mocks.embed.mockResolvedValue([0.5, 1]);
    const tx = { $executeRaw: vi.fn(), knowledgeSource: { findUniqueOrThrow: vi.fn().mockResolvedValue(snapshot), update: vi.fn().mockImplementation(({ data }) => data) }, knowledgeChunk: { deleteMany: vi.fn() } };
    mocks.transaction.mockImplementation(async callback => callback(tx));
    const indexed = await indexKnowledgeSource('source');
    expect(indexed).toMatchObject({ status: 'READY', indexedHash: snapshot.contentHash, embeddingModel: 'embed-a', dimensions: 2 });
    expect(tx.knowledgeChunk.deleteMany).toHaveBeenCalledWith({ where: { sourceId: 'source' } });
    const insert = tx.$executeRaw.mock.calls.find(call => call[0].join('?').includes('INSERT INTO'));
    expect(insert).toBeDefined(); expect(insert!.slice(1)).toContain('[0.5,1]');
  });
  it('refuses to publish knowledge edited while inference was running', async () => {
    const content = 'Informação original aprovada.';
    const snapshot = { id: 'source', agentId: 'agent-a', content, contentHash: knowledgeHash(content), approved: true, agent: { embeddingModel: 'embed-a', timeoutSeconds: 30 } };
    mocks.source.mockResolvedValue(snapshot); mocks.sourceClaim.mockResolvedValue({ count: 1 }); mocks.embed.mockResolvedValue([1, 0]);
    const tx = { $executeRaw: vi.fn(), knowledgeSource: { findUniqueOrThrow: vi.fn().mockResolvedValue({ ...snapshot, contentHash: knowledgeHash('Conteúdo alterado') }), update: vi.fn().mockImplementation(({ data }) => data) }, knowledgeChunk: { deleteMany: vi.fn() } };
    mocks.transaction.mockImplementation(async callback => callback(tx));
    const result = await indexKnowledgeSource('source');
    expect(result.status).toBe('PENDING'); expect(result.indexedHash).toBeNull();
    expect(tx.knowledgeChunk.deleteMany).not.toHaveBeenCalled();
    expect(tx.$executeRaw.mock.calls.some(call => call[0].join('?').includes('INSERT'))).toBe(false);
  });
  it('keeps malformed embeddings unavailable and records a failed source', async () => {
    const content = 'Informação original aprovada.';
    mocks.source.mockResolvedValue({ id: 'source', agentId: 'agent-a', content, contentHash: knowledgeHash(content), approved: true, agent: { embeddingModel: 'embed-a', timeoutSeconds: 30 } });
    mocks.sourceClaim.mockResolvedValue({ count: 1 }); mocks.embed.mockResolvedValue([NaN, 1]);
    await expect(indexKnowledgeSource('source')).rejects.toThrow('Embedding inválido');
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.sourceClaim).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED', indexedHash: null }) }));
  });
  it('caps retrieval context and reference count', async () => {
    mocks.agent.mockResolvedValue({ embeddingModel: 'embed-a', timeoutSeconds: 30 });
    mocks.embed.mockResolvedValue([1, 0]);
    mocks.raw.mockResolvedValue(Array.from({ length: 20 }, (_, i) => ({ id: String(i), sourceId: String(i), title: 'fonte', content: 'x'.repeat(4000), score: 0.8 })));
    const result = await retrieveKnowledge('agent-a', 'pergunta', { limit: 100 });
    expect(result.chunks.length).toBeLessThanOrEqual(8);
    expect(result.chunks.reduce((sum, chunk) => sum + chunk.content.length, 0)).toBeLessThanOrEqual(12000);
  });
});

describe('real document extraction and resource limits', () => {
  it('extracts UTF-8 TXT with BOM and rejects binary or oversized text', async () => {
    await expect(extractDocument(Buffer.from('\uFEFFServiço: suporte remoto.\r\nPreço: R$ 90.'), 'guia.TXT')).resolves.toEqual({ type: 'TXT', content: 'Serviço: suporte remoto.\nPreço: R$ 90.' });
    await expect(extractDocument(Buffer.from([0xff, 0xfe, 0x00]), 'arquivo.txt')).rejects.toThrow('UTF-8');
    await expect(extractDocument(Buffer.from('abc\u0000def'), 'arquivo.txt')).rejects.toThrow('binários');
    await expect(extractDocument(Buffer.from('x'.repeat(100001)), 'arquivo.txt')).rejects.toThrow('100 mil');
    await expect(extractDocument(Buffer.alloc(MAX_DOCUMENT_BYTES + 1), 'arquivo.txt')).rejects.toThrow('5 MiB');
  });
  it('rejects unsupported files and forged extensions', async () => {
    await expect(extractDocument(Buffer.from('imagem'), 'foto.png')).rejects.toThrow('Formato');
    await expect(extractDocument(Buffer.from('não sou PDF'), 'arquivo.pdf')).rejects.toThrow('corresponde');
    await expect(extractDocument(Buffer.from('não sou ZIP'), 'arquivo.docx')).rejects.toThrow('corresponde');
  });
  it('extracts real DOCX text without rendering HTML', async () => {
    const buffer = zip({ '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', 'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Treinamento profissional: suporte de segunda a sexta.</w:t></w:r></w:p></w:body></w:document>' });
    const result = await extractDocument(buffer, 'servicos.docx');
    expect(result.type).toBe('DOCX'); expect(result.content).toContain('suporte de segunda a sexta');
  }, 10000);
  it('rejects excessive DOCX expansion before the office parser runs', async () => {
    const buffer = zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': 'x'.repeat(2 * 1024 * 1024) });
    await expect(extractDocument(buffer, 'bomba.docx')).rejects.toThrow('descompactação');
  }, 10000);
  it('extracts an actual PDF text layer', async () => {
    const result = await extractDocument(pdf('Support hours: Monday to Friday.'), 'manual.pdf');
    expect(result.type).toBe('PDF'); expect(result.content).toContain('Monday to Friday');
  }, 15000);
  it('rejects image-only/no-text PDFs with an explicit OCR explanation', async () => {
    await expect(extractDocument(pdf(''), 'digitalizado.pdf')).rejects.toThrow('OCR');
  }, 15000);
});
