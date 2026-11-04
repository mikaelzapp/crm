# Segurança, dados e operação

## Autenticação e permissões

O MVP tem papéis `ADMIN` e `AGENT`, hash de senha, sessão persistida e cookie HTTP-only. Configure `APP_URL` corretamente, use HTTPS em produção e mantenha o acesso administrativo restrito. Credenciais e tokens não devem aparecer em Git, capturas de tela de configuração ou logs compartilhados.

O primeiro administrador vem de `ADMIN_EMAIL` e `ADMIN_PASSWORD`. A senha precisa ter pelo menos 12 caracteres. O seed preserva usuários existentes; não é uma interface de redefinição de senhas. Não distribua o mesmo `.env` entre instalações independentes.

## Tokens e backups

`ENCRYPTION_KEY` deve conter 32 bytes em hexadecimal. Tokens das conexões são cifrados individualmente com AES-GCM. Guarde a chave fora do banco e mantenha uma cópia protegida: perder a chave impede recuperar os tokens, mesmo se o banco for restaurado. Trocar a variável sem recifrar tokens existentes não é rotação de chave.

Faça backup do banco e guarde `.env`/chave por procedimento seguro separado. Os arquivos de backup contêm dados pessoais e precisam de acesso restrito, criptografia em repouso e retenção definida. Não inclua `private/` no controle de versão.

No Linux ou shell compatível:

```sh
./scripts/backup.sh
# Restauração destrutiva; faça em banco/ambiente de recuperação primeiro:
./scripts/restore.sh private/backups/ARQUIVO.dump --confirmar-substituicao
```

O backup usa `pg_dump` em formato customizado e só publica o arquivo final após sucesso. A restauração para web e worker, aplica o dump com parada em erro e religa os serviços após sucesso. Em erro, os escritores ficam parados para inspeção. Nunca execute restauração de arquivo não confiável. Guarde backups fora do host e teste a recuperação periodicamente.

Redis usa AOF e o PostgreSQL conserva a fonte durável de destinatários/mensagens. Após recuperação, não envie manualmente destinatários em estado incerto: a Meta pode já ter aceitado a mensagem. Revise os IDs externos e estados antes de qualquer nova ação. Uma restauração antiga pode perder registros de envios mais recentes; suspenda campanhas durante a reconciliação.

## Consentimento, exclusão e retenção

Antes de qualquer campanha, mantenha origem, finalidade, data e evidência de autorização. Revogação e pedidos de cancelamento devem impedir novas saídas. A exclusão global é por telefone, portanto um novo import não deve liberar um número excluído. Uma lista de supressão contém dado pessoal e tem finalidade distinta: evitar novo contato.

Defina a política da organização para reter cadastros, mensagens, importações e evidências. O MVP oferece exclusão administrativa de contato; não há expurgo automático por prazo, política jurídica pronta nem garantia automática de conformidade com a LGPD. Faça revisão periódica e estabeleça o procedimento para acesso, correção e exclusão solicitado pelo titular. Backups antigos seguem a retenção definida e não são reescritos pela exclusão do cadastro ativo.

Não trate dados importados como informações verificadas sobre atividade do WhatsApp ou consentimento. Preserve a fonte e a evidência; revise inconsistências de telefone, duplicação e mapeamento no relatório da importação.

## Campanhas e incidentes

O worker revalida autorização, exclusão, status da conexão, modelo e suspensão global antes do envio. O limite operacional local deve ficar abaixo dos limites oficiais. Use a suspensão global diante de credenciais comprometidas, restrição, volume inesperado ou qualidade degradada e investigue antes de retomar.

Pausar uma campanha impede novas submissões; não cancela uma mensagem já aceita pela plataforma. Falhas incertas não podem ser reenviadas automaticamente. A estratégia de fila evita duplicação interna, mas APIs externas não fornecem uma garantia geral de entrega exatamente uma vez.

Webhooks são dados externos: valide assinatura antes de processar. Não desligue TLS, assinatura ou validação para contornar erro. O webhook pode ser reenviado pela Meta e deve ser processado de modo idempotente.

## Operação diária

Verifique `docker compose ps`, saúde do web, fila/worker, erros por número, destinatários bloqueados, pedidos de exclusão e backups. Não use ausência de logs como prova de sucesso. Restrinja Redis e PostgreSQL à rede interna. Mantenha as imagens e dependências atualizadas e revise permissões da Meta periodicamente.
