import { timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { db } from './db';
import { enqueueIncomingAi } from './ai-queue';

export function verifyWebhookChallenge(mode:string|null, token:string|null, challenge:string|null):string|null {
  const expected=process.env.META_VERIFY_TOKEN;
  if(mode!=='subscribe'||!expected||!token||!challenge) return null;
  const a=Buffer.from(token),b=Buffer.from(expected);
  return a.length===b.length && timingSafeEqual(a,b) ? challenge : null;
}
export function isOptOut(text:string):boolean {
  const normalized=text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim().replace(/[.!?]+$/,'').trim();
  return /^(sair|parar|pare|stop|cancelar|cancelamento|remover|excluir|nao contatar|nao me contate)$/.test(normalized)
    || /\b(nao quero receber|pare de (me )?(enviar|mandar)|remova (meu|o meu) (numero|contato)|retire (meu|o meu) (numero|contato))\b/.test(normalized);
}
const rank:Record<string,number>={QUEUED:0,RETRY:0,SUBMITTING:1,UNKNOWN:1,SENT:2,DELIVERED:3,READ:4};
export function nextDeliveryStatus(current:string,incoming:string):string {
  if(incoming==='FAILED') return ['DELIVERED','READ'].includes(current)?current:'FAILED';
  if(current==='FAILED' && incoming==='SENT') return current;
  return (rank[incoming]??-1)>(rank[current]??-1)?incoming:current;
}
async function inbound(connectionId:string, message:any) {
  if(typeof message.id!=='string'||typeof message.from!=='string') return;
  const duplicate=await db.message.findUnique({where:{externalId:message.id},select:{id:true}});
  if(duplicate)return duplicate.id;
  const phone=`+${message.from.replace(/\D/g,'')}`;
  if(!/^\+[1-9]\d{7,14}$/.test(phone)) return;
  const body=message.text?.body||message.button?.text||message.interactive?.button_reply?.title||message.interactive?.list_reply?.title||`[${message.type||'mensagem'} recebida]`;
  const timestamp=Number(message.timestamp)*1000;
  // Never open a 24h window with an invalid/future timestamp.
  const receivedAt=Number.isFinite(timestamp)&&timestamp>0&&timestamp<=Date.now()+30000?new Date(Math.min(timestamp,Date.now())):null;
  try {
    return await db.$transaction(async tx=>{
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${phone}))`;
      const duplicate=await tx.message.findUnique({where:{externalId:message.id},select:{id:true}});
      if(duplicate)return duplicate.id;
      let contact=await tx.contact.findFirst({where:{phone},orderBy:{createdAt:'asc'}});
      if(!contact) {
        const company=await tx.company.create({data:{name:`Contato ${phone}`}});
        contact=await tx.contact.create({data:{companyId:company.id,name:phone,phone,rawPhone:message.from,originalData:{source:'META_WEBHOOK'},stage:'PENDING_AUTHORIZATION'}});
      }
      const existing=await tx.conversation.findUnique({where:{contactId_connectionId:{contactId:contact.id,connectionId}}});
      const lastInboundAt=receivedAt && (!existing?.lastInboundAt || receivedAt>existing.lastInboundAt)?receivedAt:existing?.lastInboundAt;
      const conversation=await tx.conversation.upsert({where:{contactId_connectionId:{contactId:contact.id,connectionId}},create:{contactId:contact.id,connectionId,lastInboundAt:receivedAt,status:'PENDING'},update:{lastInboundAt,status:existing?.status==='CLOSED'?'PENDING':undefined}});
      const stored=await tx.message.create({data:{conversationId:conversation.id,direction:'INBOUND',type:String(message.type||'TEXT').toUpperCase(),body:String(body).slice(0,16384),status:'RECEIVED',externalId:message.id,createdAt:receivedAt||new Date()}});
      if(!isOptOut(String(body))) {
        await tx.contact.updateMany({where:{id:contact.id,doNotContact:false,stage:{in:['PENDING_AUTHORIZATION','ELIGIBLE','IMPORTED','CONTACTED']}},data:{stage:'RESPONDED'}});
        const pendingTask=await tx.task.findFirst({where:{contactId:contact.id,title:'Responder mensagem recebida',completed:false}});
        if(!pendingTask) await tx.task.create({data:{contactId:contact.id,title:'Responder mensagem recebida',dueAt:new Date()}});
      }
      if(isOptOut(String(body))) {
        await tx.suppression.upsert({where:{phone},create:{phone,reason:'Cancelamento solicitado por mensagem recebida.'},update:{reason:'Cancelamento solicitado por mensagem recebida.'}});
        const ids=(await tx.contact.findMany({where:{phone},select:{id:true}})).map(c=>c.id);
        await tx.contact.updateMany({where:{id:{in:ids}},data:{doNotContact:true,stage:'DO_NOT_CONTACT'}});
        await tx.consent.updateMany({where:{contactId:{in:ids},revokedAt:null},data:{revokedAt:new Date()}});
        await tx.recipient.updateMany({where:{contactId:{in:ids},status:{in:['PENDING','RETRY']}},data:{status:'BLOCKED',error:'Destinatário solicitou cancelamento.'}});
        await tx.auditLog.create({data:{action:'OPT_OUT_RECEIVED',entityId:contact.id,metadata:{connectionId}}});
      }
      return stored.id;
    });
  } catch(error) {
    if(error instanceof Prisma.PrismaClientKnownRequestError && error.code==='P2002')return (await db.message.findUnique({where:{externalId:message.id},select:{id:true}}))?.id;
    throw error;
  }
}
async function delivery(connectionId:string,status:any) {
  if(typeof status.id!=='string') return;
  const current=await db.message.findFirst({where:{conversation:{connectionId},OR:[{externalId:status.id},...(typeof status.biz_opaque_callback_data==='string'?[{idempotencyKey:status.biz_opaque_callback_data}]:[])]}});
  if(!current||current.direction!=='OUTBOUND') return;
  const incoming=String(status.status||'').toUpperCase();
  if(!['SENT','DELIVERED','READ','FAILED'].includes(incoming)) return;
  await db.$transaction(async tx=>{
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${current.id}))`;
    const latest=await tx.message.findUniqueOrThrow({where:{id:current.id}});
    const next=nextDeliveryStatus(latest.status,incoming);
    const n=Number(status.timestamp)*1000;
    const date=Number.isFinite(n)&&n>0?new Date(n):new Date();
    const error=incoming==='FAILED'?`Meta reportou falha: ${String(status.errors?.[0]?.code||'não informado')}`:null;
    await tx.message.update({where:{id:current.id},data:{externalId:status.id,status:next,
      ...(incoming==='DELIVERED'&&!latest.deliveredAt?{deliveredAt:date}:{}),
      ...(incoming==='READ'?{readAt:latest.readAt||date,deliveredAt:latest.deliveredAt||date}:{}),
      ...(next==='FAILED'?{error}:{})}});
    await tx.recipient.updateMany({where:{messageId:current.id},data:{status:next,error:next==='FAILED'?error:null}});
  });
}
/** Only call after validating X-Hub-Signature-256 over the original bytes. */
export async function processWebhook(payload:unknown) {
  const data=payload as {object?:string;entry?:Array<{id?:string;changes?:Array<{field?:string;value?:any}>}>};
  if(data?.object!=='whatsapp_business_account'||!Array.isArray(data.entry)) throw new Error('Webhook WhatsApp inválido.');
  let processed=0;
  for(const entry of data.entry) for(const change of entry.changes||[]) {
    const value=change.value||{};
    if(change.field==='message_template_status_update') {
      const status=String(value.event||'').toUpperCase();
      if(['APPROVED','REJECTED','PAUSED','DISABLED','PENDING'].includes(status)&&value.message_template_name) {
        await db.template.updateMany({where:{name:value.message_template_name,language:value.message_template_language||'pt_BR',connection:{wabaId:entry.id||''}},data:{status}});
      }
      continue;
    }
    if(change.field==='phone_number_quality_update') {
      const phoneId=String(value.phone_number_id||value.metadata?.phone_number_id||'');
      const quality=String(value.quality_rating||value.current_quality||value.event||'UNKNOWN').toUpperCase();
      if(phoneId) await db.connection.updateMany({where:{phoneNumberId:phoneId,wabaId:entry.id||''},data:{quality,...(['RED','FLAGGED'].includes(quality)?{enabled:false,status:'RESTRICTED'}:{})}});
      continue;
    }
    const phoneId=value.metadata?.phone_number_id;
    if(typeof phoneId!=='string') continue;
    const connection=await db.connection.findUnique({where:{phoneNumberId:phoneId}});
    if(!connection || (entry.id && connection.wabaId!==entry.id)) continue;
    // Disabled numbers still receive inbound messages and delivery receipts.
    for(const message of value.messages||[]) {
      const storedMessageId=await inbound(connection.id,message);
      if(storedMessageId) {
        try{await enqueueIncomingAi(storedMessageId);}
        catch(error){console.error(JSON.stringify({event:'ai_enqueue_deferred',messageId:storedMessageId,error:error instanceof Error?error.message:'erro'}));}
      }
      processed++;
    }
    for(const status of value.statuses||[]) {await delivery(connection.id,status);processed++;}
  }
  return {processed};
}
