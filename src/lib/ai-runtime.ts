import { Prisma } from '@prisma/client';
import { db } from './db';
import { eligibility, emergencyStopped, replyToConversation } from './campaigns';
import { classifyIntent, generateAiReply } from './intelligence';
import { indexKnowledgeSource } from './knowledge';

const DAY=86400000;
const HISTORY_OFF_TTL=DAY;
const HANDOFF_TASK='Atendimento humano solicitado';
export type AiMode='OFF'|'SUGGEST'|'AUTO';
function temporaryExpiry(retain:boolean){return retain?null:new Date(Date.now()+HISTORY_OFF_TTL);}
function expiredRun(run:{retainHistory:boolean;createdAt:Date;expiresAt:Date|null}){return run.expiresAt?run.expiresAt.getTime()<=Date.now():!run.retainHistory&&run.createdAt.getTime()+HISTORY_OFF_TTL<=Date.now();}
function nonempty(value:unknown):boolean{return typeof value==='string'&&!!value.trim();}
function failureReason(error:unknown):string {
  return error instanceof Error?error.message.slice(0,500):'Falha ao processar atendimento com IA.';
}
/** Permission is additional to WhatsApp opt-in. A marketing grant never implies permission for AI. */
export function aiPermissionValid(permission:{allowed:boolean;source:string;purpose:string;evidence:string|null;grantedAt:Date|null;revokedAt:Date|null}|null|undefined,now=Date.now()):boolean {
  return !!permission&&permission.allowed&&nonempty(permission.source)&&nonempty(permission.purpose)&&nonempty(permission.evidence)&&!!permission.grantedAt&&permission.grantedAt.getTime()<=now&&!permission.revokedAt;
}
async function localTask(contactId:string,title:string) {
  await db.$transaction(async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-task-${contactId}`}))`;
    if(!await tx.task.findFirst({where:{contactId,title,completed:false}}))await tx.task.create({data:{contactId,title,dueAt:new Date()}});
  });
}
async function humanHandoff(conversationId:string,reason:string,runId?:string,pause=true) {
  await db.$transaction(async tx=>{
    const conversation=await tx.conversation.findUnique({where:{id:conversationId}});
    if(!conversation)return;
    const assignee=conversation.assignedToId?null:await tx.user.findFirst({where:{role:'AGENT'},orderBy:{createdAt:'asc'},select:{id:true}});
    await tx.conversation.update({where:{id:conversationId},data:{status:'PENDING',...(pause?{aiPaused:true}:{}),...(assignee?{assignedToId:assignee.id}:{})}});
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-task-${conversation.contactId}`}))`;
    const title=`${HANDOFF_TASK}: ${reason}`.slice(0,500);
    if(!await tx.task.findFirst({where:{contactId:conversation.contactId,title,completed:false}})) await tx.task.create({data:{contactId:conversation.contactId,title,dueAt:new Date()}});
    if(runId) await tx.aiRun.update({where:{id:runId},data:{status:'HANDOFF',reason:reason.slice(0,1000)}});
    await tx.auditLog.create({data:{action:'AI_HUMAN_HANDOFF',entityId:conversationId,metadata:{reason:reason.slice(0,500),...(runId?{runId}:{})}}});
  });
}
export async function handoffAiRun(runId:string,reason:string) {
  const run=await db.aiRun.findUniqueOrThrow({where:{id:runId}});
  if(run.conversationId) await humanHandoff(run.conversationId,reason,run.id);
  else await db.aiRun.update({where:{id:runId},data:{status:'HANDOFF',reason:reason.slice(0,1000)}});
}
async function localOptOut(conversationId:string) {
  await db.$transaction(async tx=>{
    const conversation=await tx.conversation.findUniqueOrThrow({where:{id:conversationId},include:{contact:true}});
    const phone=conversation.contact.phone;
    const contacts=phone?await tx.contact.findMany({where:{phone},select:{id:true}}):[{id:conversation.contactId}];
    const contactIds=contacts.map(c=>c.id);
    if(phone) await tx.suppression.upsert({where:{phone},create:{phone,reason:'Pedido de cancelamento recebido.'},update:{reason:'Pedido de cancelamento recebido.'}});
    await tx.contact.updateMany({where:{id:{in:contactIds}},data:{doNotContact:true,stage:'DO_NOT_CONTACT'}});
    await tx.consent.updateMany({where:{contactId:{in:contactIds},revokedAt:null},data:{revokedAt:new Date()}});
    const ids=(await tx.conversation.findMany({where:{contactId:{in:contactIds}},select:{id:true}})).map(c=>c.id);
    for(const id of [...ids].sort())await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-permission-${id}`}))`;
    await tx.conversation.updateMany({where:{id:{in:ids}},data:{aiPaused:true}});
    await tx.aiConversationPermission.updateMany({where:{conversationId:{in:ids}},data:{allowed:false,revokedAt:new Date()}});
    const corrections=await tx.aiCorrection.findMany({where:{run:{conversationId:{in:ids}}},select:{sourceId:true}});
    const derivedSourceIds=corrections.flatMap(c=>c.sourceId?[c.sourceId]:[]);
    if(derivedSourceIds.length)await tx.knowledgeSource.deleteMany({where:{id:{in:derivedSourceIds}}});
    await tx.aiRun.updateMany({where:{conversationId:{in:ids}},data:{input:'',output:null,sources:[],reason:'Conteúdo removido após cancelamento.',error:null,status:'HANDOFF',expiresAt:new Date()}});
    await tx.aiCorrection.deleteMany({where:{run:{conversationId:{in:ids}}}});
    await tx.recipient.updateMany({where:{contactId:{in:contactIds},status:{in:['PENDING','RETRY']}},data:{status:'BLOCKED',error:'Cancelamento solicitado pelo contato.'}});
    await tx.auditLog.create({data:{action:'AI_OPT_OUT',entityId:conversationId}});
  });
}
interface IncomingGateInput {conversationId:string;triggerMessageId:string;agentId:string;mode:string;createdAt:Date;agentUpdatedAt?:Date;}
async function incomingGate(input:IncomingGateInput) {
  const conversation=await db.conversation.findUnique({where:{id:input.conversationId},include:{contact:true,connection:{include:{aiAgent:true}},aiPermission:true}});
  if(!conversation)return {allowed:false as const,reason:'Conversa não encontrada.',stale:true};
  const agent=conversation.connection.aiAgent;
  if(!agent||agent.id!==input.agentId||agent.mode==='OFF')return {allowed:false as const,reason:'Agente de IA desligado.',stale:true};
  if(conversation.aiPaused)return {allowed:false as const,reason:'IA pausada para atendimento humano.',stale:true};
  if(agent.mode!==input.mode||agent.updatedAt.getTime()>input.createdAt.getTime()||(input.agentUpdatedAt&&agent.updatedAt.getTime()!==input.agentUpdatedAt.getTime()))return {allowed:false as const,reason:'Configuração do agente mudou; gere uma nova resposta.',stale:true};
  const latest=await db.message.findFirst({where:{conversationId:conversation.id,direction:'INBOUND'},orderBy:[{createdAt:'desc'},{id:'desc'}]});
  if(!latest||latest.id!==input.triggerMessageId)return {allowed:false as const,reason:'Há uma mensagem recebida mais recente. Resposta antiga descartada.',stale:true};
  if(latest.type!=='TEXT')return {allowed:false as const,reason:'Mensagem não textual exige atendimento humano.',stale:false};
  if(!aiPermissionValid(conversation.aiPermission))return {allowed:false as const,reason:'Autorização específica para processamento por IA ausente ou revogada.',stale:false};
  const consent=await eligibility(conversation.contactId);
  if(!consent.eligible)return {allowed:false as const,reason:consent.reason||'Comunicação não autorizada.',stale:false};
  if(!conversation.connection.enabled||['RED','FLAGGED'].includes(conversation.connection.quality))return {allowed:false as const,reason:'Número de WhatsApp desabilitado ou restrito.',stale:false};
  if(!conversation.lastInboundAt||Date.now()-conversation.lastInboundAt.getTime()>=DAY)return {allowed:false as const,reason:'Janela de atendimento de 24 horas encerrada.',stale:false};
  if(await emergencyStopped())return {allowed:false as const,reason:'Suspensão emergencial ativa.',stale:false};
  return {allowed:true as const,conversation,agent,latest};
}
/** Persists a unique run before Redis is touched. It never invokes Ollama. */
export async function prepareIncomingAi(messageId:string):Promise<string|null> {
  const message=await db.message.findUnique({where:{id:messageId},include:{conversation:{include:{connection:{include:{aiAgent:true}}}}}});
  if(!message||message.direction!=='INBOUND')return null;
  const conversation=message.conversation;
  const intent=classifyIntent(message.body);
  if(intent==='OPT_OUT'){await localOptOut(conversation.id);return null;}
  if(intent==='HUMAN'){await humanHandoff(conversation.id,'Contato pediu atendimento humano.');return null;}
  if(intent==='INTEREST') {
    await db.contact.updateMany({where:{id:conversation.contactId,doNotContact:false},data:{stage:'INTERESTED'}});
    await localTask(conversation.contactId,'Acompanhar interesse comercial');
  }
  const agent=conversation.connection.aiAgent;
  if(!agent||!['SUGGEST','AUTO'].includes(agent.mode)||conversation.aiPaused)return null;
  const existing=await db.aiRun.findUnique({where:{triggerMessageId:messageId}});
  if(existing)return existing.status==='QUEUED'?existing.id:null;
  const now=new Date();
  const gate=await incomingGate({conversationId:conversation.id,triggerMessageId:messageId,agentId:agent.id,mode:agent.mode,createdAt:now});
  if(!gate.allowed&&gate.stale)return null;
  const run=await db.aiRun.upsert({where:{triggerMessageId:messageId},create:{agentId:agent.id,conversationId:conversation.id,triggerMessageId:messageId,origin:'INCOMING',input:gate.allowed?message.body:'',mode:agent.mode,retainHistory:agent.retainHistory,expiresAt:temporaryExpiry(agent.retainHistory),intent,status:gate.allowed?'QUEUED':'HANDOFF',reason:gate.allowed?null:gate.reason},update:{}});
  if(!gate.allowed){await humanHandoff(conversation.id,gate.reason,run.id);return null;}
  return run.status==='QUEUED'?run.id:null;
}
async function approvedResultSources(sources:unknown):Promise<boolean> {
  if(!Array.isArray(sources)||!sources.length||sources.some(s=>!s||typeof s.id!=='string'||typeof s.sourceId!=='string'))return false;
  const ids=[...new Set(sources.map(s=>s.id as string))];
  const chunks=await db.knowledgeChunk.findMany({where:{id:{in:ids}},include:{source:true}});
  return chunks.length===ids.length&&chunks.every(chunk=>sources.some(s=>s.id===chunk.id&&s.sourceId===chunk.sourceId)&&chunk.source.approved&&chunk.source.status==='READY'&&chunk.source.indexedHash===chunk.source.contentHash&&chunk.contentHash===chunk.source.contentHash);
}
async function storeResult(runId:string,result:{answer:string;intent:string;sources:unknown[];handoff:boolean;reason?:string},status:string) {
  return db.aiRun.update({where:{id:runId},data:{output:result.answer.slice(0,16000),intent:result.intent,sources:result.sources as Prisma.InputJsonValue,status,reason:result.reason?.slice(0,1000)||null}});
}
export async function processAiRun(runId:string) {
  let run=await db.aiRun.findUnique({where:{id:runId},include:{agent:true}});
  if(!run)return;
  if(run.status==='PROCESSING') {
    const outbound=await db.message.findUnique({where:{idempotencyKey:`reply-ai-run-${run.id}`},select:{id:true}});
    if(outbound)await db.aiRun.update({where:{id:run.id},data:{outboundMessageId:outbound.id}});
    await handoffAiRun(run.id,'Processo de IA interrompido; confira o histórico antes de responder. Nenhum reenvio automático foi realizado.');return;
  }
  if(run.status!=='QUEUED')return;
  if(expiredRun(run)){await db.aiRun.update({where:{id:run.id},data:{input:'',output:null,sources:[],status:'SKIPPED',reason:'Conteúdo temporário expirado.',error:null}});return;}
  if((await db.aiRun.updateMany({where:{id:run.id,status:'QUEUED'},data:{status:'PROCESSING',claimedAt:new Date()}})).count!==1)return;
  const agentVersion=run.agent.updatedAt;
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(new Error('Tempo limite de resposta excedido.')),Math.max(5,Math.min(run.agent.timeoutSeconds,120))*1000);
  try {
    let question=run.input;
    let history:Array<{role:'user'|'assistant';content:string}>|undefined;
    if(run.origin==='INCOMING') {
      if(!run.conversationId||!run.triggerMessageId)throw new Error('Execução recebida sem conversa ou mensagem de origem.');
      const gate=await incomingGate({conversationId:run.conversationId,triggerMessageId:run.triggerMessageId,agentId:run.agentId,mode:run.mode,createdAt:run.createdAt,agentUpdatedAt:agentVersion});
      if(!gate.allowed) {
        if(gate.stale)await db.aiRun.update({where:{id:run.id},data:{status:'SKIPPED',reason:gate.reason}});
        else await handoffAiRun(run.id,gate.reason);
        return;
      }
      question=gate.latest.body;
      const intent=classifyIntent(question);
      if(intent==='OPT_OUT'){await localOptOut(run.conversationId);return;}
      if(intent==='HUMAN'){await handoffAiRun(run.id,'Contato pediu atendimento humano.');return;}
      if(run.retainHistory&&gate.agent.retainHistory) {
        const previous=await db.message.findMany({where:{conversationId:run.conversationId,id:{not:run.triggerMessageId},createdAt:{lte:gate.latest.createdAt},status:{notIn:['FAILED','UNKNOWN','BLOCKED','CANCELED']}},orderBy:[{createdAt:'desc'},{id:'desc'}],take:Math.max(0,Math.min(gate.agent.maxHistoryMessages,30))});
        history=previous.reverse().map(m=>({role:m.direction==='INBOUND'?'user' as const:'assistant' as const,content:m.body.slice(0,4096)}));
      }
    }
    const result=await generateAiReply({agentId:run.agentId,question,history,signal:controller.signal});
    if(controller.signal.aborted)throw new Error('Tempo limite de resposta excedido.');
    const latestRun=await db.aiRun.findUnique({where:{id:run.id}});
    if(!latestRun||latestRun.status!=='PROCESSING')return;
    if(run.origin!=='INCOMING') {
      const currentAgent=await db.aiAgent.findUnique({where:{id:run.agentId}});
      if(!currentAgent||currentAgent.updatedAt.getTime()!==agentVersion.getTime()){await db.aiRun.update({where:{id:run.id},data:{status:'SKIPPED',reason:'Configuração alterada durante o teste.'}});return;}
      await storeResult(run.id,result,result.handoff?'HANDOFF':'COMPLETED');return;
    }
    const gate=await incomingGate({conversationId:run.conversationId!,triggerMessageId:run.triggerMessageId!,agentId:run.agentId,mode:run.mode,createdAt:run.createdAt,agentUpdatedAt:agentVersion});
    if(!gate.allowed) {
      if(gate.stale)await db.aiRun.update({where:{id:run.id},data:{status:'SKIPPED',reason:gate.reason,output:null,sources:[]}});
      else await handoffAiRun(run.id,gate.reason);
      return;
    }
    if(result.intent==='OPT_OUT'){await localOptOut(run.conversationId!);return;}
    if(result.intent==='HUMAN'||result.handoff){await storeResult(run.id,result,'HANDOFF');await handoffAiRun(run.id,result.reason||'Resposta exige avaliação de um atendente.');return;}
    if(!await approvedResultSources(result.sources)){await handoffAiRun(run.id,'As referências foram alteradas, removidas ou não estão aprovadas. Revise a resposta.');return;}
    if(result.intent==='INTEREST'){await db.contact.updateMany({where:{id:gate.conversation.contactId,doNotContact:false},data:{stage:'INTERESTED'}});await localTask(gate.conversation.contactId,'Acompanhar interesse comercial');}
    if(run.mode==='SUGGEST'){await storeResult(run.id,result,'SUGGESTED');return;}
    if(run.mode!=='AUTO'){await db.aiRun.update({where:{id:run.id},data:{status:'SKIPPED',reason:'Modo automático não está ativo.'}});return;}
    await storeResult(run.id,result,'PROCESSING');
    const outbound=await replyToConversation(run.conversationId!,result.answer,`ai-run-${run.id}`,undefined,async()=>{
      const current=await db.aiRun.findUnique({where:{id:run!.id}});
      if(current?.status!=='PROCESSING')throw new Error('Execução de IA interrompida.');
      const finalGate=await incomingGate({conversationId:run!.conversationId!,triggerMessageId:run!.triggerMessageId!,agentId:run!.agentId,mode:'AUTO',createdAt:run!.createdAt,agentUpdatedAt:agentVersion});
      if(!finalGate.allowed)throw new Error(finalGate.reason);
      if(!await approvedResultSources(result.sources))throw new Error('As referências da resposta não estão mais disponíveis ou aprovadas.');
    });
    await db.aiRun.update({where:{id:run.id},data:{outboundMessageId:outbound.id}});
    if(!['SENT','DELIVERED','READ'].includes(outbound.status))throw new Error('O envio automático não foi confirmado. Confira o histórico.');
    await db.aiRun.update({where:{id:run.id},data:{status:'SENT',outboundMessageId:outbound.id}});
  } catch(error) {
    const reason=controller.signal.aborted?'Tempo limite da IA excedido; encaminhado a um atendente.':failureReason(error);
    const current=await db.aiRun.findUnique({where:{id:run.id}});
    if(current?.status==='PROCESSING') {
      await db.aiRun.update({where:{id:run.id},data:{error:reason}});
      await handoffAiRun(run.id,reason);
    }
  } finally {clearTimeout(timeout);}
}
export async function approveAiSuggestion(runId:string,userId?:string) {
  const run=await db.aiRun.findUniqueOrThrow({where:{id:runId},include:{agent:true}});
  if(run.status==='SENT'&&run.outboundMessageId)return db.message.findUniqueOrThrow({where:{id:run.outboundMessageId}});
  if(run.origin!=='INCOMING'||run.mode!=='SUGGEST'||run.status!=='SUGGESTED'||!run.output||!run.conversationId||!run.triggerMessageId)throw new Error('Não há sugestão válida pendente para envio.');
  if(expiredRun(run))throw new Error('Sugestão temporária expirada.');
  const guard=async()=>{
    const current=await db.aiRun.findUnique({where:{id:runId}});
    if(current?.status!=='SUGGESTED')throw new Error('Sugestão não está mais pendente.');
    const gate=await incomingGate({conversationId:run.conversationId!,triggerMessageId:run.triggerMessageId!,agentId:run.agentId,mode:'SUGGEST',createdAt:run.createdAt});
    if(!gate.allowed)throw new Error(gate.reason);
    if(!await approvedResultSources(run.sources))throw new Error('As referências da sugestão não estão mais disponíveis ou aprovadas.');
  };
  await guard();
  let outbound;
  try{outbound=await replyToConversation(run.conversationId,run.output,`ai-run-${run.id}`,userId,guard);}
  catch(error){
    const attempted=await db.message.findUnique({where:{idempotencyKey:`reply-ai-run-${run.id}`},select:{id:true,status:true}});
    if(attempted&&['UNKNOWN','SUBMITTING'].includes(attempted.status)){await db.aiRun.update({where:{id:run.id},data:{outboundMessageId:attempted.id}});await handoffAiRun(run.id,'Resultado do envio não confirmado; confira o histórico antes de responder.');}
    throw error;
  }
  await db.aiRun.update({where:{id:run.id},data:{outboundMessageId:outbound.id}});
  if(!['SENT','DELIVERED','READ'].includes(outbound.status)){await handoffAiRun(run.id,'Envio não confirmado; confira o histórico antes de responder.');throw new Error('Envio não confirmado; confira o histórico antes de responder.');}
  await db.aiRun.update({where:{id:run.id},data:{status:'SENT',outboundMessageId:outbound.id}});
  await db.auditLog.create({data:{userId,action:'AI_SUGGESTION_APPROVED',entityId:run.id}});
  return outbound;
}
export async function processKnowledgeIndex(sourceId:string) {
  const source=await db.knowledgeSource.findUnique({where:{id:sourceId},include:{agent:{select:{timeoutSeconds:true,embeddingModel:true}}}});
  if(!source||!source.approved)return;
  if(source.status==='READY'&&source.indexedHash===source.contentHash&&source.embeddingModel===source.agent.embeddingModel)return;
  if(source.status==='INDEXING')await db.knowledgeSource.updateMany({where:{id:sourceId,status:'INDEXING'},data:{status:'PENDING',error:'Indexação anterior interrompida; retomando.'}});
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(new Error('Tempo limite de indexação excedido.')),Math.min(Math.max(source.agent.timeoutSeconds*4,60),480)*1000);
  try{await indexKnowledgeSource(sourceId,{signal:controller.signal});}
  catch(error){await db.knowledgeSource.updateMany({where:{id:sourceId},data:{status:'FAILED',error:controller.signal.aborted?'Tempo limite de indexação excedido.':failureReason(error)}});throw error;}
  finally{clearTimeout(timer);}
}
export async function redactExpiredAiHistory() {
  const now=new Date(),before=new Date(Date.now()-HISTORY_OFF_TTL);
  const expired={retainHistory:false,OR:[{expiresAt:{lte:now}},{expiresAt:null,createdAt:{lte:before}}]};
  await db.aiCorrection.deleteMany({where:{status:'PENDING',run:expired}});
  await db.aiRun.updateMany({where:{...expired,status:{in:['QUEUED','PROCESSING','SUGGESTED']}},data:{status:'SKIPPED',reason:'Conteúdo temporário expirado.',error:null}});
  await db.aiRun.updateMany({where:{AND:[expired,{OR:[{input:{not:''}},{output:{not:null}},{sources:{not:[]}},{reason:null},{reason:{not:'Conteúdo temporário expirado.'}},{error:{not:null}}]}]},data:{input:'',output:null,sources:[],reason:'Conteúdo temporário expirado.',error:null}});
}
