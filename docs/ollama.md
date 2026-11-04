# Ollama e base de conhecimento por agente

A IA é opcional. O CRM continua disponível quando o Ollama está desligado. A integração é feita pelo backend com a API do Ollama; o navegador não recebe credenciais nem define destinos de rede arbitrários.

## Ollama em Docker

O Compose inclui um serviço opcional no perfil `ollama`, sem publicação de porta no arquivo de produção. Os modelos ficam no volume `ollama_models` e não são baixados automaticamente ao iniciar o CRM.

```sh
# A partir da raiz do checkout, com .env configurado:
docker compose --profile ollama up -d ollama
# Baixe explicitamente os modelos que você decidiu usar:
docker compose exec -e OLLAMA_HOST=http://127.0.0.1:11434 ollama ollama pull qwen3.5:4b
docker compose exec -e OLLAMA_HOST=http://127.0.0.1:11434 ollama ollama pull all-minilm
docker compose exec -e OLLAMA_HOST=http://127.0.0.1:11434 ollama ollama list
# Web/worker usam http://ollama:11434 dentro da rede Docker.
docker compose up -d web worker
```

`qwen3.5:4b` é uma opção de modelo de conversa; ele só pode ser selecionado depois de instalado e reconhecido pelo Ollama. `all-minilm` é um exemplo de modelo de embeddings, não um substituto do modelo de conversa. Você pode escolher outro modelo compatível na configuração do agente. Os downloads precisam alcançar os registros oficiais usados pelo Ollama e respeitar a política de rede do ambiente.

Os comandos de CLI e o healthcheck usam explicitamente `127.0.0.1` para falar com o servidor local dentro do contêiner. O download de pesos continua sujeito ao proxy, à verificação TLS e à política de rede do servidor. Em ambientes restritos, o registro `registry.ollama.ai` e os destinos de distribuição realmente utilizados precisam estar autorizados; um servidor saudável com lista vazia ainda não permite geração.

A imagem padrão é `ollama/ollama:latest`. Após validar sua instalação, fixe `OLLAMA_IMAGE` em uma versão ou digest que você tenha testado. Atualizar a imagem não instala nem atualiza os pesos automaticamente.

Para executar Next e worker no host com o Ollama do Compose:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml --profile ollama up -d postgres redis ollama
# OLLAMA_BASE_URL=http://127.0.0.1:11434 nos processos npm do host.
```

O override de desenvolvimento publica 11434 somente em loopback. Não exponha diretamente a API do Ollama à internet: o serviço local não fornece por si só o controle de acesso do CRM.

## Ollama instalado no Windows ou em outro servidor

No Windows 11, instale o Ollama pelo distribuidor oficial e baixe os modelos usando `ollama pull`. Para Next executado diretamente no Windows, use `OLLAMA_BASE_URL=http://127.0.0.1:11434`.

Para web/worker em Docker acessarem o Ollama do host, configure `OLLAMA_DOCKER_BASE_URL=http://host.docker.internal:11434`. O Compose inclui o mapeamento `host.docker.internal:host-gateway` para hosts Linux compatíveis. O Ollama precisa escutar numa interface alcançável pelo Docker, e o firewall deve permitir somente a rede necessária. `127.0.0.1` dentro do contêiner aponta para o próprio contêiner.

Para Ollama em servidor de rede, configure a URL privada estável no ambiente do backend. Em rede não confiável, use HTTPS e proxy de autenticação; `OLLAMA_API_KEY` é opcional para esse proxy, não uma senha exigida por uma instalação Ollama local padrão. Nunca inclua a chave no frontend, em documentos de conhecimento ou em instruções do agente.

| Variável | Uso |
| --- | --- |
| `OLLAMA_BASE_URL` | URL usada por Next/worker executados diretamente no host |
| `OLLAMA_DOCKER_BASE_URL` | URL que o Compose injeta como `OLLAMA_BASE_URL` nos serviços web/worker |
| `OLLAMA_TIMEOUT_MS` | Prazo operacional padrão da chamada, inicialmente 60000ms |
| `OLLAMA_KEEP_ALIVE` | Permanência solicitada do modelo em memória, inicialmente `5m` |
| `OLLAMA_API_KEY` | Credencial opcional de proxy protegido, somente no servidor |
| `OLLAMA_IMAGE` | Imagem do serviço opcional Ollama no Compose |

O timeout também pode ser configurado por agente dentro dos limites aceitos pelo servidor. Não aumente o tempo indefinidamente para esconder indisponibilidade; encaminhe para atendimento humano quando a inferência não terminar com segurança.

## Recursos e TrueNAS SCALE

CPU é suficiente para executar modelos compatíveis, com velocidade dependente do hardware. Um modelo quantizado de 4 bilhões de parâmetros pode consumir vários GB para pesos, contexto e runtime. Reserve memória adicional para PostgreSQL, Redis, Next, worker e sistema operacional; use a medição real da instalação para escolher o contexto e o modelo.

O Compose padrão não exige nem configura GPU. No TrueNAS, o acesso a GPU depende da versão, do driver e da configuração do aplicativo. Se você optar por GPU, configure os recursos de acordo com o runtime e a documentação oficial do Ollama/TrueNAS. Não é necessário conceder privilégios completos ao contêiner para o fluxo padrão em CPU.

Para instalar em servidor separado, permita apenas os acessos privados do web/worker ao Ollama. Neste ambiente de nuvem, use os mecanismos suportados de proxy/TCP e sua política; não crie rotas diretas para contornar bloqueios. A configuração de modelos ou uma chamada simulada não comprova que um modelo real foi executado.

## PostgreSQL com pgvector

A busca semântica usa a extensão `vector` do PostgreSQL. O Compose utiliza `pgvector/pgvector:pg16`, compatível com a mesma versão major 16 do volume PostgreSQL anterior. A migration da IA cria a extensão e as estruturas necessárias. Um PostgreSQL16 sem pgvector instalado não pode executar essa migration.

Antes de atualizar uma instalação existente:

1. Faça backup lógico com `scripts/backup.sh` e guarde a chave de criptografia por procedimento separado.
2. Pare web e worker durante a troca da imagem do PostgreSQL. Preserve o volume `postgres_data`; não use `down -v`.
3. Recrie o serviço PostgreSQL com a imagem pgvector 16. Aguarde o healthcheck.
4. Inicie o web para aplicar migrations, depois o worker. Confirme os dados anteriores e o status da base de conhecimento.
5. Faça um teste de restauração em banco separado. O destino também precisa ter pgvector instalado.

A troca da imagem não migra uma major diferente de PostgreSQL. Se a instalação usar outra versão major, planeje `pg_dump`/restauração ou `pg_upgrade` separadamente.

## Configurar agentes

Na área de IA, confira o estado do Ollama e os modelos instalados. Crie um agente associado à conexão empresarial correta, escolha o modelo de conversa e configure instruções, perguntas frequentes, serviços, preços e limites de histórico.

Os modos são:

- **OFF:** sem respostas por IA nessa configuração.
- **SUGGEST:** a IA prepara sugestões para revisão humana.
- **AUTO:** permite resposta automática somente quando as regras do servidor autorizam.

A mudança para AUTO não libera campanhas e não inventa autorização. Processamento de IA exige permissão explícita por conversa; envios continuam sujeitos à autorização de comunicação, exclusão global, número habilitado, suspensão emergencial e janela de atendimento. Falha ou indisponibilidade da IA deve conservar o atendimento humano.

As instruções do agente não podem substituir as regras do backend. O agente não tem acesso direto a tokens da Meta nem ferramentas livres para enviar mensagens ou acessar URLs fornecidas pelo usuário.

## Documentos, RAG e correções

A base de conhecimento pertence ao agente. O CRM extrai o texto suportado, divide o conteúdo em trechos e cria embeddings com o modelo configurado. A recuperação usa somente o contexto do agente/conexão autorizados. Mudar o modelo de embeddings exige reindexar as fontes; vetores de modelos diferentes não devem ser comparados como se fossem equivalentes.

RAG fornece documentos e correções aprovadas como contexto durante a inferência. Esse fluxo **não treina nem altera os pesos** do modelo Ollama. Uma correção pode ser registrada após uma resposta e precisa de aprovação administrativa antes de entrar na base de aprendizado. Uma sugestão rejeitada não vira automaticamente uma regra comercial.

Os uploads aceitam TXT em UTF-8, PDF com texto e DOCX, com no máximo 5 MiB por arquivo e 100 mil caracteres extraídos. PDFs têm limite de 100 páginas; arquivos criptografados e DOCX com estrutura ou descompactação inválidas são recusados. Há limite de 100 fontes por agente. Os trechos usam até 900 caracteres, com sobreposição de 120.

Confira o status de indexação de cada fonte. Um upload aceito não significa que embeddings já foram concluídos. Erros de extração, modelo ausente ou falha no Ollama precisam ser corrigidos e a indexação repetida. PDFs digitalizados sem texto precisam de OCR externo antes de serem úteis; não há garantia de leitura de páginas compostas apenas por imagem.

Documentos e mensagens são dados não confiáveis. Não inclua segredos e não use texto de um documento como permissão para ignorar instruções, acessar outra conexão ou criar consentimento. O isolamento, a validação de saída e os controles do servidor reduzem risco de prompt injection, mas não garantem respostas corretas em todos os casos. Revise preços, promessas e fatos antes de colocá-los em produção.

## Histórico e privacidade

A retenção é uma opção explícita do agente. Com histórico habilitado, o contexto usa os registros autorizados dentro do limite configurado. Com histórico desabilitado, os registros temporários de entrada/saída de teste e sugestões expiram após 24h e o worker executa a limpeza. Essa escolha não apaga o histórico operacional normal do CRM ou mensagens já recebidas pela integração WhatsApp.

A permissão da conversa para processamento por IA é separada do consentimento para comunicação comercial. Habilitar uma não concede a outra. A exclusão administrativa de um contato deve abranger os vínculos da IA conforme a política de dados; backups antigos continuam sujeitos à retenção da organização.

## Verificação

Valide status do servidor, lista real de modelos, seleção por agente, documento indexado e uma pergunta controlada na área de teste. Depois confira correções, aprovação e contexto recuperado. Os testes automatizados podem usar um servidor compatível de respostas fixas; esse modo deve ser identificado e não comprova a qualidade nem a execução de pesos reais.

Os testes de CRM continuam usando números MOCK para evitar mensagens reais. Só declare a integração Meta ou a inferência de um modelo real verificadas quando houver credenciais/modelos disponíveis e evidência da operação correspondente.


### Fixture explícita para testes automatizados

O servidor `tests/fixtures/ollama-server.mjs` implementa respostas HTTP determinísticas compatíveis com os endpoints utilizados. Ele é exclusivamente um test double, não carrega pesos e não participa de fallback de produção.

```sh
# Terminal 1:
node tests/fixtures/ollama-server.mjs
# Terminal 2: inicie uma instância de teste do web/worker usando
# OLLAMA_BASE_URL=http://127.0.0.1:11435
# Modelos disponíveis somente nessa fixture:
# fixture-chat:latest e fixture-embed:latest
```

O marcador sintético `TEST_OLLAMA_TIMEOUT` atrasa a resposta para testar timeout; a fixture registra apenas contagens de operações, sem imprimir mensagens ou documentos. Os embeddings são vetores determinísticos de teste para exercitar pgvector; não comprovam qualidade semântica de um modelo real.


Para executar os testes de navegador da IA com o backend/worker apontando à fixture, use um banco de teste e a origem correta da instância:

```sh
RUN_AI_BROWSER_TESTS=1 BASE_URL=http://localhost:3002 \
  AI_BROWSER_MODEL=fixture-chat:latest \
  AI_BROWSER_EMBEDDING_MODEL=fixture-embed:latest \
  npm run test:e2e -- ai-browser.spec.ts
```

Sem `RUN_AI_BROWSER_TESTS=1`, esse conjunto opcional é explicitamente ignorado. Com a variável habilitada, ausência de provider/modelos causa falha; não há aprovação silenciosa de uma integração indisponível. O rótulo SIMULADO nos testes e nas respostas da fixture distingue esse resultado de inferência real. Os contatos e permissões usados pelos testes são sintéticos e removidos ao final.
