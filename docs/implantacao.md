# Instalação e implantação

O [tutorial ilustrado de instalação](tutorial-instalacao.md) reúne os passos para **Windows 11, Linux, TrueNAS SCALE e macOS**, com comandos copiáveis e capturas do CRM. O mesmo conteúdo de orientação está disponível na tela pública **Instalação** do aplicativo, em `/instalacao`, inclusive antes do login.

Repositório: https://github.com/mikaelzapp/crm. Alternativa: [ZIP da branch main](https://github.com/mikaelzapp/crm/archive/refs/heads/main.zip).

## Pré-requisitos comuns

Use Docker Engine/Compose v2 ou Docker Desktop com contêineres Linux. Planeje 8 GB de RAM para CRM e serviços; para IA com modelo de 4B, prefira 16 GB ou mais. Recursos efetivos variam com modelo, contexto, quantização e hardware. Ollama é opcional e nenhum peso é instalado automaticamente.

O fluxo Docker não exige Node no host. O helper POSIX usa um contêiner temporário com UID/GID do operador; no Windows, `instalar.bat` usa PowerShell. Ambos preservam `.env` existente. Leia as credenciais no arquivo usando editor local, sem publicá-las em logs ou no Git.

## Rede e HTTPS

A configuração padrão publica somente web em `127.0.0.1:3000`. PostgreSQL/pgvector e Redis permanecem na rede interna. Para acesso LAN, configure `BIND_ADDRESS` adequadamente e `APP_URL` com a origem que o navegador usará. Para acesso público, use proxy reverso com certificado HTTPS válido.

`APP_URL`, host e protocolo devem corresponder à origem do navegador, pois o CRM verifica a origem das mutações. A Meta precisa alcançar `/api/webhooks/whatsapp` publicamente por HTTPS. Os detalhes estão no [guia da Meta](meta.md).

`docker-compose.dev.yml` expõe banco e Redis somente em loopback para desenvolvimento e, se o perfil Ollama estiver ativo, publica 11434 também em loopback. O override não é necessário para executar tudo dentro do Compose.

## TrueNAS SCALE

Use uma versão com backend Docker/Apps, como 24.10 ou posterior, e confira a documentação da sua versão. Prepare datasets e ACLs pela interface do appliance. Não instale Docker ou pacotes via `apt` no TrueNAS.

O tutorial usa Shell/Compose quando disponível. A interface de aplicativo personalizado por YAML pode exigir `image:` pré-construída em registro em vez de `build:`. Não trate o YAML deste repositório como construção automática garantida em qualquer versão do painel.

Preserve o nome do projeto Compose `crm-whatsapp` e os volumes de dados. Se preferir datasets bind-mounted, configure ownership/ACL para os usuários efetivos das imagens. A imagem `pgvector/pgvector:pg16` mantém a major 16 do PostgreSQL e oferece a extensão exigida pelas migrations de IA. Uma troca de major exige plano de migração próprio.

## Nuvem gerenciada Codex

Cada tarefa já usa ambiente isolado. Use o checkout existente em `/workspace/crm`; não crie worktrees para a configuração usual.

A rede externa usa o proxy e a CA da plataforma. Preserve `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, autenticação injetada e verificações TLS. A CA não deve ser copiada para camadas da imagem.

Quando `CODEX_PROXY_CERT` estiver disponível:

```bash
docker compose -f docker-compose.yml -f docker-compose.cloud.yml build
docker compose -f docker-compose.yml -f docker-compose.cloud.yml up -d
```

Para incluir o serviço Ollama opcional:

```bash
docker compose -f docker-compose.yml -f docker-compose.cloud.yml --profile ollama up -d ollama
```

O override fornece a CA como BuildKit secret nos builds e arquivo somente leitura no runtime. Ollama usa `SSL_CERT_FILE` para os downloads; Node usa `NODE_EXTRA_CA_CERTS`. O healthcheck e os comandos CLI do Ollama usam explicitamente loopback para falar com seu próprio servidor, mantendo proxy/TLS no tráfego externo de modelos.

A rede precisa permitir os registros de pacotes usados no build e `graph.facebook.com` para a integração Meta real. Modelos Ollama precisam do registro e dos destinos de distribuição utilizados, incluindo `registry.ollama.ai` quando esse for o registro consultado. Use a configuração suportada da plataforma; não contorne uma negação de política com acesso direto ou TLS desabilitado.

Uma API Ollama respondendo com lista vazia comprova disponibilidade do servidor, não a instalação de modelos ou inferência real. Consulte [Ollama](ollama.md) e [Validação](validacao.md) para os resultados efetivamente observados.

## Atualização e recuperação

Faça backup antes de atualizar. Preserve `.env`, `ENCRYPTION_KEY`, nome do projeto Compose e volumes. Atualize o código ou a imagem e execute `docker compose up -d --build`; depois confira saúde e logs sem divulgar segredos.

O web aplica migrations ao iniciar. Trocar a imagem para uma versão antiga não reverte migrations automaticamente. Verifique compatibilidade do schema antes de um rollback. Teste restauração em ambiente separado e mantenha backups fora do host conforme sua política.

Os detalhes de backup, restauração, retenção e exclusão estão no [guia de segurança](seguranca.md).
