CREATE TABLE "MessageDraftVersion" (
  "id" TEXT NOT NULL,
  "contactId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "authorId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MessageDraftVersion_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MessageDraftVersion_contactId_createdAt_idx" ON "MessageDraftVersion"("contactId", "createdAt");
ALTER TABLE "MessageDraftVersion" ADD CONSTRAINT "MessageDraftVersion_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
