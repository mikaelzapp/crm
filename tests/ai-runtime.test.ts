import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
const fixture=vi.hoisted(()=>({agent:{} as any,conversation:{} as any,latest:{} as any,runs:[] as any[],chunks:[] as any[],history:[] as any[]}));
const fake=vi.hoisted(()=>({
 aiRun:{findUnique:vi.fn(),findUniqueOrThrow:vi.fn(),upsert:vi.fn(),update:vi.fn(),updateMany:vi.fn()},
 conversation:{findUnique:vi.fn(),findUniqueOrThrow:vi.fn(),update:vi.fn(),updateMany:vi.fn(),findMany:vi.fn()},
 message:{findUnique:vi.fn(),findFirst:vi.fn(),findMany:vi.fn()},aiAgent:{findUnique:vi.fn()},
 knowledgeChunk:{findMany:vi.fn()},knowledgeSource:{findUnique:vi.fn(),updateMany:vi.fn(),deleteMany:vi.fn()},
 task:{findFirst:vi.fn(),create:vi.fn()},contact:{updateMany:vi.fn(),findMany:vi.fn()},
 recipient:{updateMany:vi.fn()},user:{findFirst:vi.fn()},auditLog:{create:vi.fn()},suppression:{upsert:vi.fn()},consent:{updateMany:vi.fn()},
 aiConversationPermission:{updateMany:vi.fn()},aiCorrection:{findMany:vi.fn(),deleteMany:vi.fn()},$transaction:vi.fn(),$executeRaw:vi.fn(),
}));
const hooks=vi.hoisted(()=>({generate:vi.fn(),eligible:vi.fn(),emergency:vi.fn(),reply:vi.fn(),index:vi.fn()}));
vi.mock('../src/lib/db',()=>({db:fake}));
vi.mock('../src/lib/campaigns',()=>({eligibility:hooks.eligible,emergencyStopped:hooks.emergency,replyToConversation:hooks.reply}));
vi.mock('../src/lib/knowledge',()=>({indexKnowledgeSource:hooks.index}));
vi.mock('../src/lib/intelligence',()=>({
 classifyIntent:(text:string)=>/parar|sair/i.test(text)?'OPT_OUT':/humano/i.test(text)?'HUMAN':/interesse/i.test(text)?'INTEREST':'GENERAL',
 generateAiReply:hooks.generate,
}));
import {aiPermissionValid,prepareIncomingAi,processAiRun,approveAiSuggestion,redactExpiredAiHistory,processKnowledgeIndex} from '../src/lib/ai-runtime';
function run(overrides:Record<string,any>={}):any {
 const r={id:`r${fixture.runs.length+1}`,agentId:'a',conversationId:'conv',triggerMessageId:'inbound',origin:'INCOMING',input:'Qual o horário?',status:'QUEUED',mode:fixture.agent.mode,output:null,sources:[],retainHistory:false,createdAt:new Date(),expiresAt:new Date(Date.now()+86400000),...overrides};
 fixture.runs.push(r);return r;
}
function patch(target:Record<string,any>,data:Record<string,any>){Object.assign(target,data);return {...target};}
function matchRun(where:any){return fixture.runs.find(r=>where.id?r.id===where.id:r.triggerMessageId===where.triggerMessageId);}
beforeEach(()=>{
 vi.clearAllMocks();
 fixture.agent={id:'a',connectionId:'num',mode:'SUGGEST',updatedAt:new Date(Date.now()-1000),retainHistory:false,maxHistoryMessages:10,timeoutSeconds:5,embeddingModel:'embed'};
 const permission={allowed:true,source:'Formulário',purpose:'Atendimento por IA local',evidence:'evento de aceite sintético',grantedAt:new Date(Date.now()-10000),revokedAt:null};
 fixture.conversation={id:'conv',contactId:'contact',connectionId:'num',aiPaused:false,status:'PENDING',assignedToId:null,lastInboundAt:new Date(),contact:{id:'contact',phone:'+5511999999999'},connection:{id:'num',enabled:true,quality:'GREEN',aiAgent:fixture.agent},aiPermission:permission};
 fixture.latest={id:'inbound',conversationId:'conv',direction:'INBOUND',type:'TEXT',body:'Qual o horário?',createdAt:new Date(),conversation:fixture.conversation};
 fixture.runs=[];fixture.history=[];
 fixture.chunks=[{id:'chunk',sourceId:'source',contentHash:'hash',source:{id:'source',approved:true,status:'READY',indexedHash:'hash',contentHash:'hash'}}];
 fake.aiRun.findUnique.mockImplementation(async({where}:any)=>{const r=matchRun(where);return r?{...r,agent:fixture.agent}:null;});
 fake.aiRun.findUniqueOrThrow.mockImplementation(async({where}:any)=>{const r=matchRun(where);if(!r)throw Error('Run ausente');return {...r,agent:fixture.agent};});
 fake.aiRun.upsert.mockImplementation(async({where,create}:any)=>{const old=matchRun(where);return old||run(create);});
 fake.aiRun.update.mockImplementation(async({where,data}:any)=>{const r=matchRun(where);if(!r)throw Error('Run ausente');return patch(r,data);});
 fake.aiRun.updateMany.mockImplementation(async({where,data}:any)=>{let count=0;for(const r of fixture.runs){if(where.id&&r.id!==where.id)continue;if(typeof where.status==='string'&&r.status!==where.status)continue;patch(r,data);count++;}return {count};});
 fake.conversation.findUnique.mockImplementation(async()=>fixture.conversation);
 fake.conversation.findUniqueOrThrow.mockImplementation(async()=>fixture.conversation);
 fake.conversation.update.mockImplementation(async({data}:any)=>patch(fixture.conversation,data));
 fake.conversation.updateMany.mockImplementation(async({data}:any)=>{patch(fixture.conversation,data);return {count:1};});
 fake.conversation.findMany.mockResolvedValue([{id:'conv'}]);
 fake.message.findUnique.mockImplementation(async({where}:any)=>where.id?fixture.latest:null);
 fake.message.findFirst.mockImplementation(async()=>fixture.latest);
 fake.message.findMany.mockImplementation(async()=>fixture.history);
 fake.aiAgent.findUnique.mockImplementation(async()=>fixture.agent);
 fake.knowledgeChunk.findMany.mockImplementation(async()=>fixture.chunks);
 fake.contact.findMany.mockResolvedValue([{id:'contact'}]);
 for(const fn of [fake.recipient.updateMany,fake.contact.updateMany,fake.aiConversationPermission.updateMany,fake.consent.updateMany,fake.aiCorrection.deleteMany,fake.knowledgeSource.updateMany])fn.mockResolvedValue({count:1});
 fake.aiCorrection.findMany.mockResolvedValue([]);fake.knowledgeSource.deleteMany.mockResolvedValue({count:0});
 fake.task.findFirst.mockResolvedValue(null);fake.task.create.mockResolvedValue({id:'task'});fake.user.findFirst.mockResolvedValue(null);fake.auditLog.create.mockResolvedValue({id:'audit'});
 fake.suppression.upsert.mockResolvedValue({id:'suppression'});fake.$executeRaw.mockResolvedValue(1);
 fake.$transaction.mockImplementation(async(fn:any)=>typeof fn==='function'?fn(fake):Promise.all(fn));
 hooks.eligible.mockResolvedValue({eligible:true,reason:null});hooks.emergency.mockResolvedValue(false);
 hooks.generate.mockResolvedValue({answer:'Atendemos das 9h às 18h.',intent:'GENERAL',sources:[{id:'chunk',sourceId:'source'}],handoff:false});
 hooks.reply.mockImplementation(async(_conv,_text,_key,_user,guard)=>{if(guard)await guard();return {id:'outbound',status:'SENT'};});
});
afterEach(()=>vi.useRealTimers());
describe('permissão específica para IA',()=>{
 it('nega autorização incompleta, futura, revogada ou ausente',()=>{
  expect(aiPermissionValid(null)).toBe(false);const p=fixture.conversation.aiPermission;
  expect(aiPermissionValid(p)).toBe(true);
  for(const data of [{allowed:false},{evidence:''},{source:''},{purpose:''},{grantedAt:new Date(Date.now()+1000)},{revokedAt:new Date()}])expect(aiPermissionValid({...p,...data})).toBe(false);
 });
 it('modo OFF não cria execução nem chama modelo',async()=>{
  fixture.agent.mode='OFF';expect(await prepareIncomingAi('inbound')).toBeNull();expect(hooks.generate).not.toHaveBeenCalled();expect(fake.aiRun.upsert).not.toHaveBeenCalled();
 });
 it('sem autorização documentada encaminha a humano sem copiar conteúdo para AI run',async()=>{
  fixture.conversation.aiPermission=null;expect(await prepareIncomingAi('inbound')).toBeNull();expect(hooks.generate).not.toHaveBeenCalled();expect(fixture.runs[0].input).toBe('');expect(fixture.runs[0].status).toBe('HANDOFF');expect(fixture.conversation.aiPaused).toBe(true);
 });
 it('opt-in de WhatsApp é obrigatório mesmo com permissão IA',async()=>{
  hooks.eligible.mockResolvedValue({eligible:false,reason:'Consentimento não registrado.'});await prepareIncomingAi('inbound');expect(hooks.generate).not.toHaveBeenCalled();expect(fixture.runs[0].reason).toContain('Consentimento');
 });
 it('pedido de humano é aplicado antes de qualquer autorização ou modelo',async()=>{
  fixture.latest.body='Quero atendimento humano';fixture.agent.mode='OFF';fixture.conversation.aiPermission=null;
  await prepareIncomingAi('inbound');expect(fixture.conversation.aiPaused).toBe(true);expect(fake.task.create).toHaveBeenCalled();expect(hooks.generate).not.toHaveBeenCalled();
 });
 it('pedido de parar revoga autorizações, suprime telefone e remove conteúdo IA sem chamar modelo',async()=>{
  fixture.latest.body='Parar';run({status:'SUGGESTED',output:'resposta antiga'});await prepareIncomingAi('inbound');
  expect(fake.suppression.upsert).toHaveBeenCalled();expect(fake.aiConversationPermission.updateMany).toHaveBeenCalled();expect(fixture.runs[0].input).toBe('');expect(fixture.runs[0].output).toBeNull();expect(fixture.runs[0].error).toBeNull();expect(hooks.generate).not.toHaveBeenCalled();
 });
 it('interesse comercial é classificado localmente com IA desligada',async()=>{
  fixture.latest.body='Tenho interesse';fixture.agent.mode='OFF';await prepareIncomingAi('inbound');expect(fake.contact.updateMany).toHaveBeenCalledWith(expect.objectContaining({data:{stage:'INTERESTED'}}));expect(hooks.generate).not.toHaveBeenCalled();
 });
});
describe('execução durável, modos e conteúdo temporário',()=>{
 it('SUGGEST gera sugestão sem envio e sem histórico quando retenção desligada',async()=>{
  const id=await prepareIncomingAi('inbound');expect(id).toBeTruthy();const r=fixture.runs[0];
  expect(r.expiresAt.getTime()-Date.now()).toBeLessThanOrEqual(86400000);
  await processAiRun(id!);expect(r.status).toBe('SUGGESTED');expect(hooks.reply).not.toHaveBeenCalled();expect(hooks.generate.mock.calls[0][0].history).toBeUndefined();
 });
 it('AUTO envia uma vez pelo helper existente com guard final; duplicata não chama modelo',async()=>{
  fixture.agent.mode='AUTO';const r=run();await processAiRun(r.id);await processAiRun(r.id);
  expect(hooks.generate).toHaveBeenCalledTimes(1);expect(hooks.reply).toHaveBeenCalledTimes(1);expect(r.status).toBe('SENT');expect(r.outboundMessageId).toBe('outbound');
 });
 it('playground TEST funciona com agente OFF e não envia WhatsApp',async()=>{
  fixture.agent.mode='OFF';const r=run({origin:'TEST',conversationId:null,triggerMessageId:null});await processAiRun(r.id);expect(r.status).toBe('COMPLETED');expect(hooks.reply).not.toHaveBeenCalled();
 });
 it('histórico autorizado é limitado e só encaminhado quando retenção está ligada',async()=>{
  fixture.agent.retainHistory=true;fixture.history=[{direction:'INBOUND',body:'Olá'},{direction:'OUTBOUND',body:'Bem-vindo'}];const r=run({retainHistory:true,expiresAt:null});await processAiRun(r.id);expect(hooks.generate.mock.calls[0][0].history).toHaveLength(2);expect(fake.message.findMany).toHaveBeenCalledWith(expect.objectContaining({take:10}));
 });
 it('execução PROCESSING interrompida vira handoff sem repetir inferência ou envio',async()=>{
  const r=run({status:'PROCESSING'});await processAiRun(r.id);expect(r.status).toBe('HANDOFF');expect(hooks.generate).not.toHaveBeenCalled();expect(hooks.reply).not.toHaveBeenCalled();
 });
 it('falha de Ollama encaminha a humano; execução repetida não reinicia o modelo',async()=>{
  hooks.generate.mockRejectedValue(new Error('Ollama indisponível'));const r=run();await processAiRun(r.id);await processAiRun(r.id);expect(r.status).toBe('HANDOFF');expect(r.error).toContain('indisponível');expect(hooks.generate).toHaveBeenCalledTimes(1);
 });
 it('timeout aborta inferência e pausa para humano',async()=>{
  vi.useFakeTimers();hooks.generate.mockImplementation(({signal}:any)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('abort')),{once:true})));
  const r=run();const promise=processAiRun(r.id);await vi.advanceTimersByTimeAsync(5001);await promise;expect(r.status).toBe('HANDOFF');expect(r.reason).toContain('Tempo limite');expect(hooks.reply).not.toHaveBeenCalled();
 });
 it('conteúdo expirado não gera inferência',async()=>{
  const r=run({expiresAt:new Date(Date.now()-1)});await processAiRun(r.id);expect(r.input).toBe('');expect(r.status).toBe('SKIPPED');expect(hooks.generate).not.toHaveBeenCalled();
 });
 it('varredura remove também reason e error de execuções expiradas com conteúdo já vazio',async()=>{
  const expired=run({status:'HANDOFF',input:'',output:null,sources:[],reason:'Nome pessoal sintético no motivo antigo',error:'Dado pessoal sintético no erro antigo',expiresAt:new Date(Date.now()-1)});
  await redactExpiredAiHistory();
  expect(expired.input).toBe('');expect(expired.output).toBeNull();expect(expired.sources).toEqual([]);
  expect(expired.reason).toBe('Conteúdo temporário expirado.');expect(expired.error).toBeNull();
  expect(fake.aiRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({data:{input:'',output:null,sources:[],reason:'Conteúdo temporário expirado.',error:null}}));expect(fake.aiCorrection.deleteMany).toHaveBeenCalled();
 });
});
describe('revalidação após inferência e antes de envio',()=>{
 it('descarta resposta se agente foi editado durante inferência',async()=>{
  fixture.agent.mode='AUTO';const r=run();hooks.generate.mockImplementation(async()=>{fixture.agent.updatedAt=new Date(Date.now()+1);return {answer:'Resposta',intent:'GENERAL',sources:[{id:'chunk',sourceId:'source'}],handoff:false};});await processAiRun(r.id);expect(r.status).toBe('SKIPPED');expect(hooks.reply).not.toHaveBeenCalled();
 });
 it('descarta resposta se chegou nova mensagem enquanto modelo processava',async()=>{
  const r=run();hooks.generate.mockImplementation(async()=>{fixture.latest={...fixture.latest,id:'nova'};return {answer:'Resposta',intent:'GENERAL',sources:[{id:'chunk',sourceId:'source'}],handoff:false};});await processAiRun(r.id);expect(r.status).toBe('SKIPPED');expect(hooks.reply).not.toHaveBeenCalled();
 });
 it('revogação durante inferência bloqueia resposta',async()=>{
  const r=run();hooks.generate.mockImplementation(async()=>{fixture.conversation.aiPermission.revokedAt=new Date();return {answer:'Resposta',intent:'GENERAL',sources:[{id:'chunk',sourceId:'source'}],handoff:false};});await processAiRun(r.id);expect(r.status).toBe('HANDOFF');expect(r.output).toBeNull();expect(hooks.reply).not.toHaveBeenCalled();
 });
 it('pausa humana durante inferência descarta saída',async()=>{
  const r=run();hooks.generate.mockImplementation(async()=>{fixture.conversation.aiPaused=true;return {answer:'Resposta',intent:'GENERAL',sources:[],handoff:false};});await processAiRun(r.id);expect(r.status).toBe('SKIPPED');expect(r.output).toBeNull();expect(hooks.reply).not.toHaveBeenCalled();
 });
 it('referência retirada da aprovação impede envio automático',async()=>{
  fixture.agent.mode='AUTO';fixture.chunks[0].source.approved=false;const r=run();await processAiRun(r.id);expect(r.status).toBe('HANDOFF');expect(hooks.reply).not.toHaveBeenCalled();
 });
 it('resposta sem fontes nunca é enviada automaticamente',async()=>{
  fixture.agent.mode='AUTO';hooks.generate.mockResolvedValue({answer:'Informação não comprovada',intent:'GENERAL',sources:[],handoff:false});const r=run();await processAiRun(r.id);expect(r.status).toBe('HANDOFF');expect(hooks.reply).not.toHaveBeenCalled();
 });
 it('permissão revogada durante rate wait é bloqueada pelo guard executado no helper de envio',async()=>{
  fixture.agent.mode='AUTO';hooks.reply.mockImplementation(async(_a,_b,_c,_d,guard)=>{fixture.conversation.aiPermission.allowed=false;await guard();throw Error('não deve chegar aqui');});const r=run();await processAiRun(r.id);expect(r.status).toBe('HANDOFF');expect(r.outboundMessageId).toBeUndefined();
 });
 it('envio de resultado UNKNOWN encaminha a humano e preserva referência ao histórico',async()=>{
  fixture.agent.mode='AUTO';hooks.reply.mockResolvedValue({id:'uncertain',status:'UNKNOWN'});const r=run();await processAiRun(r.id);expect(r.status).toBe('HANDOFF');expect(r.outboundMessageId).toBe('uncertain');await processAiRun(r.id);expect(hooks.reply).toHaveBeenCalledTimes(1);
 });
});
describe('aprovação humana de sugestões',()=>{
 it('aprova somente sugestão atual; repetição retorna mensagem existente sem novo envio',async()=>{
  const r=run({status:'SUGGESTED',output:'Resposta revisada',sources:[{id:'chunk',sourceId:'source'}]});await approveAiSuggestion(r.id,'admin');expect(r.status).toBe('SENT');expect(hooks.reply).toHaveBeenCalledTimes(1);
 });
 it('sugestão antiga é rejeitada quando há mensagem mais recente',async()=>{
  const r=run({status:'SUGGESTED',output:'Resposta antiga',sources:[{id:'chunk',sourceId:'source'}]});fixture.latest.id='new';await expect(approveAiSuggestion(r.id,'admin')).rejects.toThrow('recente');expect(hooks.reply).not.toHaveBeenCalled();
 });
 it('sugestão expirada ou originada no playground não pode enviar WhatsApp',async()=>{
  const expired=run({status:'SUGGESTED',output:'Resposta',expiresAt:new Date(Date.now()-1)});await expect(approveAiSuggestion(expired.id)).rejects.toThrow('expirada');
  const test=run({origin:'TEST',status:'COMPLETED',output:'Resposta'});await expect(approveAiSuggestion(test.id)).rejects.toThrow('sugestão válida');expect(hooks.reply).not.toHaveBeenCalled();
 });
});
