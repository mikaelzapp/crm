# CRM Multi WhatsApp Pro

CRM em português brasileiro para importar empresas, registrar autorizações, centralizar atendimento e executar campanhas pela API oficial da WhatsApp Business Platform. O backend persiste dados no PostgreSQL com pgvector; o worker BullMQ usa Redis para executar os envios. O modo de teste é explícito e não contata a Meta.

## Iniciar com Docker

Requisitos: Docker Engine com Compose v2 ou Docker Desktop; aproximadamente 4 GB de memória disponíveis para build e serviços. Em Windows 11, use Docker Desktop com WSL2 e contêineres Linux.

```sh
# A partir da raiz deste repositório; Node 22+ necessário apenas para este gerador.
node scripts/generate-env.mjs
# Consulte e personalize ADMIN_EMAIL e ADMIN_PASSWORD no .env local.
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Sem Node instalado, copie `.env.example` para `.env` e substitua os três `CHANGE_ME_*`: senha do PostgreSQL em hexadecimal seguro para URL, senha do administrador com pelo menos 12 caracteres e chave de criptografia com 64 caracteres hexadecimais. Não use os exemplos literalmente. No Windows, `instalar.bat` gera esses valores usando PowerShell e inicia os serviços; `iniciar.bat` retoma a instalação existente.

A interface usa a porta 3000. A porta é vinculada a `127.0.0.1` por padrão; consulte [implantação](docs/implantacao.md) para acesso na rede e HTTPS. O login usa `ADMIN_EMAIL` e `ADMIN_PASSWORD` do `.env`. O seed cria o primeiro administrador e preserva usuários existentes; editar a variável depois não deve ser usado como mecanismo de redefinição de senha.

O serviço `web` executa migrations SQL e seed antes de iniciar. O runner usa lock no PostgreSQL, transação e checksum das migrations; ele mantém o ledger compatível com Prisma e recusa migrations já aplicadas que tenham sido alteradas. O `worker` espera PostgreSQL, Redis e o endpoint de saúde do web. Dados ficam nos volumes `postgres_data` e `redis_data`; `docker compose down` os preserva. `docker compose down -v` os remove definitivamente.

## Primeiro fluxo

1. Entre como administrador. O seed opcional `MOCK_WHATSAPP_ENABLED=true` cria dois números de teste e modelos identificados como simulados.
2. Em **Contatos**, importe `CONTATOS_FINAIS_30.csv`. Revise a prévia e o mapeamento. O arquivo pessoal não faz parte do código versionado.
3. Confira o histórico de importação, os dados da empresa e a mensagem personalizada. As 37 colunas originais são preservadas. Importação nunca inicia uma campanha.
4. Registre autorização somente se existir opt-in real, com origem, finalidade e evidência. O valor “Não” em “Não contatar” não concede autorização.
5. Configure um número e sincronize modelos. Em teste, use conexão `MOCK`; em produção, configure a Meta conforme o [guia](docs/meta.md).
6. Crie uma campanha, escolha destinatários, número e modelo aprovado, confira orçamento/agendamento e confirme a execução. Contatos inelegíveis permanecem bloqueados com motivo.
7. Acompanhe campanhas e conversas. O webhook sincroniza mensagens e estados. Texto livre depende de mensagem recebida nas últimas 24 horas.

A suspensão global na Central de Segurança bloqueia novas saídas. Não há rotação de números para contornar restrições. Uma solicitação já aceita pela Meta pode continuar sendo entregue após a pausa.

## Desenvolvimento sem empacotar a aplicação

Node 22+, npm e Docker Compose são necessários. Use o checkout existente: cada tarefa de nuvem já é isolada; não é necessário criar um Git worktree.

```sh
node scripts/generate-env.mjs
npm ci --ignore-scripts
# Carregue .env no processo que executa estes comandos. tsx suporta --env-file.
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis
npm run db:generate
npm run db:migrate
npx tsx --env-file=.env prisma/seed.ts
npm run dev
# Em outro terminal com as mesmas variáveis:
npx tsx --env-file=.env src/worker.ts
```

A instalação usa `--ignore-scripts` para evitar downloads de engines nativas não utilizadas. Os checksums do lockfile e a verificação TLS continuam ativos. O comando `db:generate` executa explicitamente o gerador Prisma fixado em 6.19.0 com engine JavaScript e adaptador PostgreSQL; não depende de `prisma migrate` nativo.

Prisma e Next leem `.env`; o worker executado com `tsx` precisa do `--env-file` ou das variáveis exportadas. `DATABASE_URL` e `REDIS_URL` locais já constam do arquivo gerado. Em Compose, essas URLs são substituídas pelos nomes internos `postgres` e `redis`.

```sh
npm run typecheck
npm test
npm run build
# Com serviços e ambiente de teste disponíveis:
npm run test:integration
npm run test:e2e
```

Os testes externos usam mocks. Os comandos de integração podem criar ou remover registros de teste; execute-os em banco dedicado, conforme o próprio runner. Os resultados efetivamente executados nesta entrega estão no relato de validação, não são inferidos da existência dos scripts.

## Estrutura

| Caminho | Responsabilidade |
| --- | --- |
| `src/app` | Interface Next/React e API autenticada |
| `src/lib/csv.ts` | Detecção, mapeamento, normalização e importação |
| `src/lib/whatsapp.ts` | Adaptador oficial Meta e adaptador de teste |
| `src/lib/campaigns.ts` | Elegibilidade, orçamento e fila |
| `src/lib/webhooks.ts` | Assinatura, recebimento, status e opt-out |
| `src/worker.ts` | Processamento BullMQ e retomada |
| `prisma` | Schema, migrations e primeiro administrador |
| `tests` | Testes de unidade, integração e navegador |
| `scripts` | Inicialização, configuração, backup e restauração |

## IA opcional com Ollama

Configure agentes por conexão, escolha modelos já instalados e mantenha os modos OFF, SUGGEST ou AUTO conforme o controle desejado. A base de conhecimento usa PostgreSQL/pgvector para RAG e correções aprovadas; ela não altera os pesos dos modelos. A permissão de processamento por IA é explícita por conversa e não substitui o opt-in de comunicação.

O Compose oferece Ollama em um perfil opcional, sem baixar pesos nem publicar sua API automaticamente:

```sh
docker compose --profile ollama up -d ollama
docker compose exec -e OLLAMA_HOST=http://127.0.0.1:11434 ollama ollama pull qwen3.5:4b
docker compose exec -e OLLAMA_HOST=http://127.0.0.1:11434 ollama ollama pull all-minilm
```

Veja [Ollama, modelos, RAG e privacidade](docs/ollama.md) para instalação no Windows/TrueNAS, URLs host versus Docker, recursos, documentos, histórico e testes. Instalações PostgreSQL anteriores precisam da imagem pgvector 16 e de backup antes da atualização.

## Limites do MVP

A integração real exige conta empresarial, aplicativo Meta, permissões, token válido, números cadastrados e webhook HTTPS público. Nenhum teste simulado comprova envio real. O cadastro neste MVP usa credenciais oficiais fornecidas pelo administrador; Embedded Signup e faturamento automático da Meta não estão implementados. A IA opcional utiliza Ollama local ou privado, com modelos instalados e configuração por agente. O orçamento usa custo unitário informado pelo operador, não uma cotação automática da Meta. O envio de modelos neste MVP suporta corpo de texto com parâmetros e cabeçalho fixo; mídia, cabeçalhos dinâmicos e botões exigem implementação adicional.

O sistema não verifica automaticamente se um número descoberto em uma base é um WhatsApp ativo e não transforma essa informação em consentimento. Limites, qualidade e disponibilidade da API dependem da conta e da Meta. O produto não prevê nem impede todos os bloqueios.

Consulte [segurança e operação](docs/seguranca.md), [Meta](docs/meta.md) e [Windows/TrueNAS](docs/implantacao.md).

Os resultados e comandos de reprodução estão em [validação](docs/validacao.md). O arquivo CSV privado fornecido precisa estar em `private/CONTATOS_FINAIS_30.csv` ou no caminho `TEST_CSV_PATH` para executar as verificações específicas das 30 empresas. O código não inclui dados pessoais nem credenciais.
