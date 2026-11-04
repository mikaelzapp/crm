import {test,expect,type Page,type APIRequestContext} from '@playwright/test';
import {mkdir} from 'node:fs/promises';

// Explicit opt-in: these tests require a running backend/worker with a configured
// Ollama service. Default model names identify the HTTP fixture, not real weights.
test.skip(process.env.RUN_AI_BROWSER_TESTS!=='1','IA opcional: habilite RUN_AI_BROWSER_TESTS=1 e configure o provider de teste.');
test.setTimeout(120000);
test.use({actionTimeout:15000});
const chatModel=process.env.AI_BROWSER_MODEL||'fixture-chat:latest';
const embedModel=process.env.AI_BROWSER_EMBEDDING_MODEL||'fixture-embed:latest';
const providerLabel=chatModel.startsWith('fixture-')?'Ollama SIMULADO':'Ollama configurado';
const errors=new WeakMap<Page,string[]>();
test.beforeEach(async({page})=>{
  const captured:string[]=[];errors.set(page,captured);
  page.on('pageerror',error=>captured.push(error.message));
  page.on('console',message=>{if(message.type()==='error')captured.push(message.text());});
});
test.afterEach(async({page})=>{expect(errors.get(page)||[]).toEqual([]);});
async function login(page:Page){
  if(!process.env.ADMIN_EMAIL||!process.env.ADMIN_PASSWORD)throw new Error('Credenciais locais do administrador necessárias ao teste.');
  await page.goto('/');await page.getByLabel('E-mail',{exact:true}).fill(process.env.ADMIN_EMAIL);await page.getByLabel('Senha',{exact:true}).fill(process.env.ADMIN_PASSWORD);await page.getByRole('button',{name:'Entrar no CRM'}).click();await expect(page.getByRole('heading',{name:/Visão geral/})).toBeVisible();
  const status=await(await page.request.get('/api/ai/status')).json();
  expect(status.available,'Provider Ollama precisa estar disponível; não há fallback simulado de produção.').toBe(true);
  expect(status.models.map((model:any)=>model.name)).toEqual(expect.arrayContaining([chatModel,embedModel]));
}
async function nav(page:Page,name:string){await page.getByRole('navigation',{name:'Navegação principal'}).getByRole('button',{name:new RegExp(`^${name}(?: \\d+)?$`)}).click();}
async function connection(request:APIRequestContext,origin:string,suffix:string){
  const response=await request.post('/api/connections',{headers:{Origin:origin},data:{name:`TESTE IA navegador ${suffix}`,phone:`+551195${suffix.replace(/\D/g,'').slice(-7).padStart(7,'0')}`,wabaId:`mock-ai-${suffix}`,phoneNumberId:`mock-ai-${suffix}`,mode:'MOCK',ratePerMinute:30}});
  expect(response.status()).toBe(201);return(await response.json()).connection;
}
async function createAgentUi(page:Page,connectionId:string,name:string){
  await page.getByRole('button',{name:'Novo agente',exact:true}).click();
  const form=page.locator('form').filter({has:page.getByRole('button',{name:'Criar agente desligado',exact:true})});
  await form.getByLabel('Nome do agente',{exact:true}).fill(name);await form.getByRole('combobox',{name:'Número de WhatsApp',exact:true}).selectOption(connectionId);
  const response=page.waitForResponse(r=>r.url().endsWith('/api/ai/agents')&&r.request().method()==='POST');
  await form.getByRole('button',{name:'Criar agente desligado',exact:true}).click();
  const result=await response;expect(result.status()).toBe(201);const agent=(await result.json()).agent;expect(agent.mode).toBe('OFF');
  await expect(form).not.toBeVisible();
  await expect(page.getByLabel('Nome do agente',{exact:true})).toHaveValue(name);return agent;
}
async function configureAgent(page:Page,id:string,instructions:string,retain:boolean){
  await page.getByRole('tab',{name:'Configuração',exact:true}).click();
  await page.getByLabel('Modelo de conversa instalado').selectOption(chatModel);await page.getByLabel('Modelo de embeddings').selectOption(embedModel);await page.getByLabel('Instruções do agente').fill(instructions);
  await page.getByRole('checkbox',{name:/Reter histórico para contexto do agente/}).setChecked(retain);
  const response=page.waitForResponse(r=>r.url().endsWith(`/api/ai/agents/${id}`)&&r.request().method()==='PATCH');await page.getByRole('button',{name:'Salvar configuração',exact:true}).click();expect((await response).status()).toBe(200);
  await expect(page.getByRole('status').filter({hasText:'Configuração salva.'})).toBeVisible();
}
async function readySource(request:APIRequestContext,agentId:string,sourceId:string){
  await expect.poll(async()=>{const result=await(await request.get(`/api/ai/agents/${agentId}/knowledge`)).json();return result.sources.find((source:any)=>source.id===sourceId)?.status;},{timeout:45000,intervals:[500,1000,1500]}).toBe('READY');
}
function smallPdf(text:string){
  const escaped=text.replaceAll('\\','\\\\').replaceAll('(','\\(').replaceAll(')','\\)');const stream=`BT /F1 12 Tf 50 750 Td (${escaped}) Tj ET`;
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let body='%PDF-1.4\n';const offsets=[0];for(let index=0;index<objects.length;index++){offsets.push(Buffer.byteLength(body));body+=`${index+1} 0 obj\n${objects[index]}\nendobj\n`;}
  const xref=Buffer.byteLength(body);body+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(body);
}

test(`IA com ${providerLabel}: dois agentes, privacidade, PDF, RAG e correção aprovada`,async({page,baseURL},testInfo)=>{
  const origin=new URL(baseURL!).origin,suffix=Date.now().toString();const owned:string[]=[];
  await login(page);
  try{
    const first=await connection(page.request,origin,suffix+'1');owned.push(first.id);const second=await connection(page.request,origin,suffix+'2');owned.push(second.id);
    await nav(page,'Treinamento da IA');await expect(page.getByText('Servidor disponível',{exact:true})).toBeVisible();
    const firstName=`Agente IA teste A ${suffix}`,secondName=`Agente IA teste B ${suffix}`;
    const agent=await createAgentUi(page,first.id,firstName);const instructions='Atenda somente sobre consultas aprovadas. Não invente preços.';
    await configureAgent(page,agent.id,instructions,true);
    const other=await createAgentUi(page,second.id,secondName);await configureAgent(page,other.id,'Agente independente B: escopo de teste separado.',false);
    await page.locator('.ai-agent-card').filter({hasText:firstName}).click();
    await expect(page.getByLabel('Instruções do agente')).toHaveValue(instructions);await expect(page.getByRole('checkbox',{name:/Reter histórico para contexto do agente/})).toBeChecked();
    await configureAgent(page,agent.id,instructions,false);
    await page.reload();await expect(page.getByRole('heading',{name:/Visão geral/})).toBeVisible();await nav(page,'Treinamento da IA');await page.locator('.ai-agent-card').filter({hasText:firstName}).click();await expect(page.getByRole('checkbox',{name:/Reter histórico para contexto do agente/})).not.toBeChecked();
    await expect(page.getByLabel('Modelo de conversa instalado')).toHaveValue(chatModel);
    await page.getByRole('tab',{name:'Conhecimento',exact:true}).click();await page.getByRole('button',{name:'Documento',exact:true}).click();
    const title=`PDF comercial sintético ${suffix}`;await page.getByLabel('Título da referência').fill(title);await page.getByLabel('Documento (PDF, TXT ou DOCX)').setInputFiles({name:'consulta-sintetica.pdf',mimeType:'application/pdf',buffer:smallPdf('Consulta empresarial custa R$ 150 por atendimento. Atendimento de segunda a sexta.')});
    const upload=page.waitForResponse(r=>r.url().endsWith(`/api/ai/agents/${agent.id}/knowledge`)&&r.request().method()==='POST');await page.getByRole('button',{name:'Adicionar à base',exact:true}).click();const uploaded=await upload;expect(uploaded.status()).toBe(201);const source=(await uploaded.json()).source;expect(source.type).toBe('PDF');await readySource(page.request,agent.id,source.id);await expect(page.locator('.ai-source-item').filter({hasText:title})).toContainText('Indexado');
    const secondSources=await(await page.request.get(`/api/ai/agents/${other.id}/knowledge`)).json();expect(secondSources.sources).toHaveLength(0);
    await page.getByRole('tab',{name:'Testar conversa',exact:true}).click();await page.getByRole('textbox',{name:'Mensagem de teste para IA'}).fill('Qual o preço da consulta empresarial?');const submitted=page.waitForResponse(r=>r.url().endsWith(`/api/ai/agents/${agent.id}/test`)&&r.request().method()==='POST');await page.getByRole('button',{name:'Testar',exact:true}).click();const queued=await submitted;expect(queued.status()).toBe(202);const runId=(await queued.json()).run.id;
    await expect.poll(async()=>{const result=await(await page.request.get(`/api/ai/runs/${runId}`)).json();return result.run.status;},{timeout:45000,intervals:[500,1000]}).toBe('COMPLETED');
    const run=(await(await page.request.get(`/api/ai/runs/${runId}`)).json()).run;expect(run.output).toContain('150');expect(run.sources.some((item:any)=>item.sourceId===source.id)).toBe(true);expect(run.retainHistory).toBe(false);expect(run.expiresAt).toBeTruthy();if(chatModel.startsWith('fixture-'))expect(run.output).toContain('SIMULAÇÃO OLLAMA');
    await expect(page.locator('.ai-answer-text').filter({hasText:'150'})).toBeVisible();await page.getByRole('button',{name:'Corrigir resposta',exact:true}).click();const corrected='Consulta empresarial custa R$ 180 por atendimento, conforme política comercial sintética revisada.';await page.getByLabel('Resposta corrigida').fill(corrected);const correctionResponse=page.waitForResponse(r=>r.url().endsWith(`/api/ai/runs/${runId}/corrections`)&&r.request().method()==='POST');await page.getByRole('button',{name:'Registrar para revisão',exact:true}).click();const correctionCreated=await correctionResponse;expect(correctionCreated.status()).toBe(201);const correction=(await correctionCreated.json()).correction;
    await page.getByRole('tab',{name:/^Correções/}).click();const correctionCard=page.locator('.ai-correction-card').filter({hasText:corrected});await expect(correctionCard).toContainText('Aguardando aprovação');page.once('dialog',dialog=>dialog.accept());const approved=page.waitForResponse(r=>r.url().endsWith(`/api/ai/corrections/${correction.id}/approve`)&&r.request().method()==='POST');await correctionCard.getByRole('button',{name:'Aprovar como referência'}).click();const approval=await approved;expect(approval.status()).toBe(201);const approvedData=await approval.json();await readySource(page.request,agent.id,approvedData.source.id);await expect(correctionCard).toContainText('Aprovada');
    await mkdir('private',{recursive:true});await page.screenshot({path:'private/browser-ai-training.png',fullPage:true});
  }finally{testInfo.setTimeout(testInfo.timeout+15000);await nav(page,'Visão geral');for(const id of owned.reverse())expect((await page.request.delete(`/api/connections/${id}`,{headers:{Origin:origin}})).ok()).toBe(true);}
});

test(`Caixa de entrada com ${providerLabel}: autorização específica, sugestão e revogação`,async({page,baseURL},testInfo)=>{
  const origin=new URL(baseURL!).origin,headers={Origin:origin},suffix=Date.now().toString();let connectionId:string|undefined,contactId:string|undefined;
  await login(page);
  try{
    const channel=await connection(page.request,origin,suffix+'3');connectionId=channel.id;
    const created=await page.request.post('/api/ai/agents',{headers,data:{connectionId,name:`Agente privacidade teste ${suffix}`,model:chatModel,embeddingModel:embedModel}});expect(created.status()).toBe(201);const agent=(await created.json()).agent;
    expect((await page.request.patch(`/api/ai/agents/${agent.id}`,{headers,data:{mode:'SUGGEST',retainHistory:true}})).ok()).toBe(true);
    const knowledge=await page.request.post(`/api/ai/agents/${agent.id}/knowledge`,{headers,data:{title:`Tabela sintética ${suffix}`,text:'Consulta empresarial custa R$ 150 por atendimento.'}});expect(knowledge.status()).toBe(201);await readySource(page.request,agent.id,(await knowledge.json()).source.id);
    const phone=`+551194${suffix.slice(-7)}`,companyName=`TESTE IA privacidade ${suffix}`;
    const contact=await page.request.post('/api/contacts',{headers,data:{companyName,name:'Pessoa sintética IA',phone}});expect(contact.status()).toBe(201);contactId=(await contact.json()).contact.id;
    const consent=await page.request.post(`/api/contacts/${contactId}/consent`,{headers,data:{source:'Fixture sintética de navegador MOCK',purpose:'Validar sugestão sem envio externo',evidence:'Registro fictício exclusivo de teste. Não pertence a pessoa real ou ao CSV.'}});expect(consent.status()).toBe(201);
    const inbound=await page.request.post('/api/test/inbound',{headers,data:{connectionId,phone,body:'Qual o preço da consulta empresarial?'}});expect(inbound.status()).toBe(200);
    let conversation:any;await expect.poll(async()=>{const result=await(await page.request.get('/api/conversations')).json();conversation=result.conversations.find((item:any)=>item.connectionId===connectionId&&item.contactId===contactId);return Boolean(conversation);}).toBe(true);
    await nav(page,'Caixa de entrada');await page.locator('.conversation-item').filter({hasText:companyName}).click();await page.getByText('Assistente de IA',{exact:true}).click();
    const panel=page.locator('.ai-inbox-panel');await expect(panel).toContainText('Processamento de IA ainda não autorizado');await expect(panel.locator('.ai-answer-text')).toHaveCount(0);
    await panel.getByRole('button',{name:'Registrar autorização de IA',exact:true}).click();await panel.getByLabel('Origem da autorização de IA').fill('Teste sintético de privacidade');await panel.getByLabel('Finalidade autorizada para IA').fill('Assistência de teste nesta conversa MOCK');await panel.getByLabel('Evidência da autorização de IA').fill('Autorização fictícia da fixture sintética, exclusivamente para validação automatizada, incluindo retenção e uso do histórico.');const historyEvidence=panel.getByRole('checkbox',{name:/A evidência registrada também autoriza/});if(await historyEvidence.count())await historyEvidence.check();await panel.getByRole('button',{name:'Registrar autorização',exact:true}).click();await expect(panel).toContainText('Processamento de IA autorizado para esta conversa.');
    const resume=panel.getByRole('button',{name:'Retomar agente nesta conversa'});if(await resume.isVisible()){const resumed=page.waitForResponse(response=>response.url().endsWith(`/api/ai/conversations/${conversation.id}`)&&response.request().method()==='PATCH');await resume.click();expect((await resumed).status()).toBe(200);await expect(panel.getByRole('button',{name:'Encaminhar para pessoa'})).toBeVisible();}
    const next=await page.request.post('/api/test/inbound',{headers,data:{connectionId,phone,body:'Qual o valor da consulta empresarial?'}});expect(next.status()).toBe(200);
    let run:any;await expect.poll(async()=>{const current=await(await page.request.get(`/api/ai/conversations/${conversation.id}`)).json();run=current.runs.find((item:any)=>item.status==='SUGGESTED');return Boolean(run);},{timeout:45000,intervals:[500,1000]}).toBe(true);
    await panel.getByRole('button',{name:'Atualizar sugestões da IA'}).click();await expect(panel.locator('.ai-answer-text').filter({hasText:'150'})).toBeVisible();await expect(panel.getByRole('button',{name:'Revisar e enviar sugestão'})).toBeVisible();
    const messages=(await(await page.request.get(`/api/conversations/${conversation.id}`)).json()).conversation.messages;expect(messages.filter((message:any)=>message.direction==='OUTBOUND')).toHaveLength(0);
    page.once('dialog',dialog=>dialog.accept());await panel.getByRole('button',{name:'Revogar permissão e histórico'}).click();await expect(panel).toContainText('Processamento de IA ainda não autorizado');await expect(panel.locator('.ai-answer-text')).toHaveCount(0);
    const cleared=(await(await page.request.get(`/api/ai/runs/${run.id}`)).json()).run;expect(cleared.input).toBe('');expect(cleared.output).toBeNull();
    const retainedContact=(await(await page.request.get(`/api/contacts/${contactId}`)).json()).contact;expect(retainedContact.consents.filter((entry:any)=>!entry.revokedAt)).toHaveLength(1);
  }finally{testInfo.setTimeout(testInfo.timeout+15000);await nav(page,'Visão geral');if(connectionId)expect((await page.request.delete(`/api/connections/${connectionId}`,{headers})).ok()).toBe(true);if(contactId)expect((await page.request.delete(`/api/contacts/${contactId}`,{headers})).ok()).toBe(true);}
});
