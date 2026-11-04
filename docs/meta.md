# Configuração oficial da Meta

## Pré-requisitos

Use um aplicativo empresarial no Meta for Developers, uma conta WhatsApp Business (WABA), número empresarial cadastrado e permissões adequadas. Os nomes e exigências do painel podem mudar; confirme os requisitos na documentação oficial: https://developers.facebook.com/docs/whatsapp/cloud-api/ e https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/.

O MVP utiliza a Cloud API oficial. Não usa QR code, sessão do WhatsApp Web, scraping de sessões nem provedores não oficiais. O onboarding via Embedded Signup não foi implementado: o administrador cadastra as credenciais já provisionadas pela Meta.

## Configurar o aplicativo

1. Cadastre e verifique os números na WABA conforme as exigências da Meta. Tenha WABA ID, Phone Number ID e token com os escopos necessários (por exemplo, `whatsapp_business_messaging` e `whatsapp_business_management`). Para operação contínua, use o fluxo oficial de usuário de sistema e gestão de expiração/permissões.
2. Configure `META_APP_SECRET` com o segredo do aplicativo e `META_VERIFY_TOKEN` com um valor aleatório escolhido para a verificação inicial. Mantenha esses valores fora do Git.
3. Configure `APP_URL` com a origem pública HTTPS do CRM. Publique a rota `/api/webhooks/whatsapp` por proxy reverso com certificado TLS válido.
4. No painel Meta, configure a callback `https://SEU_DOMINIO/api/webhooks/whatsapp` e o verify token. Assine os eventos de mensagens necessários e vincule o aplicativo à WABA. A rota GET responde ao desafio apenas se o token coincidir.
5. Configure `WHATSAPP_MODE=live`, reinicie web e worker e cadastre a conexão com modo `META`, WABA ID, Phone Number ID, número e token. O token é criptografado com AES-GCM no banco usando `ENCRYPTION_KEY`; a API não o devolve à interface.
6. Sincronize a conexão e os modelos. O envio implementado suporta parâmetros do corpo de texto e cabeçalho fixo; modelos com mídia, cabeçalhos dinâmicos ou botões são recusados pelo MVP. O status de aprovação deve vir da Meta. Um modelo de teste não deve ser convertido em modelo aprovado de produção.
7. Registre opt-in real para um destinatário de teste permitido. Verifique modelo, parâmetros, custo informado e limite operacional antes de confirmar qualquer campanha real.

Cadastre duas conexões com Phone Number IDs distintos para operar dois números. Cada conversa é vinculada ao contato e ao número empresarial; respostas saem pelo número daquela conversa.

## Mensagens e autorização

A mensagem personalizada importada do CSV é um rascunho. Fora da janela de 24 horas, uma conversa só pode ser iniciada com modelo aprovado e parâmetros aceitos. Texto livre exige uma mensagem recebida há menos de 24 horas. Uma resposta recebida não registra automaticamente autorização para campanhas futuras.

Não use “Não contatar = Não”, presença de link `wa.me`, publicação de telefone empresarial ou evidência de WhatsApp como autorização. Registre origem, finalidade e evidência do opt-in. Opt-out adiciona o número à exclusão e impede novas saídas.

O webhook POST valida `X-Hub-Signature-256` com HMAC SHA-256 do corpo bruto e `META_APP_SECRET`. Não remova a verificação em produção. IDs externos tornam os eventos repetidos idempotentes. Confirme no painel da Meta se há eventos em erro e ajuste autenticação/assinatura sem desligar verificações.

## Falhas e retomada

HTTP 429 e falhas temporárias com resposta conhecida podem ser reagendados com backoff. Rejeições permanentes são registradas. Uma falha de conexão após submissão pode ter resultado desconhecido; nesses casos, o CRM deve conservar o estado incerto para revisão em vez de reenviar às cegas. Pausa/cancelamento não retiram mensagens já aceitas pela plataforma.

Preços variam por categoria, país e regras vigentes. O orçamento deste MVP usa o custo unitário informado; preencha um valor conservador e acompanhe a cobrança oficial. Limites locais são uma proteção adicional, não substituem limites da Meta.

## Modo simulado

`WHATSAPP_MODE=mock` e conexões `MOCK` usam respostas locais identificadas como teste. Não forneça tokens de produção para esse modo. O seed opcional `MOCK_WHATSAPP_ENABLED=true` cria conexões e modelos apenas de teste. Mocks exercitam o fluxo interno; não validam cadastro empresarial, permissões, qualidade, faturamento, entrega ou disponibilidade real da API.

Tokens expirados ou configurações inválidas não devem provocar fallback silencioso de produção para simulação. Corrija a configuração e repita a validação afetada.
