/** AI management HTTP acceptance tests against a local Ollama fixture; never calls Meta. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import { db } from '../src/lib/db';

const base=process.env.TEST_BASE_URL||process.env.APP_URL||'http://localhost:3000';
const origin=new URL(base).origin;
const tag=`ai-http-${randomUUID()}`;
const contactPhone='+5511999999567';
const chatModel=process.env.TEST_CHAT_MODEL||'fixture-chat:latest';
const embeddingModel=process.env.TEST_EMBEDDING_MODEL||'fixture-embed:latest';
let cookie='';let agentCookie='';let userId:string|undefined;let connectionId:string|undefined;let agentId:string|undefined;let companyId:string|undefined;
const entityIds:string[]=[];
async function req(path:string,method='GET',data?:unknown,auth=cookie,form?:FormData){const headers:Record<string,string>={Origin:origin};if(auth)headers.Cookie=auth;if(data!==undefined)headers['Content-Type']='application/json';return fetch(`${base}/api/${path}`,{method,headers,body:form||(data===undefined?undefined:JSON.stringify(data)),signal:AbortSignal.timeout(30000)});}
async function status(response:Response,expected:number,label:string){assert.equal(response.status,expected,`${label}: expected HTTP${expected}, received HTTP${response.status}`);}
async function pollSource(id:string){const until=Date.now()+30000;while(Date.now()<until){const source=await db.knowledgeSource.findUniqueOrThrow({where:{id}});if(source.status==='READY')return source;if(source.status==='FAILED')throw new Error(`Source indexing failed: ${source.error}`);await new Promise(r=>setTimeout(r,200));}throw new Error('Knowledge source did not finish indexing');}
async function pollRun(id:string){const until=Date.now()+30000;while(Date.now()<until){const response=await req(`ai/runs/${id}`);await status(response,200,'Poll AI run');const run=(await response.json()).run;if(!['QUEUED','PROCESSING'].includes(run.status))return run;await new Promise(r=>setTimeout(r,200));}throw new Error('AI run did not finish');}
async function main(){
  assert.equal(process.env.WHATSAPP_MODE,'mock','Requires explicit mock mode');assert.ok(process.env.ADMIN_EMAIL&&process.env.ADMIN_PASSWORD);assert.equal(await db.contact.count({where:{phone:contactPhone}}),0,'Synthetic phone already in use');assert.equal(await db.suppression.count({where:{phone:contactPhone}}),0,'Synthetic phone already suppressed');
  try{
    await status(await req('ai/agents','GET',undefined,''),401,'Anonymous AI data');
    const login=await req('auth/login','POST',{email:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD},'');await status(login,200,'Admin login');cookie=login.headers.get('set-cookie')!.split(';')[0];
    const providerResponse=await req('ai/status');await status(providerResponse,200,'Ollama model discovery');const provider=await providerResponse.json();assert.equal(provider.available,true,'Start the documented local Ollama fixture before running the AI HTTP suite');assert.ok(provider.models.some((m:{name:string})=>m.name===chatModel));assert.ok(provider.models.some((m:{name:string})=>m.name===embeddingModel));assert.equal('configuredUrl' in provider,false);
    const password=randomBytes(24).toString('hex');const user=await db.user.create({data:{email:`${tag}@example.invalid`,name:tag,role:'AGENT',passwordHash:await hash(password,12)}});userId=user.id;
    const agentLogin=await req('auth/login','POST',{email:user.email,password},'');await status(agentLogin,200,'Agent login');agentCookie=agentLogin.headers.get('set-cookie')!.split(';')[0];
    const connection=await db.connection.create({data:{name:tag,phone:'+5511999999559',phoneNumberId:`mock-${tag}`,wabaId:`mock-waba-${tag}`,mode:'MOCK',status:'CONNECTED'}});connectionId=connection.id;
    const created=await req('ai/agents','POST',{connectionId,name:'Agente sintético HTTP',model:chatModel,embeddingModel});await status(created,201,'Create AI agent');const agent=(await created.json()).agent;agentId=agent.id;entityIds.push(agent.id);assert.equal(agent.mode,'OFF');assert.equal(agent.retainHistory,false);
    for(const [path,method,data] of [[`ai/agents/${agentId}`,'PATCH',{instructions:'forbidden'}],[`ai/agents/${agentId}/knowledge`,'POST',{title:'x',text:'forbidden'}],[`ai/agents/${agentId}/knowledge`,'GET',undefined],[`ai/agents/${agentId}/test`,'POST',{message:'forbidden'}]] as const)await status(await req(path,method,data,agentCookie),403,'Agent restricted AI training access');
    const list=await req('ai/agents','GET',undefined,agentCookie);await status(list,200,'Agent summaries');const summary=(await list.json()).agents.find((a:{id:string})=>a.id===agentId);assert.equal('instructions' in summary,false);assert.equal('faqs' in summary,false);assert.equal('encryptedToken' in summary.connection,false);
    await status(await req(`ai/agents/${agentId}`,'PATCH',{model:embeddingModel}),400,'Embedding model cannot be selected as chat model');
    await status(await req(`ai/agents/${agentId}`,'PATCH',{model:'definitely-not-installed:latest'}),422,'Missing local model is not silently substituted');
    await status(await req(`ai/agents/${agentId}`,'PATCH',{ollamaUrl:'http://untrusted.invalid'}),400,'Client endpoint override denied');
    console.log('PASS AI HTTP model selection/RBAC: installed arbitrary model, capability gates, no cloud fallback/URL override, agent training isolation.');

    const config=await req(`ai/agents/${agentId}`,'PATCH',{instructions:'Responda apenas com os dados comerciais aprovados. Peça ajuda humana quando não souber.',faqs:[{question:'Qual é o horário?',answer:'De segunda a sexta, das 9h às 18h.'}],services:[{name:'Implantação',description:'Configuração assistida do CRM.'}],prices:[{item:'Implantação',price:'R$ 150,00',currency:'BRL'}],mode:'OFF',retainHistory:false,maxHistoryMessages:5,timeoutSeconds:30});await status(config,200,'Persist AI settings');
    const structured=await db.knowledgeSource.findFirstOrThrow({where:{agentId,type:'STRUCTURED'}});assert.equal(structured.approved,true);await pollSource(structured.id);
    const form=new FormData();form.append('title','Tabela comercial sintética');form.append('file',new File(['O serviço de implantação custa R$ 150,00. O atendimento ocorre de segunda a sexta, das 9h às 18h.'],'comercial.txt',{type:'text/plain'}));
    const uploaded=await req(`ai/agents/${agentId}/knowledge`,'POST',undefined,cookie,form);await status(uploaded,201,'Upload TXT knowledge');const source=(await uploaded.json()).source;entityIds.push(source.id);await pollSource(source.id);assert.ok(await db.knowledgeChunk.count({where:{sourceId:source.id}})>0);
    const invalidForm=new FormData();invalidForm.append('title','Documento não suportado');invalidForm.append('file',new File(['<script>alert(1)</script>'],'pagina.html',{type:'text/html'}));await status(await req(`ai/agents/${agentId}/knowledge`,'POST',undefined,cookie,invalidForm),400,'Unsupported document rejected');
    const test=await req(`ai/agents/${agentId}/test`,'POST',{message:'Quanto custa a implantação?'});await status(test,202,'Queue playground while operational agent OFF');const runId=(await test.json()).run.id;entityIds.push(runId);const run=await pollRun(runId);assert.equal(run.status,'COMPLETED');assert.ok(run.output);assert.ok(run.sources.length>0);assert.ok(run.expiresAt);assert.equal(await db.message.count({where:{direction:'OUTBOUND',conversation:{connectionId}}}),0,'Playground must never send WhatsApp messages');
    console.log('PASS AI HTTP training: structured commercial data + TXT indexed in background; OFF playground answers with citations and never sends.');

    const correctionResponse=await req(`ai/runs/${runId}/corrections`,'POST',{correctedAnswer:'O serviço de implantação custa R$ 150,00, conforme a tabela aprovada.'});await status(correctionResponse,201,'Submit correction');const correction=(await correctionResponse.json()).correction;entityIds.push(correction.id);assert.equal(correction.status,'PENDING');assert.equal(correction.sourceId,null);
    await status(await req(`ai/corrections/${correction.id}/approve`,'POST',{},agentCookie),403,'Agent cannot approve correction');
    const approved=await req(`ai/corrections/${correction.id}/approve`,'POST',{});await status(approved,201,'Admin correction approval');const approvedBody=await approved.json();const correctionSource=approvedBody.source;assert.equal(correctionSource.type,'CORRECTION');assert.equal(correctionSource.approved,true);await pollSource(correctionSource.id);
    await status(await req(`ai/corrections/${correction.id}/approve`,'POST',{}),409,'Correction cannot be approved twice');
    const reindex=await req(`ai/knowledge/${source.id}/reindex`,'POST',{});await status(reindex,202,'Knowledge reindex');await pollSource(source.id);
    await status(await req(`ai/knowledge/${source.id}`,'DELETE'),200,'Knowledge removal');assert.equal(await db.knowledgeChunk.count({where:{sourceId:source.id}}),0);
    console.log('PASS AI HTTP review: corrections remain pending until admin approval, approved knowledge indexed once, reindex/delete removes stale chunks.');

    const company=await db.company.create({data:{name:tag,contacts:{create:{name:'Contato sintético IA',phone:contactPhone}}},include:{contacts:true}});companyId=company.id;
    const conversation=await db.conversation.create({data:{contactId:company.contacts[0].id,connectionId,lastInboundAt:new Date()}});entityIds.push(conversation.id);
    const permissionData={allowed:true,source:'Fixture HTTP',purpose:'Processamento local por IA e revisão de conhecimento autorizados para teste',evidence:'Contato totalmente sintético criado pela suíte, sem comunicação externa.'};
    await status(await req(`ai/conversations/${conversation.id}/permission`,'POST',permissionData,agentCookie),403,'Agent cannot grant AI permission');await status(await req(`ai/conversations/${conversation.id}/permission`,'POST',permissionData),200,'Documented AI permission');
    await status(await req(`ai/agents/${agentId}`,'PATCH',{mode:'SUGGEST'}),200,'Enable suggestion mode');
    await status(await req(`contacts/${company.contacts[0].id}/consent`,'POST',{source:'Fixture de envio HTTP',purpose:'Atendimento sintético autorizado sem API externa',evidence:'Contato sintético da suíte, destino apenas do adaptador mock.'}),201,'Documented communication opt-in');
    await status(await req('test/inbound','POST',{connectionId,phone:company.contacts[0].phone,body:'Quanto custa a implantação?'}),200,'Mock webhook queues incoming AI');
    let incomingRun:Awaited<ReturnType<typeof db.aiRun.findFirst>>=null;const until=Date.now()+30000;
    while(Date.now()<until){incomingRun=await db.aiRun.findFirst({where:{conversationId:conversation.id,origin:'INCOMING'},orderBy:{createdAt:'desc'}});if(incomingRun)break;await new Promise(resolve=>setTimeout(resolve,200));}
    assert.ok(incomingRun,'Incoming webhook did not create an AI run');const suggestion=await pollRun(incomingRun.id);assert.equal(suggestion.status,'SUGGESTED');
    await status(await req(`ai/runs/${incomingRun.id}`,'GET',undefined,agentCookie),200,'Agent reads authorized suggestion');
    const humanSend=await req(`ai/runs/${incomingRun.id}/send`,'POST',{},agentCookie);await status(humanSend,200,'Human approves suggestion');assert.ok((await humanSend.json()).message.externalId.startsWith('mock_'));
    await status(await req(`ai/runs/${incomingRun.id}/send`,'POST',{},agentCookie),200,'Repeated human approval is idempotent');assert.equal(await db.message.count({where:{conversationId:conversation.id,direction:'OUTBOUND'}}),1);
    console.log('PASS AI HTTP human approval: authorized inbound creates suggestion, agent explicitly sends, repeated approval produces one mock message.');
    const syntheticRun=await db.aiRun.create({data:{agentId:agentId!,conversationId:conversation.id,origin:'INCOMING',mode:'SUGGEST',input:'Pergunta pessoal sintética',output:'Resposta pessoal sintética',reason:'Metadado pessoal sintético a remover',error:'Erro pessoal sintético a remover',status:'SUGGESTED',retainHistory:false,expiresAt:new Date(Date.now()+86400000)}});entityIds.push(syntheticRun.id);
    const pendingCorrection=await req(`ai/runs/${syntheticRun.id}/corrections`,'POST',{correctedAnswer:'Resposta corrigida sintética'});await status(pendingCorrection,201,'Conversation correction submitted');const pending=(await pendingCorrection.json()).correction;
    const approveConversation=await req(`ai/corrections/${pending.id}/approve`,'POST',{});await status(approveConversation,201,'Conversation curated correction approval');const personalSource=(await approveConversation.json()).source;
    await status(await req(`ai/conversations/${conversation.id}`,'PATCH',{aiPaused:true},agentCookie),200,'Agent can pause AI');assert.equal((await db.conversation.findUniqueOrThrow({where:{id:conversation.id}})).aiPaused,true);
    await status(await req(`ai/conversations/${conversation.id}/permission`,'POST',{allowed:false,source:'Revogação sintética HTTP',purpose:'Interromper uso pela IA'}),200,'Revoke AI permission');
    const scrubbed=await db.aiRun.findUniqueOrThrow({where:{id:syntheticRun.id}});assert.equal(scrubbed.input,'');assert.equal(scrubbed.output,null);assert.deepEqual(scrubbed.sources,[]);assert.equal(scrubbed.error,null);assert.equal(scrubbed.reason,'Conteúdo removido após revogação da autorização de IA.');assert.equal(await db.aiCorrection.count({where:{runId:syntheticRun.id}}),0);assert.equal(await db.knowledgeSource.count({where:{id:personalSource.id}}),0);assert.equal(await db.knowledgeChunk.count({where:{sourceId:personalSource.id}}),0);
    await status(await req(`ai/runs/${syntheticRun.id}`,'GET',undefined,agentCookie),403,'Revoked AI data hidden from agent');
    const expired=await db.aiRun.create({data:{agentId:agentId!,mode:'OFF',origin:'TEST',input:'Conteúdo expirado sintético',output:'Resposta expirada sintética',reason:'Metadado pessoal expirado',error:'Erro pessoal expirado',status:'COMPLETED',expiresAt:new Date(Date.now()-1000)}});entityIds.push(expired.id);const expiredView=await req(`ai/runs/${expired.id}`);await status(expiredView,200,'Expired run metadata available');const expiredBody=(await expiredView.json()).run;assert.equal(expiredBody.input,'');assert.equal(expiredBody.output,null);assert.equal(expiredBody.error,null);assert.equal(expiredBody.reason,'Conteúdo temporário expirado.');
    console.log('PASS AI HTTP privacy/handoff controls: documented permission, operator pause, revocation scrubs runs + derived curated knowledge, expired run content redacted.');
    await status(await req(`ai/conversations/${conversation.id}/permission`,'POST',permissionData),200,'Regrant synthetic AI permission for erasure fixture');
    const eraseRun=await db.aiRun.create({data:{agentId:agentId!,conversationId:conversation.id,origin:'INCOMING',mode:'SUGGEST',input:'Pergunta sintética a apagar',output:'Resposta sintética a apagar',status:'COMPLETED',expiresAt:new Date(Date.now()+86400000)}});
    const eraseCorrectionResponse=await req(`ai/runs/${eraseRun.id}/corrections`,'POST',{correctedAnswer:'Correção sintética derivada que deve ser apagada junto com o contato.'});await status(eraseCorrectionResponse,201,'Submit erasure fixture correction');const eraseCorrection=(await eraseCorrectionResponse.json()).correction;
    const eraseApproval=await req(`ai/corrections/${eraseCorrection.id}/approve`,'POST',{});await status(eraseApproval,201,'Approve erasure fixture correction');const eraseSource=(await eraseApproval.json()).source;await pollSource(eraseSource.id);assert.ok(await db.knowledgeChunk.count({where:{sourceId:eraseSource.id}})>0);
    await status(await req(`contacts/${company.contacts[0].id}`,'DELETE'),200,'Erase contact and derived AI knowledge');
    assert.equal(await db.contact.count({where:{id:company.contacts[0].id}}),0);assert.equal(await db.aiConversationPermission.count({where:{conversationId:conversation.id}}),0);assert.equal(await db.aiRun.count({where:{conversationId:conversation.id}}),0);assert.equal(await db.aiCorrection.count({where:{id:eraseCorrection.id}}),0);assert.equal(await db.knowledgeSource.count({where:{id:eraseSource.id}}),0);assert.equal(await db.knowledgeChunk.count({where:{sourceId:eraseSource.id}}),0);
    console.log('PASS AI HTTP erasure: deleting a contact removes approved derived knowledge and vectors before cascades erase conversation provenance.');

  }finally{
    if(cookie)await req('auth/logout','POST',{}).catch(()=>{});if(agentCookie)await req('auth/logout','POST',{},agentCookie).catch(()=>{});
    if(connectionId)await db.connection.deleteMany({where:{id:connectionId}});if(companyId)await db.company.deleteMany({where:{id:companyId}});if(userId)await db.user.deleteMany({where:{id:userId}});if(companyId)await db.suppression.deleteMany({where:{phone:contactPhone}});if(entityIds.length)await db.auditLog.deleteMany({where:{entityId:{in:entityIds}}});await db.$disconnect();
  }
}
main().catch(error=>{console.error(error instanceof Error?error.message:'AI HTTP acceptance failed');process.exitCode=1;}).finally(()=>db.$disconnect());
