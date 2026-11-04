-- Ollama agents and PostgreSQL pgvector retrieval. Requires pgvector server package.
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE "Conversation" ADD COLUMN "aiPaused" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "AiAgent" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'OFF',
    "model" TEXT NOT NULL DEFAULT 'qwen3.5:4b',
    "embeddingModel" TEXT,
    "instructions" TEXT NOT NULL DEFAULT '',
    "faqs" JSONB NOT NULL DEFAULT '[]',
    "services" JSONB NOT NULL DEFAULT '[]',
    "prices" JSONB NOT NULL DEFAULT '[]',
    "retainHistory" BOOLEAN NOT NULL DEFAULT false,
    "maxHistoryMessages" INTEGER NOT NULL DEFAULT 10,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 60,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiAgent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KnowledgeSource" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'TEXT',
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "embeddingModel" TEXT,
    "dimensions" INTEGER,
    "contentHash" TEXT NOT NULL,
    "indexedHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KnowledgeSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "embedding" vector,
    "embeddingModel" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiRun" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "conversationId" TEXT,
    "triggerMessageId" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'TEST',
    "input" TEXT NOT NULL,
    "output" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "mode" TEXT NOT NULL,
    "intent" TEXT,
    "reason" TEXT,
    "error" TEXT,
    "sources" JSONB NOT NULL DEFAULT '[]',
    "retainHistory" BOOLEAN NOT NULL DEFAULT false,
    "claimedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "outboundMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiCorrection" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "originalAnswer" TEXT NOT NULL,
    "correctedAnswer" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "sourceId" TEXT,
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiCorrection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AiConversationPermission" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "allowed" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "evidence" TEXT,
    "grantedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiConversationPermission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiAgent_connectionId_key" ON "AiAgent"("connectionId");

CREATE INDEX "KnowledgeSource_agentId_status_idx" ON "KnowledgeSource"("agentId", "status");

CREATE UNIQUE INDEX "KnowledgeChunk_sourceId_position_key" ON "KnowledgeChunk"("sourceId", "position");

CREATE INDEX "KnowledgeChunk_agentId_embeddingModel_dimensions_idx" ON "KnowledgeChunk"("agentId", "embeddingModel", "dimensions");

CREATE UNIQUE INDEX "AiRun_triggerMessageId_key" ON "AiRun"("triggerMessageId");

CREATE UNIQUE INDEX "AiRun_outboundMessageId_key" ON "AiRun"("outboundMessageId");

CREATE INDEX "AiRun_agentId_createdAt_idx" ON "AiRun"("agentId", "createdAt");

CREATE INDEX "AiRun_status_claimedAt_idx" ON "AiRun"("status", "claimedAt");

CREATE INDEX "AiCorrection_agentId_status_idx" ON "AiCorrection"("agentId", "status");

CREATE UNIQUE INDEX "AiConversationPermission_conversationId_key" ON "AiConversationPermission"("conversationId");

ALTER TABLE "AiAgent" ADD CONSTRAINT "AiAgent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AiAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "KnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AiAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AiAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiRun" ADD CONSTRAINT "AiRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiCorrection" ADD CONSTRAINT "AiCorrection_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AiAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiCorrection" ADD CONSTRAINT "AiCorrection_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AiRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiConversationPermission" ADD CONSTRAINT "AiConversationPermission_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "AiRun_expiresAt_idx" ON "AiRun"("expiresAt");
