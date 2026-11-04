import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { Prisma } from '@prisma/client';
import { db } from './db';
import { ProviderError, sendTemplate, sendText } from './whatsapp';

export const QUEUE_NAME = 'crm-campaigns';
let queueInstance: Queue | undefined;
let redisInstance: IORedis | undefined;
export function queueRedis() {
  redisInstance ??= new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {maxRetriesPerRequest:null});
  return redisInstance;
}
export function campaignQueue(): Queue {
  queueInstance ??= new Queue(QUEUE_NAME, {connection:queueRedis() as any,defaultJobOptions:{attempts:5,backoff:{type:'exponential',delay:5000},removeOnComplete:1000,removeOnFail:1000}});
  return queueInstance;
}
export async function closeQueues() { await queueInstance?.close(); await redisInstance?.quit(); queueInstance=undefined; redisInstance=undefined; }
export async function emergencyStopped() {
  const setting = await db.setting.findUnique({where:{key:'emergencyStop'}});
  return setting?.value === true;
}
export async function eligibility(contactId: string): Promise<{eligible:boolean;reason:string|null}> {
  const contact = await db.contact.findUnique({where:{id:contactId},include:{consents:{where:{revokedAt:null,grantedAt:{lte:new Date()}}}}});
  if (!contact) return {eligible:false,reason:'Contato inexistente.'};
  if (!contact.phone || !/^\+[1-9]\d{7,14}$/.test(contact.phone)) return {eligible:false,reason:'Telefone internacional válido obrigatório.'};
  if (contact.doNotContact || contact.stage === 'DO_NOT_CONTACT') return {eligible:false,reason:'Contato marcado como não contatar.'};
  if (await db.suppression.findUnique({where:{phone:contact.phone}})) return {eligible:false,reason:'Telefone na lista global de exclusão.'};
  if (!contact.consents.some(c=>c.source.trim() && c.purpose.trim() && c.evidence.trim())) return {eligible:false,reason:'Consentimento documentado não encontrado.'};
  return {eligible:true,reason:null};
}
export interface CreateCampaignInput {
  name:string; connectionId:string; templateId:string; contactIds:string[];
  parameters?:Record<string,string>; scheduledAt?:string; maxBudgetCents?:number;
  costPerMessageCents?:number; ratePerMinute?:number;
}
async function audit(action:string, entityId:string, userId?:string) {
  await db.auditLog.create({data:{action,entityId,userId}});
}
function parameterValues(parameters:Record<string,string>, contact:{name:string;company:{name:string;legalName:string|null;segment:string|null;city:string|null;state:string|null}}):string[] {
  const variables:Record<string,string> = {empresa:contact.company.name,razao_social:contact.company.legalName||contact.company.name,socio:contact.name,segmento:contact.company.segment||'',municipio:contact.company.city||'',uf:contact.company.state||''};
  return Object.entries(parameters).sort(([a],[b])=>Number(a)-Number(b)).map(([,value])=>value.replace(/\{\{\s*(\w+)\s*\}\}/g,(_,key:string)=>variables[key]??''));
}
export function renderTemplateBody(components:unknown,name:string,values:string[]):string {
  const body=Array.isArray(components)?components.find((c:{type?:string})=>c?.type==='BODY')?.text:null;
  return typeof body==='string'?body.replace(/\{\{\s*(\d+)\s*\}\}/g,(_,index:string)=>values[Number(index)-1]||''):`[Modelo ${name}] ${values.join(' / ')}`;
}
export async function createCampaign(input:CreateCampaignInput,userId?:string) {
  const {name,connectionId,templateId}=input;
  if (!name?.trim() || !Array.isArray(input.contactIds) || !input.contactIds.length || input.contactIds.length>20000) throw new Error('Informe nome e de 1 a 20.000 contatos.');
  const template=await db.template.findUniqueOrThrow({where:{id:templateId},include:{connection:true}});
  if (template.connectionId!==connectionId || template.status!=='APPROVED') throw new Error('Selecione um modelo aprovado pertencente à conexão.');
  if (!template.connection.enabled) throw new Error('Conexão desabilitada.');
  const components=template.components as Array<{type?:string;format?:string;text?:string;buttons?:unknown[]}>;
  if (Array.isArray(components) && components.some(c=>(c.type==='BODY' && /\{\{\s*[a-zA-Z_]/.test(c.text||'')) || (c.type==='HEADER' && (c.format!=='TEXT'|| /\{\{/.test(c.text||''))) || c.type==='BUTTONS')) throw new Error('Este MVP envia modelos com corpo de texto, parâmetros posicionais numerados e cabeçalho fixo. Modelos com mídia, botões ou parâmetros nomeados exigem suporte adicional.');
  const parameters=input.parameters||{};
  if (Object.values(parameters).some(v=>typeof v!=='string'||v.length>1024)) throw new Error('Parâmetros inválidos (máximo 1.024 caracteres).');
  const expected=Array.isArray(template.parameterNames)?template.parameterNames.length:0;
  if (Object.keys(parameters).length!==expected || Array.from({length:expected},(_,i)=>String(i+1)).some(k=>!Object.hasOwn(parameters,k))) throw new Error(`O modelo exige ${expected} parâmetros numerados (1, 2, …).`);
  const allowedVariables=new Set(['empresa','razao_social','socio','segmento','municipio','uf']);
  for(const value of Object.values(parameters)) for(const match of value.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) if(!allowedVariables.has(match[1])) throw new Error(`Variável não suportada: ${match[1]}`);
  const scheduledAt=input.scheduledAt?new Date(input.scheduledAt):null;
  if (scheduledAt && Number.isNaN(scheduledAt.getTime())) throw new Error('Data inválida.');
  const maxBudgetCents=input.maxBudgetCents??0, costPerMessageCents=input.costPerMessageCents??0;
  if (!Number.isInteger(maxBudgetCents)||maxBudgetCents<0 || !Number.isInteger(costPerMessageCents)||costPerMessageCents<0) throw new Error('Valores de orçamento devem ser centavos inteiros positivos.');
  if (maxBudgetCents>0 && costPerMessageCents===0) throw new Error('Informe custo conservador por mensagem para aplicar um orçamento.');
  const ratePerMinute=Math.min(Math.max(Math.trunc(input.ratePerMinute??10),1),30,template.connection.ratePerMinute);
  const recipients=[]; const phones=new Set<string>();
  for (const contactId of [...new Set(input.contactIds)]) {
    const check=await eligibility(contactId);
    const contact=await db.contact.findUnique({where:{id:contactId}});
    if (!contact) throw new Error('A lista contém contato inexistente.');
    let reason=check.reason;
    if (contact.phone && phones.has(contact.phone)) reason='Telefone repetido na mesma campanha.';
    if (contact.phone) phones.add(contact.phone);
    recipients.push({contactId,status:reason?'BLOCKED':'PENDING',error:reason});
  }
  const eligible=recipients.filter(r=>r.status==='PENDING').length;
  if (maxBudgetCents>0 && eligible*costPerMessageCents>maxBudgetCents) throw new Error('Custo estimado excede orçamento. Reduza a lista ou aumente o teto.');
  const campaign=await db.campaign.create({data:{name:name.trim(),connectionId,templateId,parameters:parameters as Prisma.InputJsonValue,scheduledAt,maxBudgetCents,costPerMessageCents,ratePerMinute,recipients:{create:recipients}}});
  await audit('CAMPAIGN_CREATED',campaign.id,userId);
  return campaign;
}
export async function enqueueCampaign(campaignId:string) {
  const campaign=await db.campaign.findUniqueOrThrow({where:{id:campaignId},include:{recipients:{where:{status:{in:['PENDING','RETRY','PROCESSING']}}}}});
  if (campaign.status!=='RUNNING') return;
  const queue=campaignQueue();
  for(const recipient of campaign.recipients) {
    const id=`recipient-${recipient.id}`;
    const existing=await queue.getJob(id);
    if(existing) {
      const state=await existing.getState();
      if(state==='completed'||state==='failed') await existing.remove();
      else continue;
    }
    await queue.add('send',{recipientId:recipient.id},{jobId:id,delay:Math.max(0,(campaign.scheduledAt?.getTime()||0)-Date.now())});
  }
}
export async function campaignAction(id:string,action:'start'|'pause'|'resume'|'cancel',userId?:string) {
  const campaign=await db.campaign.findUniqueOrThrow({where:{id},include:{template:true,connection:true}});
  if(['start','resume'].includes(action)) {
    if(await emergencyStopped()) throw new Error('Suspensão emergencial ativa.');
    if(!campaign.connection.enabled || campaign.template.status!=='APPROVED') throw new Error('Conexão ativa e modelo aprovado obrigatórios.');
    if(action==='start' && campaign.status!=='DRAFT') throw new Error('Só campanhas em rascunho podem iniciar.');
    if(action==='resume' && campaign.status!=='PAUSED') throw new Error('Só campanhas pausadas podem retomar.');
    await db.campaign.update({where:{id},data:{status:'RUNNING'}});
    await enqueueCampaign(id);
  } else if(action==='pause') {
    if(campaign.status!=='RUNNING') throw new Error('A campanha não está em execução.');
    await db.campaign.update({where:{id},data:{status:'PAUSED'}});
  } else if(action==='cancel') {
    if(['COMPLETED','CANCELED'].includes(campaign.status)) throw new Error('Campanha já encerrada.');
    await db.$transaction([db.campaign.update({where:{id},data:{status:'CANCELED'}}),db.recipient.updateMany({where:{campaignId:id,status:{in:['PENDING','RETRY']}},data:{status:'CANCELED',error:'Campanha cancelada.'}})]);
  } else throw new Error('Ação inválida.');
  await audit(`CAMPAIGN_${action.toUpperCase()}`,id,userId);
  return db.campaign.findUniqueOrThrow({where:{id}});
}
export async function setEmergencyStop(enabled:boolean,userId?:string) {
  await db.$transaction(async tx=>{
    await tx.setting.upsert({where:{key:'emergencyStop'},create:{key:'emergencyStop',value:enabled},update:{value:enabled}});
    if(enabled) await tx.campaign.updateMany({where:{status:'RUNNING'},data:{status:'PAUSED'}});
    await tx.auditLog.create({data:{action:enabled?'EMERGENCY_STOP':'EMERGENCY_RELEASE',userId}});
  });
}
export async function completeCampaign(campaignId:string) {
  const pending=await db.recipient.count({where:{campaignId,status:{in:['PENDING','RETRY','PROCESSING']}}});
  if(!pending) await db.campaign.updateMany({where:{id:campaignId,status:'RUNNING'},data:{status:'COMPLETED'}});
}
async function waitForRate(connectionId:string,rate:number) {
  const delay=Math.ceil(60000/Math.max(1,Math.min(rate,30)));
  while(!await queueRedis().set(`crm-rate-${connectionId}`,'1','PX',delay,'NX')) await new Promise(resolve=>setTimeout(resolve,250));
}
export async function processRecipient(recipientId:string) {
  let recipient=await db.recipient.findUniqueOrThrow({where:{id:recipientId},include:{campaign:{include:{connection:true,template:true}},contact:{include:{company:true}},message:true}});
  const {campaign,contact}=recipient;
  if(campaign.status!=='RUNNING'||await emergencyStopped()) return;
  if(!['PENDING','RETRY','PROCESSING'].includes(recipient.status)) return;
  if(recipient.status==='PROCESSING') {
    // A previous attempt may have reached Meta. Never submit it a second time.
    await db.recipient.updateMany({where:{id:recipientId,status:'PROCESSING'},data:{status:'UNKNOWN',error:'Processo interrompido; confirme o resultado na Meta antes de nova campanha.'}});
    if(recipient.messageId) await db.message.updateMany({where:{id:recipient.messageId,status:'SUBMITTING'},data:{status:'UNKNOWN',error:'Processo interrompido durante envio.'}});
    await completeCampaign(campaign.id);return;
  }
  if(campaign.scheduledAt && campaign.scheduledAt.getTime()>Date.now()) throw new Error('Campanha ainda não está agendada para execução.');
  await waitForRate(campaign.connectionId,Math.min(campaign.ratePerMinute,campaign.connection.ratePerMinute));
  const fresh=await db.campaign.findUniqueOrThrow({where:{id:campaign.id},include:{connection:true,template:true}});
  if(fresh.status!=='RUNNING'||await emergencyStopped()) return;
  const eligible=await eligibility(contact.id);
  if(!eligible.eligible || !fresh.connection.enabled || fresh.template.status!=='APPROVED') {
    await db.recipient.updateMany({where:{id:recipientId,status:{in:['PENDING','RETRY']}},data:{status:'BLOCKED',error:eligible.reason||'Conexão desabilitada ou modelo não aprovado.'}});
    await completeCampaign(campaign.id);return;
  }
  const key=`campaign-${campaign.id}-${createHash('sha256').update(contact.phone!).digest('hex').slice(0,24)}`;
  const values=parameterValues((campaign.parameters||{}) as Record<string,string>,contact);
  const message=await db.$transaction(async tx=>{
    // Serialize budget reservation across workers/connections. No network request inside the transaction.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${campaign.id}))`;
    const current=await tx.recipient.findUniqueOrThrow({where:{id:recipientId}});
    if(!['PENDING','RETRY'].includes(current.status)) return null;
    if(fresh.maxBudgetCents>0) {
      const reserved=await tx.recipient.count({where:{campaignId:campaign.id,status:{in:['PROCESSING','SENT','DELIVERED','READ','UNKNOWN']}}});
      if((reserved+1)*fresh.costPerMessageCents>fresh.maxBudgetCents) {
        await tx.recipient.update({where:{id:recipientId},data:{status:'BLOCKED',error:'Teto de orçamento atingido.'}});return null;
      }
    }
    const conversation=await tx.conversation.upsert({where:{contactId_connectionId:{contactId:contact.id,connectionId:campaign.connectionId}},create:{contactId:contact.id,connectionId:campaign.connectionId},update:{}});
    const existing=await tx.message.findUnique({where:{idempotencyKey:key}});
    if(existing && !['RETRY','QUEUED'].includes(existing.status)) {
      await tx.recipient.update({where:{id:recipientId},data:{status:existing.status,messageId:existing.id}});return null;
    }
    const result=existing ? await tx.message.update({where:{id:existing.id},data:{status:'SUBMITTING',error:null}}) : await tx.message.create({data:{conversationId:conversation.id,direction:'OUTBOUND',type:'TEMPLATE',body:renderTemplateBody(campaign.template.components,campaign.template.name,values),status:'SUBMITTING',idempotencyKey:key}});
    await tx.recipient.update({where:{id:recipientId},data:{status:'PROCESSING',messageId:result.id,attempts:{increment:1}}});return result;
  });
  if(!message) {await completeCampaign(campaign.id);return;}
  try {
    // Check suppression again after reserving the send; a revocation while waiting is honored.
    const latest=await eligibility(contact.id);
    if(!latest.eligible) {
      await db.$transaction([db.message.update({where:{id:message.id},data:{status:'BLOCKED',error:latest.reason}}),db.recipient.update({where:{id:recipientId},data:{status:'BLOCKED',error:latest.reason}})]);return;
    }
    if(await emergencyStopped()) {
      await db.$transaction([db.message.update({where:{id:message.id},data:{status:'QUEUED',error:'Suspensão emergencial.'}}),db.recipient.update({where:{id:recipientId},data:{status:'PENDING',error:'Suspensão emergencial.'}})]);return;
    }
    const finalState=await db.campaign.findUniqueOrThrow({where:{id:campaign.id},include:{connection:true,template:true}});
    const finalContact=await db.contact.findUniqueOrThrow({where:{id:contact.id}});
    if(finalState.status!=='RUNNING') {
      const recipientStatus=finalState.status==='CANCELED'?'CANCELED':'PENDING';
      const messageStatus=finalState.status==='CANCELED'?'CANCELED':'QUEUED';
      await db.$transaction([db.message.update({where:{id:message.id},data:{status:messageStatus,error:'Campanha pausada/cancelada.'}}),db.recipient.update({where:{id:recipientId},data:{status:recipientStatus,error:'Campanha pausada/cancelada.'}})]);return;
    }
    if(finalContact.phone!==contact.phone) {
      await db.$transaction([db.message.update({where:{id:message.id},data:{status:'BLOCKED',error:'Telefone alterado durante preparação.'}}),db.recipient.update({where:{id:recipientId},data:{status:'BLOCKED',error:'Telefone alterado durante preparação.'}})]);return;
    }
    const externalId=await sendTemplate(finalState.connection,finalState.template,contact.phone!,values,key);
    await finalizeSuccess(message.id,externalId);
    await db.contact.updateMany({where:{id:contact.id,stage:{in:['PENDING_AUTHORIZATION','ELIGIBLE','IMPORTED']}},data:{stage:'CONTACTED'}});
  } catch(error) {
    const confirmed=await db.message.findUniqueOrThrow({where:{id:message.id}});
    if(['SENT','DELIVERED','READ'].includes(confirmed.status)&&confirmed.externalId) return;
    const provider=error instanceof ProviderError ? error : new ProviderError('Resultado não confirmado; reconciliação necessária.','UNKNOWN',false,true);
    const attempts=(await db.recipient.findUniqueOrThrow({where:{id:recipientId}})).attempts;
    const status=provider.ambiguous?'UNKNOWN':provider.retryable&&attempts<5?'RETRY':'FAILED';
    await db.$transaction([db.message.update({where:{id:message.id},data:{status,error:provider.message}}),db.recipient.update({where:{id:recipientId},data:{status,error:provider.message}})]);
    if(status==='RETRY') throw provider;
  } finally {await completeCampaign(campaign.id);}
}

async function finalizeSuccess(messageId:string,externalId:string) {
  return db.$transaction(async tx=>{
    // A delivery webhook can arrive before the HTTP send response. Preserve advanced delivery state.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${messageId}))`;
    const current=await tx.message.findUniqueOrThrow({where:{id:messageId}});
    const status=['DELIVERED','READ','FAILED'].includes(current.status)?current.status:'SENT';
    const result=await tx.message.update({where:{id:messageId},data:{externalId,status}});
    await tx.recipient.updateMany({where:{messageId},data:{status,error:current.error}});
    return result;
  });
}
export async function replyToConversation(conversationId:string,text:string,idempotencyKey:string,userId?:string,guard?:()=>Promise<void>) {
  if(!text?.trim()||text.length>4096||!idempotencyKey||idempotencyKey.length>200) throw new Error('Mensagem ou identificador inválido.');
  const conversation=await db.conversation.findUniqueOrThrow({where:{id:conversationId},include:{connection:true,contact:true}});
  const eligible=await eligibility(conversation.contactId);
  if(!eligible.eligible) throw new Error(eligible.reason!);
  if(await emergencyStopped()) throw new Error('Suspensão emergencial ativa.');
  if(!conversation.lastInboundAt||Date.now()-conversation.lastInboundAt.getTime()>=86400000) throw new Error('Janela de atendimento de 24 horas encerrada. Utilize modelo aprovado em campanha.');
  const key=`reply-${idempotencyKey}`;
  const previous=await db.message.findUnique({where:{idempotencyKey:key}});
  if(previous) {
    if(previous.conversationId!==conversationId) throw new Error('Identificador já usado em outra conversa.');
    return previous;
  }
  await waitForRate(conversation.connectionId,conversation.connection.ratePerMinute);
  const nowEligible=await eligibility(conversation.contactId);
  if(!nowEligible.eligible||await emergencyStopped()) throw new Error(nowEligible.reason||'Suspensão emergencial ativa.');
  const freshConversation=await db.conversation.findUniqueOrThrow({where:{id:conversationId},include:{connection:true,contact:true}});
  if(!freshConversation.lastInboundAt||Date.now()-freshConversation.lastInboundAt.getTime()>=86400000) throw new Error('Janela de atendimento de 24 horas encerrada.');
  if(!freshConversation.connection.enabled||['RED','FLAGGED'].includes(freshConversation.connection.quality)) throw new Error('Conexão desabilitada ou qualidade restrita.');
  if(freshConversation.contact.phone!==conversation.contact.phone) throw new Error('Telefone alterado durante a preparação do envio. Tente novamente.');
  if(guard)await guard();
  const message=await db.message.create({data:{conversationId,direction:'OUTBOUND',type:'TEXT',body:text.trim(),status:'SUBMITTING',idempotencyKey:key}});
  try {
    const externalId=await sendText(freshConversation.connection,freshConversation.contact.phone!,text.trim(),key);
    const result=await finalizeSuccess(message.id,externalId);
    await audit('MESSAGE_SENT',message.id,userId);return result;
  } catch(error) {
    const confirmed=await db.message.findUniqueOrThrow({where:{id:message.id}});
    if(['SENT','DELIVERED','READ'].includes(confirmed.status)&&confirmed.externalId) return confirmed;
    const provider=error instanceof ProviderError?error:new ProviderError('Resultado não confirmado.','UNKNOWN',false,true);
    await db.message.update({where:{id:message.id},data:{status:provider.ambiguous?'UNKNOWN':'FAILED',error:provider.message}});throw provider;
  }
}
export async function reconcileCampaigns() {
  const running=await db.campaign.findMany({where:{status:'RUNNING'},select:{id:true}});
  for(const campaign of running) {await enqueueCampaign(campaign.id);await completeCampaign(campaign.id);}
}
