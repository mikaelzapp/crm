# Validação — CRM 0.2.0 com Ollama

A versão foi construída e testada com PostgreSQL 16/pgvector 0.8.7, Redis 7, Node 24 no desenvolvimento e Node 22 na imagem Docker de produção. Os 30 contatos originais permanecem preservados e sem consentimentos concedidos pelos testes.

## Resultados executados

- TypeScript e build de produção: aprovados, incluindo imagem Docker sem dependências de desenvolvimento.
- Unidade: **121 testes aprovados**. Cobrem importação, segurança HTTP, mensagens, criptografia, Ollama, recuperação de conhecimento, documentos, permissões, privacidade e o runtime de IA.
- HTTP na imagem Docker final: **9 grupos do CRM + 6 grupos de IA aprovados**. Incluem RBAC, modelos/capacidades, bloqueio de alteração de URL por requisição, conhecimento estruturado/TXT, testes com IA desligada, correção aprovada, sugestões com envio humano idempotente e exclusão de dados derivados.
- Navegador na imagem imutável: **5 fluxos aprovados** — três do CRM e dois da IA. Verificados dois agentes independentes, PDF real indexado, resposta com referência, correção aprovada, permissão por conversa, sugestão sem envio e revogação. Zero erros de página/console, exceto o HTTP 400 intencional do envio sem consentimento.
- Documentos: PDF e DOCX reais foram enviados à API compilada/Docker, extraídos por workers isolados e indexados no PostgreSQL. PDF sem texto, arquivo falso e DOCX com expansão excessiva foram rejeitados sem criar fontes.
- RAG: a busca SQL real com `vector <=> vector` isolou agentes, modelos e dimensões; fontes não aprovadas, alteradas, retiradas ou ainda não prontas ficaram indisponíveis. Reindexação não duplicou os trechos.
- Runtime: nove execuções sintéticas persistidas, usando BullMQ/Redis e PostgreSQL, validaram OFF/SUGGEST/AUTO, permissões separadas, aprovação humana idempotente, envio automático simulado, humano, interesse, opt-out, timeout, configuração alterada e recuperação sem reenvio.
- Privacidade: troca de telefone revoga também a autorização de IA; novo opt-in WhatsApp não transfere a autorização anterior. Exclusão, revogação e opt-out removem conhecimento derivado das conversas. Expiração limpa entrada, saída, fontes, motivo livre e erro dos registros temporários.
- Regressão preservada: importação de 30 empresas/37 colunas, mensagens associadas e deduplicação. Backup/restauração em banco temporário e reinício PostgreSQL/Redis já haviam sido validados na entrega inicial; o upgrade para pgvector preservou os 30 contatos.
- Auditoria npm: zero vulnerabilidades reportadas pelo registro consultado; isso não substitui manutenção contínua.

## Ollama real versus fixture

O serviço **Ollama oficial foi instalado e iniciado**. O cliente real consultou `/api/tags`, recebeu a lista vazia e confirmou `MODEL_NOT_INSTALLED` para `qwen3.5:4b`. A tentativa de baixar `all-minilm` foi bloqueada por HTTP 403 do proxy para `registry.ollama.ai`. O domínio foi adicionado ao rascunho da configuração de rede; salvar o rascunho não aplica nem publica a política.

Portanto, **não foi validada geração nem embedding com pesos reais nesta nuvem**. A validação funcional automatizada usou a fixture HTTP identificada de Ollama, com vetores determinísticos e respostas marcadas SIMULAÇÃO. Ela exercita o cliente real, filas, SQL, permissões, extração e interface, mas não comprova qualidade de um modelo. Não existe fallback automático para essa fixture no produto.

Nenhuma mensagem foi enviada à Meta. Os testes usaram exclusivamente conexões MOCK e contatos sintéticos, removidos ao final. O modelo padrão só é sugerido automaticamente quando `qwen3.5:4b` aparece na lista de modelos instalados.

## Reproduzir

Leia [Ollama](ollama.md) para preparar o serviço, modelos e ambiente. Use banco dedicado, `WHATSAPP_MODE=mock`, web e worker ativos. Para a fixture, configure ambos com `OLLAMA_BASE_URL=http://127.0.0.1:11435` no host e inicie `node tests/fixtures/ollama-server.mjs`. A URL dentro de Docker precisa ser alcançável no namespace desse contêiner; localhost não aponta para a máquina do navegador.

```sh
npm run typecheck
npm test
npm run build
npm run test:ai:knowledge
npm run test:ai:runtime
# TEST_BASE_URL deve corresponder a APP_URL da instância de teste:
npm run test:ai:api
npm run test:ai:documents
npm run test:api
# Ative explicitamente os dois casos opcionais de IA:
RUN_AI_BROWSER_TESTS=1 AI_BROWSER_MODEL=fixture-chat:latest \
  AI_BROWSER_EMBEDDING_MODEL=fixture-embed:latest npm run test:e2e
```

O CSV original precisa estar em `private/CONTATOS_FINAIS_30.csv` ou em `TEST_CSV_PATH` para as verificações específicas da base. Não está no pacote de código. As suítes usam fixtures sintéticas e removem seus registros. Não as execute contra produção.

Não refaça `next build` no mesmo diretório enquanto um servidor `next start` está atendendo os testes: os arquivos estáticos podem ser substituídos. Use a imagem Docker imutável, como na validação final.

## Limites restantes

“Treinamento” significa RAG e curadoria administrativa; não altera pesos do Ollama. PDFs precisam de camada de texto (OCR não incluído). A qualidade depende do modelo e da base aprovada; prompt injection e alucinações não têm garantia geral de eliminação. Não são implementados Embedded Signup, mídia WhatsApp, modelos com parâmetros nomeados/cabeçalhos dinâmicos/botões, preço automático Meta ou editor genérico de automações/etapas. Os controles de envio e a exclusão global permanecem obrigatórios.

Windows 11, hardware TrueNAS, geração com pesos reais, Meta real e restauração em nova tarefa de nuvem não foram testados nesta sessão. Os arquivos de implantação e os procedimentos foram entregues; requerem validação no destino.
