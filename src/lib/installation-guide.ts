/** Shared, static installation content. These commands never run in the browser. */
export type InstallationPlatformId = 'windows' | 'linux' | 'truenas' | 'macos';
export type InstallationCommand = {
  label: string;
  language: 'powershell' | 'bash' | 'text';
  code: string;
  note?: string;
};
export type InstallationImage = {src: string; alt: string; caption: string};
export type InstallationStep = {
  id: string;
  title: string;
  body: string[];
  commands: InstallationCommand[];
  links?: {label: string; href: string}[];
  image?: InstallationImage;
};
export type InstallationPlatform = {
  id: InstallationPlatformId;
  label: string;
  description: string;
  prerequisites: string[];
  steps: InstallationStep[];
};
export const installationImages = {
  login: {src: '/installation/login.png', alt: 'Tela de login do Conecta CRM', caption: 'Tela do CRM após a inicialização. Use as credenciais do seu arquivo .env.'},
  dashboard: {src: '/installation/dashboard.png', alt: 'Dashboard do Conecta CRM com dados fictícios', caption: 'Captura da interface com dados fictícios. Sua instalação exibirá os seus próprios dados.'},
  ai: {src: '/installation/ai-training.png', alt: 'Área de treinamento da IA no Conecta CRM com dados fictícios', caption: 'Exemplo da área de IA com dados fictícios. Modelos precisam estar instalados no seu Ollama.'},
} satisfies Record<string, InstallationImage>;
export const installationScreenshots = [
  {...installationImages.login, title: 'Entre no CRM'},
  {...installationImages.dashboard, title: 'Confira o seu workspace'},
  {...installationImages.ai, title: 'Configure a IA opcional'},
];
export const installationLinks = [
  {label: 'Código do CRM no GitHub', href: 'https://github.com/mikaelzapp/crm'},
  {label: 'Baixar o projeto em ZIP', href: 'https://github.com/mikaelzapp/crm/archive/refs/heads/main.zip'},
  {label: 'Docker Desktop para Windows', href: 'https://docs.docker.com/desktop/setup/install/windows-install/'},
  {label: 'Docker Engine para Linux', href: 'https://docs.docker.com/engine/install/'},
  {label: 'Docker Desktop para macOS', href: 'https://docs.docker.com/desktop/setup/install/mac-install/'},
  {label: 'Documentação do TrueNAS SCALE', href: 'https://www.truenas.com/docs/scale/'},
  {label: 'Instalação oficial do Ollama', href: 'https://ollama.com/download'},
];
export const installationSafetyNotes = [
  'As imagens são capturas da interface do CRM com dados fictícios; não são telas dos instaladores dos sistemas operacionais.',
  'Planeje 8 GB de RAM para o conjunto CRM e serviços. Para IA com um modelo de 4B, prefira 16 GB ou mais; consumo e velocidade variam com modelo, quantização e contexto.',
  'O gerador de .env cria segredos aleatórios e preserva um arquivo existente. Abra esse arquivo somente em um editor local; não publique senhas nem tokens.',
  'Execute os comandos na pasta crm que contém docker-compose.yml. Preserve o nome do projeto Compose e os volumes ao atualizar.',
  'Ollama é opcional. Baixar um modelo é uma ação separada; criar um agente não instala pesos nem autoriza mensagens.',
  'A integração real da Meta precisa de credenciais e webhook HTTPS público. Os números MOCK servem apenas para testes locais.',
];
export const installationNotices = installationSafetyNotes;

const checkDocker: InstallationCommand = {
  label: 'Conferir Docker e Compose', language: 'bash',
  code: 'docker --version\ndocker compose version',
  note: 'O Docker precisa estar iniciado e seu usuário precisa ter permissão para usá-lo.',
};
const clonePosix: InstallationCommand = {
  label: 'Baixar com Git e entrar na pasta', language: 'bash',
  code: 'git clone https://github.com/mikaelzapp/crm.git\ncd crm',
};
const generateEnv: InstallationCommand = {
  label: 'Gerar .env sem instalar Node no host', language: 'bash',
  code: String.raw`docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD:/app" -w /app \
  node:22-bookworm-slim node scripts/generate-env.mjs`,
  note: 'O usuário do host é preservado para que o arquivo .env criado com permissão restrita continue legível por você.',
};
const start: InstallationCommand = {
  label: 'Construir e iniciar o CRM', language: 'bash',
  code: 'docker compose config --quiet\ndocker compose up -d --build\ndocker compose ps',
};
const ollama: InstallationCommand = {
  label: 'Iniciar Ollama e baixar modelos explicitamente', language: 'bash',
  code: String.raw`docker compose --profile ollama up -d ollama
docker compose exec -e OLLAMA_HOST=http://127.0.0.1:11434 ollama ollama pull qwen3.5:4b
docker compose exec -e OLLAMA_HOST=http://127.0.0.1:11434 ollama ollama pull all-minilm
docker compose exec -e OLLAMA_HOST=http://127.0.0.1:11434 ollama ollama list`,
  note: 'Os downloads podem ser grandes e precisam de acesso ao registro do Ollama. A API do serviço permanece na rede Docker, sem porta pública por padrão.',
};
function accessStep(lan = false): InstallationStep {
  return {
    id: 'access', title: 'Acessar e conferir a instalação',
    body: [lan ? 'Abra no navegador a origem que você colocou em APP_URL, por exemplo http://192.168.1.50:3000. Esse IP é apenas um exemplo; use o endereço real do seu TrueNAS.' : 'Abra http://localhost:3000 no navegador do mesmo computador. Aguarde o serviço web aparecer como healthy em docker compose ps.',
      'Abra .env em um editor local e use ADMIN_EMAIL e ADMIN_PASSWORD na tela de login. Não há senha padrão para compartilhar. O seed preserva contas existentes; editar ADMIN_PASSWORD depois não redefine a senha de uma conta já criada.',
      'Na interface, importe seu CSV, confira as empresas e mantenha contatos pendentes de autorização até existir evidência válida. A importação não envia mensagens.'],
    commands: [], image: installationImages.login,
  };
}
function optionalAiStep(): InstallationStep {
  return {
    id: 'ollama', title: 'Configurar Ollama, se quiser usar IA',
    body: ['Esta etapa é opcional. O CRM funciona com os agentes desligados e com o Ollama indisponível.',
      'Depois do download, entre em Treinamento da IA, crie um agente por número e selecione um modelo de conversa instalado e um modelo de embeddings. Teste com dados sintéticos antes de habilitar sugestões ou automação.',
      'O Compose usa OLLAMA_DOCKER_BASE_URL=http://ollama:11434. Para Ollama já instalado no host, use http://host.docker.internal:11434 nessa variável. OLLAMA_BASE_URL=http://127.0.0.1:11434 é a opção para processos npm executados diretamente no host.',
      'RAG consulta textos, PDFs e DOCX aprovados; não altera os pesos do modelo. A permissão de IA por conversa é separada do opt-in de comunicação.'],
    commands: [ollama], image: installationImages.ai,
    links: [{label: 'Ollama: documentação oficial', href: 'https://docs.ollama.com/'}],
  };
}
function maintenanceStep(windows = false): InstallationStep {
  return {
    id: 'maintenance', title: 'Retomar, verificar e preservar seus dados',
    body: ['Após reiniciar a máquina, inicie o Docker e retome os serviços na mesma pasta do projeto.',
      'Os volumes guardam PostgreSQL/pgvector e Redis. Faça backup antes de atualizar e preserve .env e ENCRYPTION_KEY. Não remova volumes para tentar corrigir um problema de inicialização.',
      'Use os logs para diagnosticar uma falha e revise qualquer dado sensível antes de compartilhá-los.'],
    commands: [{label: windows ? 'Retomar no PowerShell' : 'Retomar e verificar', language: windows ? 'powershell' : 'bash', code: windows ? String.raw`.\iniciar.bat
docker compose ps` : 'docker compose up -d\ndocker compose ps'},
      {label: 'Ver os últimos logs do aplicativo', language: windows ? 'powershell' : 'bash', code: 'docker compose logs --tail=80 web worker'}],
    image: installationImages.dashboard,
  };
}
export const installationPlatforms: InstallationPlatform[] = [
  {
    id: 'windows', label: 'Windows 11', description: 'Docker Desktop com WSL2 e scripts .bat para instalar e iniciar.',
    prerequisites: ['Windows 11 com virtualização e WSL2 habilitados.', 'Docker Desktop iniciado, usando contêineres Linux e Compose v2.', 'Git para Windows, ou o ZIP do projeto extraído por completo.', 'PowerShell e uma pasta local em que você possa editar os arquivos do projeto.'],
    steps: [
      {id: 'docker', title: 'Preparar o Docker Desktop', body: ['Instale o Docker Desktop pela documentação oficial para Windows, habilite o backend WSL2 e aguarde o Docker iniciar.', 'Não é necessário instalar PostgreSQL, Redis ou Node separadamente para usar os scripts .bat.'], commands: [{...checkDocker, language: 'powershell'}], links: [installationLinks[2]]},
      {id: 'download', title: 'Baixar o CRM', body: ['Com Git instalado, execute os comandos abaixo no PowerShell.', 'Como alternativa, baixe o ZIP do GitHub, extraia a pasta inteira e abra o PowerShell nessa pasta. Confirme que docker-compose.yml e instalar.bat estão presentes. Se o repositório for privado, use sua conta com acesso ao GitHub.'], commands: [{label: 'Clonar pelo PowerShell', language: 'powershell', code: String.raw`git clone https://github.com/mikaelzapp/crm.git
Set-Location .\crm`}], links: [installationLinks[1]]},
      {id: 'install', title: 'Executar a instalação', body: ['Execute instalar.bat na raiz do projeto. Ele confere o Compose, gera .env apenas se necessário e constrói os serviços.', 'Se o PowerShell bloquear configure.ps1 por marca de arquivo baixado, consulte a orientação de desbloqueio abaixo; não altere a política global do computador.', 'A primeira construção precisa de internet e pode levar mais tempo. Não feche o Docker Desktop.'], commands: [{label: 'Instalar no PowerShell', language: 'powershell', code: String.raw`.\instalar.bat`}]},
      accessStep(), optionalAiStep(), maintenanceStep(true),
    ],
  },
  {
    id: 'linux', label: 'Linux', description: 'Docker Engine e Compose v2, sem exigir Node instalado no host.',
    prerequisites: ['Distribuição Linux suportada pelo Docker Engine.', 'Docker Engine em execução e plugin Docker Compose v2.', 'Git, ou ZIP do projeto extraído preservando arquivos iniciados por ponto.', 'Usuário autorizado a acessar o Docker e a pasta do projeto.'],
    steps: [
      {id: 'docker', title: 'Conferir Docker Engine e Compose', body: ['Instale Docker Engine e o plugin Compose seguindo a documentação oficial da sua distribuição.', 'Este guia parte de uma instalação Docker funcional e não executa scripts remotos de instalação do sistema.'], commands: [checkDocker], links: [installationLinks[3]]},
      {id: 'download', title: 'Baixar e entrar no projeto', body: ['Clone o repositório ou extraia o ZIP do GitHub. Os próximos comandos devem rodar dentro da pasta crm que contém docker-compose.yml.'], commands: [clonePosix], links: [installationLinks[1]]},
      {id: 'environment', title: 'Gerar a configuração local', body: ['O comando usa um contêiner Node temporário somente para gerar .env. Ele preserva o seu UID/GID e não imprime as senhas.', 'Um .env já existente é preservado. Abra-o em editor local se precisar ajustar a instalação.'], commands: [generateEnv]},
      {id: 'start', title: 'Construir e iniciar os serviços', body: ['O web aplica migrations e prepara o primeiro administrador. PostgreSQL/pgvector e Redis devem ficar saudáveis antes de o worker iniciar.', 'A porta 3000 fica vinculada a 127.0.0.1 por padrão. Para acesso remoto, configure uma origem coerente em APP_URL e um proxy reverso ou vínculo de rede apropriado.'], commands: [start]},
      accessStep(), optionalAiStep(), maintenanceStep(),
    ],
  },
  {
    id: 'truenas', label: 'TrueNAS SCALE', description: 'Dataset persistente e Compose no Shell em versões com backend Docker.',
    prerequisites: ['TrueNAS SCALE 24.10 ou posterior, com backend Docker/Apps e Compose disponível; confirme a documentação da sua versão.', 'Dataset criado previamente pela interface do TrueNAS, com permissões adequadas ao operador.', 'Acesso autorizado ao Shell e ao Docker; espaço persistente para banco, Redis, modelos e backups.', 'Git no Shell, ou cópia completa do ZIP extraído por SMB/SFTP autorizado. Não instale Docker ou pacotes do sistema com apt no appliance.'],
    steps: [
      {id: 'dataset', title: 'Preparar o dataset e conferir o runtime', body: ['Crie o dataset pela interface de armazenamento do TrueNAS e confira suas ACLs. Neste exemplo, /mnt/SEU_POOL/apps é um caminho ilustrativo.', 'Substitua SEU_POOL pelo nome real do pool e apps pelo seu dataset antes de executar qualquer comando. Não crie pastas em um caminho literal de exemplo.', 'O fluxo abaixo usa Compose no Shell. Aplicativos personalizados por YAML podem exigir uma imagem pré-construída; o compose com build não é automaticamente compatível com toda interface de Apps.'], commands: [checkDocker], links: [installationLinks[5]]},
      {id: 'download', title: 'Colocar o código no dataset', body: ['Entre no dataset existente e clone o projeto. Se Git não estiver disponível, extraia o ZIP em seu computador e copie a pasta completa para o dataset por um meio autorizado, preservando .env.example e os demais arquivos iniciados por ponto.'], commands: [{label: 'Substituir o caminho e baixar o CRM', language: 'bash', code: 'cd /mnt/SEU_POOL/apps\ngit clone https://github.com/mikaelzapp/crm.git\ncd crm', note: 'SEU_POOL e apps são placeholders. Substitua pelo caminho do dataset real antes de colar.'}]},
      {id: 'environment', title: 'Gerar .env e definir a origem da rede local', body: ['Gere .env usando o contêiner temporário. Em seguida, abra o arquivo em um editor e ajuste as duas linhas indicadas.', 'Substitua IP_DO_TRUENAS pelo IP real do servidor. O exemplo usa uma rede local confiável. Para publicação e webhook Meta, use proxy reverso com HTTPS e APP_URL correspondente.', 'O trecho de .env abaixo deve ser editado no arquivo; não é um comando de terminal.'], commands: [generateEnv, {label: 'Editar estas linhas no arquivo .env', language: 'text', code: 'BIND_ADDRESS=0.0.0.0\nAPP_URL=http://IP_DO_TRUENAS:3000', note: 'Preserve os demais valores, especialmente credenciais e ENCRYPTION_KEY.'}]},
      {id: 'start', title: 'Iniciar no mesmo projeto e preservar volumes', body: ['Inicie os serviços e aguarde web saudável. PostgreSQL/pgvector e Redis permanecem em volumes Docker.', 'Ao personalizar volumes como datasets bind-mounted, mantenha as permissões dos usuários das imagens. Não altere um datadir PostgreSQL vivo manualmente.', 'Preserve o nome crm-whatsapp do projeto Compose e faça backups lógicos além de sua política de snapshots.'], commands: [start]},
      accessStep(true), optionalAiStep(), maintenanceStep(),
    ],
  },
  {
    id: 'macos', label: 'macOS', description: 'Docker Desktop no Mac Intel ou Apple Silicon, com imagens selecionadas pela plataforma.',
    prerequisites: ['macOS suportado pela versão instalada do Docker Desktop.', 'Docker Desktop iniciado e Compose v2 disponível.', 'Terminal e Git, ou ZIP do projeto extraído por completo.', 'Memória e espaço adicionais se optar por modelos Ollama; desempenho depende do hardware.'],
    steps: [
      {id: 'docker', title: 'Instalar e abrir o Docker Desktop', body: ['Instale a edição do Docker Desktop apropriada ao seu Mac Intel ou Apple Silicon e aguarde o runtime iniciar.', 'Use os comandos no Terminal. As imagens padrão usam a plataforma detectada pelo Docker; não é necessário fixar linux/amd64 para o fluxo normal.'], commands: [checkDocker], links: [installationLinks[4]]},
      {id: 'download', title: 'Baixar o CRM', body: ['Clone o projeto ou extraia o ZIP do GitHub. Os próximos comandos precisam rodar dentro da pasta que contém docker-compose.yml.'], commands: [clonePosix], links: [installationLinks[1]]},
      {id: 'environment', title: 'Gerar .env com o usuário do Mac', body: ['Use um contêiner Node temporário; não é necessário instalar Node no macOS.', 'O UID/GID mantém o arquivo .env acessível ao seu usuário. Um arquivo existente não é sobrescrito. Abra-o em editor local para ajustes.'], commands: [generateEnv]},
      {id: 'start', title: 'Construir e iniciar o CRM', body: ['Aguarde a primeira construção e o healthcheck do web. Mantenha Docker Desktop aberto enquanto usar o sistema.', 'Para Ollama nativo no Mac, use OLLAMA_DOCKER_BASE_URL=http://host.docker.internal:11434 no .env. A etapa opcional abaixo descreve a alternativa Ollama em Docker.'], commands: [start]},
      accessStep(), optionalAiStep(), maintenanceStep(),
    ],
  },
];
export const installationTroubleshooting: {title: string; body: string[]; commands: InstallationCommand[]}[] = [
  {title: 'Docker indisponível ou permissão negada', body: ['Inicie o Docker Desktop ou o serviço Docker e confirme que seu usuário tem acesso autorizado ao daemon. Em TrueNAS, use os mecanismos suportados da própria instalação.', 'Não altere a ACL de diretórios do banco nem dê permissão pública ao socket Docker para contornar o erro.'], commands: [checkDocker]},
  {title: 'PowerShell bloqueou configure.ps1', body: ['Leia scripts/configure.ps1 antes de desbloquear um arquivo que você acabou de baixar. Os comandos abaixo valem para essa sessão do PowerShell e para esse arquivo; não mudam a política global.', 'Se uma política corporativa impedir a operação, siga as regras do computador em vez de tentar sobrepor uma política gerenciada.'], commands: [{label: 'Revisar e desbloquear somente o helper baixado', language: 'powershell', code: String.raw`Get-Content .\scripts\configure.ps1
Unblock-File .\scripts\configure.ps1
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
.\instalar.bat`}]},
  {title: 'A porta 3000 já está em uso', body: ['Edite PORT e APP_URL no .env para a mesma porta livre e recrie o web. Para TrueNAS ou rede local, mantenha o host/IP real em APP_URL.', 'O trecho abaixo é exemplo para uso no próprio computador e deve ser colocado no arquivo .env.'], commands: [{label: 'Exemplo de valores no .env', language: 'text', code: 'PORT=3001\nAPP_URL=http://localhost:3001'}, {label: 'Recriar serviços com a configuração atual', language: 'bash', code: 'docker compose up -d\ndocker compose ps'}]},
  {title: 'A instalação ainda não ficou saudável', body: ['Confirme que está na pasta correta e aguarde os serviços de dados. Examine os logs antes de repetir uma construção.', 'Revise qualquer informação sensível antes de compartilhar os logs. Não apague volumes como forma de diagnóstico.'], commands: [{label: 'Ver saúde e logs recentes', language: 'bash', code: 'docker compose ps\ndocker compose logs --tail=80 web worker'}]},
  {title: 'Ollama disponível, mas sem modelos', body: ['Servidor disponível não significa que um modelo esteja instalado. Execute a etapa opcional de download e confira ollama list.', 'Em redes restritas, o registro e os destinos reais de distribuição precisam estar liberados. Um erro403 de política deve ser resolvido na configuração da rede; não desative TLS nem troque a rota para contornar a restrição.'], commands: [{label: 'Conferir modelos do Ollama local no contêiner', language: 'bash', code: 'docker compose exec -e OLLAMA_HOST=http://127.0.0.1:11434 ollama ollama list'}]},
  {title: 'Quero atualizar ou restaurar uma instalação', body: ['Faça backup do banco e mantenha uma cópia protegida de .env e ENCRYPTION_KEY antes de atualizar. Os scripts backup.sh e restore.sh estão documentados no repositório.', 'A restauração substitui dados e deve ser ensaiada em ambiente separado. Preserve o mesmo projeto Compose e os volumes existentes.'], commands: []},
];
