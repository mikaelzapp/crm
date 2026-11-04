/** HTTP acceptance and security checks. Uses synthetic fixtures only; never sends to Meta. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { db } from '../src/lib/db';
import { eligibility } from '../src/lib/campaigns';

const base = process.env.TEST_BASE_URL || process.env.APP_URL || 'http://localhost:3000';
const origin = new URL(base).origin;
const tag = `api-${randomUUID()}`;
const testPhone = '+5511987654319';
const correctedPhone = '+5511987654327';
const suppressedPhone = '+5511987654335';
const fixturePhones = [testPhone,correctedPhone,suppressedPhone];
let adminCookie = '';
let agentCookie = '';
let agentId: string | undefined;
let contactId: string | undefined;
let companyId: string | undefined;
let connectionId: string | undefined;
let batchId: string | undefined;
const entityIds: string[] = [];

async function request(path: string, options: {method?:string;data?:unknown;cookie?:string;origin?:string|null;form?:FormData;headers?:Record<string,string>} = {}) {
  const headers: Record<string,string> = {...options.headers};
  if(options.cookie) headers.Cookie = options.cookie;
  if(options.origin !== null) headers.Origin = options.origin || origin;
  if(options.data !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${base}/api/${path}`, {method:options.method || 'GET',headers,body:options.form || (options.data === undefined ? undefined : JSON.stringify(options.data)),signal:AbortSignal.timeout(30000)});
}
async function expectStatus(response: Response, status: number, label: string) {
  assert.equal(response.status,status,`${label}: expected HTTP ${status}, got ${response.status}`);
}
function sessionCookie(response: Response) {
  const cookie = response.headers.get('set-cookie') || '';
  assert.ok(cookie.includes('HttpOnly'),'Session must be HttpOnly');
  assert.ok(cookie.includes('SameSite=Strict'),'Session must use SameSite=Strict');
  if(new URL(base).protocol==='https:')assert.ok(cookie.includes('Secure'));
  return cookie.split(';')[0];
}
function noToken(response: unknown, rawToken: string) {
  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes(rawToken),false,'Raw provider token leaked');
  assert.equal(serialized.includes('encryptedToken'),false,'Encrypted provider token leaked');
}
async function run() {
  assert.equal(process.env.WHATSAPP_MODE,'mock','API tests require explicit WHATSAPP_MODE=mock');
  assert.ok(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD,'ADMIN_EMAIL and ADMIN_PASSWORD required');
  assert.equal(await db.suppression.count({where:{phone:{in:fixturePhones}}}),0,'Synthetic fixture phone already suppressed; choose a different test fixture');
  assert.equal(await db.contact.count({where:{phone:{in:fixturePhones}}}),0,'Synthetic fixture phone already in use; do not modify existing records');
  try {
    await expectStatus(await request('health'),200,'Services health');
    await expectStatus(await request('contacts'),401,'Anonymous data access');
    await expectStatus(await request('auth/login',{method:'POST',origin:'https://untrusted.example',data:{email:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD}}),403,'Cross-origin login');
    await expectStatus(await request('auth/login',{method:'POST',origin:null,data:{email:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD}}),403,'Missing-origin login');
    await expectStatus(await request('auth/login',{method:'POST',data:{email:process.env.ADMIN_EMAIL,password:randomBytes(20).toString('hex')}}),401,'Wrong password');
    const login=await request('auth/login',{method:'POST',data:{email:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD}});
    await expectStatus(login,200,'Admin login');adminCookie=sessionCookie(login);
    const admin = await login.json();assert.equal(admin.user.role,'ADMIN');assert.equal('passwordHash' in admin.user,false);
    console.log('PASS HTTP auth: unauthenticated denial, CSRF origin checks, wrong-password denial, secure session cookie.');

    const agentPassword=randomBytes(24).toString('base64url');
    const agentResponse=await request('users',{method:'POST',cookie:adminCookie,data:{email:`${tag}@example.invalid`,name:'Atendente de teste HTTP',role:'AGENT',password:agentPassword}});
    await expectStatus(agentResponse,201,'Create test agent');agentId=(await agentResponse.json()).user.id;
    const agentLogin=await request('auth/login',{method:'POST',data:{email:`${tag}@example.invalid`,password:agentPassword}});
    await expectStatus(agentLogin,200,'Agent login');agentCookie=sessionCookie(agentLogin);
    const contactResponse=await request('contacts',{method:'POST',cookie:adminCookie,data:{companyName:`=SUM(1,1) ${tag}`,name:'Contato sintético HTTP',phone:testPhone,email:`${tag}@example.invalid`,messageDraft:'Rascunho original sintético',city:'Cidade teste',state:'SP',segment:'Testes',priority:'Alta'}});
    await expectStatus(contactResponse,201,'Create synthetic contact');const created=(await contactResponse.json()).contact;contactId=created.id;companyId=created.companyId;entityIds.push(created.id);
    for(const [path,method,data] of [
      ['settings','POST',{emergencyStop:true}],
      ['campaigns','POST',{}],
      [`contacts/${contactId}/consent`,'POST',{source:'fixture',purpose:'teste',evidence:'Consentimento de fixture sintética'}],
      [`contacts/${contactId}`,'DELETE',undefined],
      ['connections','POST',{}],
      ['audit','GET',undefined],
    ] as const) await expectStatus(await request(path,{method,cookie:agentCookie,data}),403,`Agent restricted ${path}`);
    await expectStatus(await request(`contacts/${contactId}/notes`,{method:'POST',cookie:agentCookie,data:{body:'Nota interna sintética de teste'}}),201,'Agent note access');
    console.log('PASS HTTP RBAC: agent cannot configure, campaign, consent, erase or audit; permitted note works.');

    const token=`synthetic-token-${randomBytes(24).toString('hex')}`;
    const connectionResponse=await request('connections',{method:'POST',cookie:adminCookie,data:{name:tag,phone:'+5511999999222',phoneNumberId:`mock-phone-${tag}`,wabaId:`mock-waba-${tag}`,mode:'MOCK',token}});
    await expectStatus(connectionResponse,201,'Create mock connection');const connectionBody=await connectionResponse.json();noToken(connectionBody,token);connectionId=connectionBody.connection.id;entityIds.push(connectionId!);const persistedToken=(await db.connection.findUniqueOrThrow({where:{id:connectionId}})).encryptedToken;assert.ok(persistedToken?.startsWith('v1.'));assert.notEqual(persistedToken,token);
    const sync=await request(`connections/${connectionId}/sync`,{method:'POST',cookie:adminCookie,data:{}});await expectStatus(sync,200,'Sync mock connection');noToken(await sync.json(),token);
    const list=await request('connections',{cookie:adminCookie});await expectStatus(list,200,'List connections');noToken(await list.json(),token);
    await expectStatus(await request('webhooks/meta',{method:'POST',data:{object:'whatsapp_business_account',entry:[]},origin:null}),403,'Unsigned webhook');
    await expectStatus(await request('webhooks/meta',{method:'POST',data:{object:'whatsapp_business_account',entry:[]},origin:null,headers:{'x-hub-signature-256':`sha256=${'0'.repeat(64)}`}}),403,'Invalidly signed webhook');
    await expectStatus(await request('webhooks/meta?hub.mode=subscribe&hub.verify_token=invalid&hub.challenge=123'),403,'Invalid webhook challenge');
    console.log('PASS HTTP connection secrecy: create/sync/list redact tokens; invalid webhook signatures and challenges rejected.');

    const csvPath=process.env.TEST_CSV_PATH || 'private/CONTATOS_FINAIS_30.csv';
    if(existsSync(csvPath)){
      const previewForm=new FormData();previewForm.append('file',new File([readFileSync(csvPath)],'CONTATOS_FINAIS_30.csv',{type:'text/csv'}));
      const preview=await request('imports/preview',{method:'POST',cookie:adminCookie,form:previewForm});await expectStatus(preview,200,'30-company CSV preview');const parsed=await preview.json();assert.equal(parsed.columns.length,37);assert.equal(parsed.rows.length,5);assert.equal(parsed.suggestedMapping.messageDraft,'Mensagem personalizada para WhatsApp');
    }else throw new Error('CSV fixture required for acceptance preview; set TEST_CSV_PATH.');
    const mappingForm=new FormData();mappingForm.append('file',new File(['Organização;Pessoa;Fone\nEmpresa sintética;Pessoa sintética;11987654319'],'mapping.csv',{type:'text/csv'}));mappingForm.append('mapping',JSON.stringify({companyName:'Organização',name:'Pessoa',phone:'Fone'}));
    const mappingPreview=await request('imports/preview',{method:'POST',cookie:adminCookie,form:mappingForm});await expectStatus(mappingPreview,200,'Manual CSV mapping preview');assert.equal((await mappingPreview.json()).suggestedMapping.companyName,'Organização');
    console.log('PASS HTTP CSV: uploaded BOM source exposes 37 columns / 5 preview rows; custom manual mapping preserved.');

    await expectStatus(await request(`contacts/${contactId}`,{method:'PATCH',cookie:agentCookie,data:{messageDraft:'Segunda versão sintética'}}),200,'Edit message draft');
    const detail=await request(`contacts/${contactId}`,{cookie:adminCookie});await expectStatus(detail,200,'Contact details');const detailBody=(await detail.json()).contact;
    assert.equal(detailBody.messageDraft,'Segunda versão sintética');assert.ok(detailBody.messageDraftVersions.some((v:{body:string})=>v.body==='Rascunho original sintético'));
    const consent=await request(`contacts/${contactId}/consent`,{method:'POST',cookie:adminCookie,data:{source:'Teste automatizado HTTP',purpose:'Teste de integração sem envio externo',evidence:'Autorização fictícia para contato sintético criado apenas por este teste.'}});await expectStatus(consent,201,'Synthetic opt-in');
    const sim=await request('test/inbound',{method:'POST',cookie:adminCookie,data:{connectionId,phone:testPhone,body:'Mensagem sintética para validar caixa de entrada'}});await expectStatus(sim,200,'Controlled inbound mock');
    const conversations=await db.conversation.findMany({where:{contactId}});assert.equal(conversations.length,1);assert.equal(conversations[0].connectionId,connectionId);
    console.log('PASS HTTP workflow: draft version history, documented synthetic consent, controlled mock inbox.');

    const csv=await request('export?format=csv',{cookie:adminCookie});await expectStatus(csv,200,'CSV export');const csvBuffer=Buffer.from(await csv.arrayBuffer());assert.deepEqual([...csvBuffer.subarray(0,3)],[239,187,191]);const csvText=csvBuffer.toString('utf8');assert.ok(csvText.includes(`"'=SUM(1,1) ${tag}"`),'Formula-bearing company must be escaped in CSV');assert.ok(csv.headers.get('content-disposition')?.includes('contatos.csv'));
    const xlsx=await request('export?format=xlsx',{cookie:adminCookie});await expectStatus(xlsx,200,'XLSX export');const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(await xlsx.arrayBuffer());const first=workbook.worksheets[0];assert.ok(first.rowCount>=2);let found=false;first.eachRow(row=>{if(row.getCell(1).value===`=SUM(1,1) ${tag}`){found=true;assert.equal(typeof row.getCell(1).value,'string');}});assert.ok(found,'Synthetic contact absent in XLSX');
    const reports=await request('reports',{cookie:adminCookie});await expectStatus(reports,200,'Reports');const report=await reports.json();assert.ok(Array.isArray(report.byNumber)&&Array.isArray(report.byCampaign));assert.ok(report.responseRate>=0&&report.responseRate<=100);
    console.log('PASS HTTP exports/reports: CSV BOM + formula neutralization, real XLSX readable, per-number and campaign summaries.');

    const phoneAgent=await db.aiAgent.create({data:{connectionId:connectionId!,name:'Fixture para impedir transferência de permissão IA',mode:'OFF'}});
    await db.aiConversationPermission.create({data:{conversationId:conversations[0].id,allowed:true,source:'Fixture do telefone anterior',purpose:'Processamento de teste local autorizado',evidence:'A autorização pertence somente ao número sintético anterior.',grantedAt:new Date()}});
    const phoneRun=await db.aiRun.create({data:{agentId:phoneAgent.id,conversationId:conversations[0].id,origin:'INCOMING',mode:'SUGGEST',input:'Conteúdo sintético do telefone anterior',output:'Resposta sintética do telefone anterior',reason:'Metadado pessoal anterior',error:'Erro pessoal anterior',status:'SUGGESTED',retainHistory:true}});
    const derivedContent='Trecho corrigido sintético pertencente ao número anterior';const derivedSource=await db.knowledgeSource.create({data:{agentId:phoneAgent.id,title:'Fixture de correção derivada do telefone anterior',type:'CORRECTION',content:derivedContent,contentHash:createHash('sha256').update(derivedContent).digest('hex'),approved:true,status:'READY'}});
    await db.knowledgeChunk.create({data:{sourceId:derivedSource.id,agentId:phoneAgent.id,position:0,content:derivedContent,embeddingModel:'fixture',dimensions:3,contentHash:derivedSource.contentHash}});
    await db.aiCorrection.create({data:{agentId:phoneAgent.id,runId:phoneRun.id,question:'Pergunta sintética anterior',originalAnswer:'Resposta original sintética',correctedAnswer:derivedContent,status:'APPROVED',sourceId:derivedSource.id}});
    await db.suppression.create({data:{phone:testPhone,reason:'Fixture: preservar bloqueio do telefone anterior'}});
    const correction=await request(`contacts/${contactId}`,{method:'PATCH',cookie:agentCookie,data:{phone:'(11) 98765-4327',company:{name:`Empresa corrigida ${tag}`,legalName:'Razão social de teste',city:'Outra cidade',state:'RJ',segment:'Serviços'}}});
    await expectStatus(correction,200,'Correct contact phone and company');
    const corrected=await db.contact.findUniqueOrThrow({where:{id:contactId},include:{company:true,consents:true,conversations:{include:{messages:true,aiPermission:true,aiRuns:true}}}});
    assert.equal(corrected.phone,correctedPhone);assert.equal(corrected.rawPhone,'(11) 98765-4327');assert.equal(corrected.stage,'PENDING_AUTHORIZATION');assert.equal(corrected.consents.filter(c=>!c.revokedAt).length,0);assert.equal((await eligibility(contactId!)).eligible,false);
    assert.equal(corrected.company.city,'Outra cidade');assert.equal(corrected.company.state,'RJ');assert.equal(corrected.conversations.length,1);assert.equal(corrected.conversations[0].lastInboundAt,null);assert.equal(corrected.conversations[0].messages.length,1);
    assert.equal(corrected.conversations[0].aiPaused,true);assert.equal(corrected.conversations[0].aiPermission?.allowed,false);assert.ok(corrected.conversations[0].aiPermission?.revokedAt);
    const clearedAiRun=corrected.conversations[0].aiRuns.find(run=>run.id===phoneRun.id)!;assert.equal(clearedAiRun.input,'');assert.equal(clearedAiRun.output,null);assert.deepEqual(clearedAiRun.sources,[]);assert.equal(clearedAiRun.error,null);assert.equal(clearedAiRun.status,'CANCELED');assert.equal(clearedAiRun.reason,'Conteúdo removido após alteração do telefone. Nova autorização de IA é necessária.');
    assert.equal(await db.aiCorrection.count({where:{runId:phoneRun.id}}),0);assert.equal(await db.knowledgeSource.count({where:{id:derivedSource.id}}),0);assert.equal(await db.knowledgeChunk.count({where:{sourceId:derivedSource.id}}),0);
    assert.ok(await db.suppression.findUnique({where:{phone:testPhone}}),'Old phone suppression must remain scoped to old number');
    const history=(corrected.originalData as Record<string,unknown>)._crmPhoneHistory as Array<{oldPhone:string;newPhone:string}>;assert.equal(history.at(-1)?.oldPhone,testPhone);assert.equal(history.at(-1)?.newPhone,correctedPhone);
    await expectStatus(await request(`contacts/${contactId}`,{method:'PATCH',cookie:agentCookie,data:{stage:'DO_NOT_CONTACT'}}),200,'Pipeline opt-out');assert.ok(await db.suppression.findUnique({where:{phone:correctedPhone}}));assert.equal((await db.contact.findUniqueOrThrow({where:{id:contactId}})).doNotContact,true);
    await expectStatus(await request(`contacts/${contactId}/consent`,{method:'POST',cookie:adminCookie,data:{source:'Fixture do número corrigido',purpose:'Teste sem envio externo',evidence:'Autorização sintética para verificar que não é transferida na próxima correção.'}}),201,'New synthetic number opt-in');
    assert.equal((await db.aiConversationPermission.findUniqueOrThrow({where:{conversationId:conversations[0].id}})).allowed,false,'New WhatsApp opt-in must not restore the previous AI permission');
    await db.suppression.create({data:{phone:suppressedPhone,reason:'Fixture: novo número já está excluído'}});
    const suppressedCorrection=await request(`contacts/${contactId}`,{method:'PATCH',cookie:agentCookie,data:{phone:suppressedPhone,doNotContact:false,stage:'ELIGIBLE'}});await expectStatus(suppressedCorrection,200,'Correct to globally suppressed phone');
    const blocked=(await suppressedCorrection.json()).contact;assert.equal(blocked.doNotContact,true);assert.equal(blocked.stage,'DO_NOT_CONTACT');assert.equal(await db.consent.count({where:{contactId,revokedAt:null}}),0);assert.equal((await eligibility(contactId!)).eligible,false);
    console.log('PASS HTTP phone correction: consent revoked, 24h window reset, old messages/provenance retained, company edited, global suppression cannot be bypassed.');

    const importBatch=await db.importBatch.create({data:{fileName:`${tag}.csv`,columns:['Empresa'],status:'COMPLETED',total:1,created:1,rows:{create:{rowNumber:2,contactId,originalData:{Empresa:'Fixture privada sintética',Email:`${tag}@example.invalid`}}}}});batchId=importBatch.id;
    await expectStatus(await request(`contacts/${contactId}`,{method:'DELETE',cookie:adminCookie}),200,'Privacy erasure');
    assert.equal(await db.contact.count({where:{id:contactId}}),0);assert.equal(await db.company.count({where:{id:companyId}}),0);assert.equal(await db.importRow.count({where:{importBatchId:batchId}}),0);assert.equal(await db.messageDraftVersion.count({where:{contactId}}),0);assert.equal(await db.consent.count({where:{contactId}}),0);assert.equal(await db.conversation.count({where:{contactId}}),0);assert.ok(await db.suppression.findUnique({where:{phone:suppressedPhone}}));
    console.log('PASS HTTP privacy: personal source import rows, versions, consent, conversations and empty company erased; suppression retained.');

    const logout=await request('auth/logout',{method:'POST',cookie:agentCookie,data:{}});await expectStatus(logout,200,'Agent logout');assert.ok(logout.headers.get('set-cookie')?.includes('Max-Age=0'));await expectStatus(await request('contacts',{cookie:agentCookie}),401,'Revoked session');
    console.log('PASS HTTP session revocation: logged-out cookie cannot access contacts.');
  }finally{
    if(adminCookie)await request('auth/logout',{method:'POST',cookie:adminCookie,data:{}}).catch(()=>{});
    if(companyId)await db.company.deleteMany({where:{id:companyId}});
    if(connectionId)await db.connection.deleteMany({where:{id:connectionId}});
    if(batchId)await db.importBatch.deleteMany({where:{id:batchId}});
    if(agentId)await db.user.deleteMany({where:{id:agentId}});
    await db.suppression.deleteMany({where:{phone:{in:fixturePhones}}});
    if(entityIds.length)await db.auditLog.deleteMany({where:{entityId:{in:entityIds}}});
    await db.$disconnect();
  }
}
run().catch(error=>{console.error(error instanceof Error?error.message:'HTTP integration test failed');process.exitCode=1;}).finally(()=>db.$disconnect());
