# Windows 11, TrueNAS SCALE e nuvem

## Windows 11

1. Instale WSL2 e Docker Desktop com contêineres Linux. Abra Docker Desktop e aguarde o daemon estar disponível.
2. Coloque o repositório em uma pasta local; evite edição simultânea do banco/volumes pelo host.
3. Execute `instalar.bat`. O PowerShell gera `.env` apenas se ele não existir; não imprime os segredos. Se a política do computador impedir o script, crie `.env` manualmente conforme `.env.example` e execute `docker compose up -d --build`.
4. Aguarde `docker compose ps` mostrar web saudável. Acesse a porta 3000 e use as credenciais locais em `.env`.
5. Para retomar depois de reiniciar o Windows, inicie Docker Desktop e execute `iniciar.bat`.

Não é necessário instalar PostgreSQL, Redis ou Node no Windows para usar os scripts `.bat`. O script de geração alternativo `.mjs` requer Node 22+.

## TrueNAS SCALE

Use uma versão do TrueNAS SCALE com suporte a aplicativos Docker/Compose. Versões antigas com outro orquestrador exigem migração ou implantação equivalente; este repositório não fornece charts Kubernetes.

1. Mantenha o código em dataset dedicado, fora de diretórios públicos. Use o shell com Compose disponível ou a opção de aplicativo personalizado por YAML oferecida pela sua versão.
2. Configure os valores de `.env` no mecanismo de variáveis/segredos de sua instalação. Não cole senhas em URLs públicas, tickets ou logs.
3. Construa a imagem no host com `docker compose build` ou distribua uma imagem construída por CI em registro privado. A opção YAML do TrueNAS pode exigir `image:` pré-construída em vez de `build:`.
4. Preserve volumes PostgreSQL e Redis. Se substituir volumes nomeados por datasets bind-mounted, configure ownership/ACL para os usuários efetivos das imagens; PostgreSQL 16 usa `/var/lib/postgresql/data`. Não copie um datadir vivo como se fosse um backup consistente.
5. O vínculo padrão `127.0.0.1:3000` permite proxy reverso no mesmo host. Para acesso direto da rede, configure `BIND_ADDRESS` com o endereço LAN desejado e restrinja o acesso no firewall. Não publique as portas de PostgreSQL/Redis.
6. Use proxy reverso com HTTPS e `APP_URL=https://seu-dominio`. Encaminhe o host e o protocolo de forma coerente. A Meta precisa alcançar a rota de webhook publicamente por HTTPS.
7. Configure uma política de snapshots de datasets e backups lógicos. Teste uma restauração em ambiente separado antes de depender deles.

`docker-compose.dev.yml` abre banco e Redis apenas em loopback para desenvolvimento; não é necessário no servidor. O redirecionamento de portas e a emissão de certificados dependem da rede do usuário e não são provisionados pelo CRM.

## Nuvem gerenciada Codex

Cada tarefa já usa um ambiente isolado. Use `/workspace/crm` existente; não crie worktrees para a configuração usual.

Acesso externo usa o proxy e a CA da plataforma. Preserve `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` e os mecanismos de autenticação injetados. A CA não deve ser copiada para camadas da imagem e as verificações TLS devem permanecer habilitadas.

Para build com certificado da sessão, quando disponibilizado como `CODEX_PROXY_CERT`:

```sh
docker compose -f docker-compose.yml -f docker-compose.cloud.yml build
# A mesma composição monta a CA no runtime para as chamadas oficiais.
docker compose -f docker-compose.yml -f docker-compose.cloud.yml up -d
```

O override fornece `proxy_ca` como BuildKit secret e arquivo somente leitura no runtime. A configuração padrão do Docker da plataforma precisa fornecer o endereço de proxy acessível aos contêineres; não substitua o proxy por uma rota direta. Para desenvolvimento no host, use a confiança TLS já configurada e as variáveis herdadas.

Redes restritas precisam permitir os registros de pacotes usados no build e `graph.facebook.com` para integração real. A lista de domínios deve ser alterada pela configuração suportada da plataforma. O modo mock não precisa alcançar a Meta. Não declare a API real testada apenas porque a rede ou o build funcionaram.

## Atualização e rollback

Faça backup antes de atualizar. Preserve `.env`, `ENCRYPTION_KEY` e volumes. Atualize o código ou a tag da imagem, execute `docker compose up -d --build` e verifique saúde e logs sem publicar segredos. Migrations são aplicadas pelo web; confirme a compatibilidade do schema antes de voltar para uma versão antiga. Migrations não são automaticamente revertidas por trocar a imagem.
