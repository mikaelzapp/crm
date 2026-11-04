import {test, expect, type Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';

const browserErrors=new WeakMap<Page,string[]>();
test.beforeEach(async({page})=>{
  const errors:string[]=[];
  browserErrors.set(page,errors);
  page.on('pageerror',error=>errors.push(`pageerror: ${error.message}`));
  page.on('console',message=>{
    if(message.type()!=='error')return;
    const source=message.location().url;
    const expectedConsentBlock=/\/api\/conversations\/[^/]+\/messages(?:\?|$)/.test(source)&&/status of 400/.test(message.text());
    if(!expectedConsentBlock)errors.push(`console: ${message.text()}`);
  });
});
test.afterEach(async({page})=>{expect(browserErrors.get(page)||[]).toEqual([]);});

// These acceptance tests use the running app and real PostgreSQL/Redis services.
// Only synthetic contacts are edited; no consent is invented for the imported CSV.
async function login(page:Page) {
  const email=process.env.ADMIN_EMAIL, password=process.env.ADMIN_PASSWORD;
  if(!email||!password) throw new Error('ADMIN_EMAIL e ADMIN_PASSWORD precisam estar configuradas para o teste de navegador.');
  await page.goto('/');
  await page.getByLabel('E-mail',{exact:true}).fill(email);
  await page.getByLabel('Senha',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Entrar no CRM'}).click();
  await expect(page.getByRole('heading',{name:/Visão geral/})).toBeVisible();
  await expect(page.getByText('Preparando seu espaço de trabalho…')).toHaveCount(0);
}
async function nav(page:Page,name:string) {
  await page.getByRole('navigation',{name:'Navegação principal'}).getByRole('button',{name:new RegExp(`^${name}(?: \\d+)?$`)}).click();
}

test('CRM desktop: base importada, busca, rascunhos persistidos, múltiplos números e bloqueio sem opt-in',async({page,baseURL})=>{
  const errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  await login(page);
  await expect.poll(async()=>{
    const r=await page.request.get('/api/dashboard');
    const data=await r.json();return Number(data.companies);
  }).toBeGreaterThanOrEqual(30);
  await expect(page.locator('.stat-card').filter({hasText:'Empresas na base'}).locator('.stat-value')).not.toHaveText('0');
  await mkdir('private',{recursive:true});
  await page.screenshot({path:'private/browser-dashboard.png',fullPage:true});

  await page.getByRole('button',{name:'Alternar tema'}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await expect(page.getByRole('heading',{name:/Visão geral/})).toBeVisible();
  await page.getByRole('button',{name:'Alternar tema'}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');

  await nav(page,'Contatos');
  await expect(page.getByRole('heading',{name:/^Contatos/})).toBeVisible();
  await expect.poll(async()=>await page.locator('tbody tr').count()).toBeGreaterThanOrEqual(30);
  const imported=await (await page.request.get('/api/contacts')).json();
  const importedName=imported.contacts[0].company.name;
  await page.getByRole('textbox',{name:'Buscar contatos'}).fill(importedName);
  await expect(page.locator('tbody tr').first()).toContainText(importedName);
  await expect.poll(async()=>await page.locator('tbody tr').count()).toBeLessThanOrEqual(imported.contacts.length);
  await page.getByRole('textbox',{name:'Buscar contatos'}).fill('');

  const unique=`TESTE Navegador ${Date.now()}`;
  const phone=`+551198${Date.now().toString().slice(-7)}`;
  let contactId:string|undefined;
  try {
    await page.getByRole('button',{name:'Novo contato',exact:true}).click();
    const newContact=page.getByRole('dialog',{name:'Novo contato'});
    await newContact.getByLabel('Empresa',{exact:true}).fill(unique);
    await newContact.getByLabel('Nome do contato',{exact:true}).fill('Pessoa sintética');
    await newContact.getByLabel('Telefone brasileiro',{exact:true}).fill(phone);
    const created=page.waitForResponse(r=>r.url().endsWith('/api/contacts')&&r.request().method()==='POST');
    await newContact.getByRole('button',{name:'Cadastrar contato'}).click();
    const createdData=await (await created).json();
    contactId=createdData.contact?.id||createdData.id;
    if(!contactId) {
      const found=await (await page.request.get(`/api/contacts?q=${encodeURIComponent(unique)}`)).json();
      contactId=found.contacts?.[0]?.id;
    }
    expect(contactId).toBeTruthy();
    await expect(newContact).not.toBeVisible();
    await page.getByRole('textbox',{name:'Buscar contatos'}).fill(unique);
    const row=page.locator('tbody tr').filter({hasText:unique});
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Pendente');
    await row.getByRole('button',{name:`Abrir ${unique}`}).click();
    let dialog=page.getByRole('dialog',{name:unique});
    await expect(dialog).toBeVisible();
    const firstDraft='Primeira versão sintética para aceitação no navegador.';
    const finalDraft='Segunda versão sintética persistida; não enviar.';
    await dialog.getByLabel('Mensagem personalizada · rascunho').fill(firstDraft);
    const saved1=page.waitForResponse(r=>r.url().endsWith(`/api/contacts/${contactId}`)&&r.request().method()==='PATCH');
    await dialog.getByRole('button',{name:'Salvar rascunho'}).click();
    expect((await saved1).ok()).toBeTruthy();
    await expect(page.getByRole('alert').filter({hasText:'Rascunho atualizado.'}).first()).toBeVisible();
    await dialog.getByLabel('Mensagem personalizada · rascunho').fill(finalDraft);
    const saved2=page.waitForResponse(r=>r.url().endsWith(`/api/contacts/${contactId}`)&&r.request().method()==='PATCH');
    await dialog.getByRole('button',{name:'Salvar rascunho'}).click();
    expect((await saved2).ok()).toBeTruthy();
    await dialog.getByRole('button',{name:'Fechar',exact:true}).click();
    await page.reload();
    await expect(page.getByRole('heading',{name:/Visão geral/})).toBeVisible();
    await nav(page,'Contatos');
    await page.getByRole('textbox',{name:'Buscar contatos'}).fill(unique);
    await page.getByRole('button',{name:`Abrir ${unique}`}).click();
    dialog=page.getByRole('dialog',{name:unique});
    await expect(dialog.getByLabel('Mensagem personalizada · rascunho')).toHaveValue(finalDraft);
    await dialog.getByText('Histórico de versões da mensagem',{exact:true}).click();
    await expect(dialog.getByText(firstDraft,{exact:true})).toBeVisible();
    await dialog.getByRole('button',{name:'Fechar',exact:true}).click();

    await nav(page,'WhatsApps conectados');
    await expect(page.getByRole('heading',{name:'WhatsApps conectados',exact:true})).toBeVisible();
    await expect.poll(async()=>await page.locator('.connection-card').filter({hasText:'Simulado'}).count()).toBeGreaterThanOrEqual(2);
    await page.getByRole('button',{name:'Testar recebimento'}).first().click();
    const inbound=page.getByRole('dialog',{name:'Simular mensagem recebida'});
    await inbound.getByLabel('Telefone do remetente').fill(phone);
    const inboundText='Mensagem recebida de teste E2E, sem autorização de campanha.';
    await inbound.getByLabel('Mensagem de teste').fill(inboundText);
    await inbound.getByRole('button',{name:'Simular recebimento'}).click();
    await expect(inbound).not.toBeVisible();
    await expect(page.getByRole('heading',{name:'Caixa de entrada',exact:true})).toBeVisible();
    await page.locator('.conversation-item').filter({hasText:unique}).click();
    await expect(page.locator('.messages').getByText(inboundText,{exact:true})).toBeVisible();
    await page.getByRole('textbox',{name:'Mensagem',exact:true}).fill('Esta resposta deve ser bloqueada por ausência de consentimento.');
    const blocked=page.waitForResponse(r=>r.url().includes('/messages')&&r.request().method()==='POST');
    await page.getByRole('button',{name:'Enviar',exact:true}).click();
    expect((await blocked).status()).toBe(400);
    await expect(page.getByRole('alert').filter({hasText:/Consentimento documentado não encontrado/})).toBeVisible();
    await expect(page.locator('.messages .outbound')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    if(contactId) {
      const origin=new URL(baseURL!).origin;
      const deleted=await page.request.delete(`/api/contacts/${contactId}`,{headers:{Origin:origin}});
      expect(deleted.ok()).toBeTruthy();
    }
  }
});

test('CRM mobile: login, menu responsivo e navegação sem transbordar viewport',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await login(page);
  await expect(page.getByRole('button',{name:'Abrir menu',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Abrir menu',exact:true}).click();
  await nav(page,'Contatos');
  await expect(page.getByRole('heading',{name:/^Contatos/})).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Buscar contatos'})).toBeVisible();
  const widths=await page.evaluate(()=>({doc:document.documentElement.scrollWidth,viewport:window.innerWidth}));
  expect(widths.doc).toBeLessThanOrEqual(widths.viewport+1);
  await mkdir('private',{recursive:true});
  await page.screenshot({path:'private/browser-mobile.png',fullPage:true});
});

test('Configuração MOCK pela interface e criação de campanha em rascunho sem agendamento',async({page,baseURL})=>{
  await login(page);
  const suffix=Date.now().toString();
  const connectionName=`TESTE E2E conexão ${suffix}`;
  const companyName=`TESTE E2E campanha ${suffix}`;
  const campaignName=`TESTE E2E rascunho ${suffix}`;
  const origin=new URL(baseURL!).origin;
  const headers={Origin:origin};
  let connectionId:string|undefined,contactId:string|undefined,campaignId:string|undefined;
  try {
    await nav(page,'WhatsApps conectados');
    await page.getByRole('button',{name:'Adicionar conexão',exact:true}).click();
    const connectionDialog=page.getByRole('dialog',{name:'Adicionar conexão WhatsApp'});
    await connectionDialog.getByLabel('Tipo de conexão').selectOption('MOCK');
    await connectionDialog.getByLabel('Nome identificador').fill(connectionName);
    await connectionDialog.getByLabel('Número de telefone',{exact:true}).fill(`+551197${suffix.slice(-7)}`);
    await connectionDialog.getByLabel('WhatsApp Business Account ID',{exact:true}).fill(`mock-waba-e2e-${suffix}`);
    await connectionDialog.getByLabel('Phone Number ID',{exact:true}).fill(`mock-number-e2e-${suffix}`);
    // Blank token is intentional: mock connections must not require credentials.
    const connectionResponse=page.waitForResponse(r=>r.url().endsWith('/api/connections')&&r.request().method()==='POST');
    await connectionDialog.getByRole('button',{name:'Adicionar conexão',exact:true}).click();
    const createdConnection=await connectionResponse;
    expect(createdConnection.status()).toBe(201);
    connectionId=(await createdConnection.json()).connection.id;
    await expect(connectionDialog).not.toBeVisible();
    await expect(page.locator('.connection-card').filter({hasText:connectionName})).toContainText('Simulado');

    await nav(page,'Modelos de mensagem');
    await page.getByRole('button',{name:'Modelo de teste',exact:true}).click();
    const templateDialog=page.getByRole('dialog',{name:'Criar modelo simulado'});
    await templateDialog.getByLabel('Conexão simulada').selectOption(connectionId!);
    await templateDialog.getByLabel('Nome do modelo').fill(`e2e_boas_vindas_${suffix}`);
    await templateDialog.getByLabel('Variáveis, separadas por vírgula').fill('socio,empresa');
    const templateResponse=page.waitForResponse(r=>r.url().endsWith('/api/templates')&&r.request().method()==='POST');
    await templateDialog.getByRole('button',{name:'Criar modelo de teste',exact:true}).click();
    const createdTemplate=await templateResponse;
    expect(createdTemplate.status()).toBe(201);
    const templateId=(await createdTemplate.json()).template.id;
    await expect(templateDialog).not.toBeVisible();

    // This opt-in is a mock-only test fixture, never a consent for an uploaded person.
    const contactResponse=await page.request.post('/api/contacts',{headers,data:{companyName,name:'Pessoa sintética E2E',phone:`+551196${suffix.slice(-7)}`}});
    expect(contactResponse.status()).toBe(201);
    contactId=(await contactResponse.json()).contact.id;
    const consentResponse=await page.request.post(`/api/contacts/${contactId}/consent`,{headers,data:{source:'Teste automatizado local MOCK',purpose:'Validar rascunho sintético de campanha',evidence:'Contato e prova fictícios, gerados exclusivamente para teste MOCK; não pertencem ao CSV do usuário.'}});
    expect(consentResponse.status()).toBe(201);
    await page.getByRole('button',{name:'Atualizar dados',exact:true}).click();
    await nav(page,'Campanhas');
    await page.getByRole('button',{name:'Nova campanha',exact:true}).click();
    const campaignDialog=page.getByRole('dialog',{name:'Nova campanha autorizada'});
    await campaignDialog.getByLabel('Nome da campanha').fill(campaignName);
    await campaignDialog.getByLabel('Número de origem').selectOption(connectionId!);
    await campaignDialog.getByLabel('Modelo aprovado').selectOption(templateId);
    await expect(campaignDialog.getByLabel('Parâmetro 1 · socio')).toHaveValue('{{socio}}');
    await expect(campaignDialog.getByLabel('Parâmetro 2 · empresa')).toHaveValue('{{empresa}}');
    await campaignDialog.getByRole('checkbox',{name:new RegExp(companyName)}).check();
    // Leave Agendamento empty: API requires this field to be omitted, not null.
    const campaignResponse=page.waitForResponse(r=>r.url().endsWith('/api/campaigns')&&r.request().method()==='POST');
    await campaignDialog.getByRole('button',{name:'Criar rascunho',exact:true}).click();
    const createdCampaign=await campaignResponse;
    expect(createdCampaign.status()).toBe(201);
    const saved=(await createdCampaign.json()).campaign;
    campaignId=saved.id;
    expect(saved.status).toBe('DRAFT');
    expect(saved.scheduledAt).toBeNull();
    await expect(campaignDialog).not.toBeVisible();
    await expect(page.locator('.campaign-card').filter({hasText:campaignName})).toContainText('Rascunho');
  } finally {
    // Delete only this exact unstarted synthetic campaign. Production API deliberately
    // preserves campaign history, so the acceptance fixture uses its isolated IDs.
    if(campaignId) {
      const {Client}=await import('pg');
      const client=new Client({connectionString:process.env.DATABASE_URL});
      await client.connect();
      try {
        const sent=await client.query('SELECT count(*)::int AS total FROM "Message" m JOIN "Conversation" c ON c.id=m."conversationId" WHERE c."contactId"=$1 AND m.direction=$2',[contactId,'OUTBOUND']);
        expect(sent.rows[0].total).toBe(0);
        await client.query('DELETE FROM "Campaign" WHERE id=$1 AND name=$2 AND status=$3',[campaignId,campaignName,'DRAFT']);
      }finally{await client.end();}
    }
    if(connectionId) expect((await page.request.delete(`/api/connections/${connectionId}`,{headers})).ok()).toBeTruthy();
    if(contactId) expect((await page.request.delete(`/api/contacts/${contactId}`,{headers})).ok()).toBeTruthy();
  }
});
