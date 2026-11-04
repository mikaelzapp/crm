import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { readLimitedBody } from '@/lib/api';
import { getUser, login, logout, assertMutationOrigin } from '@/lib/auth';
import { parseCsv, importContacts, normalizeBrazilianPhone } from '@/lib/csv';
import { encryptSecret, verifyWebhookSignature } from '@/lib/crypto';
import { syncTemplates, verifyConnection } from '@/lib/whatsapp';
import { createCampaign, campaignAction, replyToConversation, setEmergencyStop } from '@/lib/campaigns';
import { processWebhook, verifyWebhookChallenge } from '@/lib/webhooks';
import ExcelJS from 'exceljs';
import { compare, hash } from 'bcryptjs';
import IORedis from 'ioredis';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const MAX_UPLOAD = 20 * 1024 * 1024;
const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
const text = z.string().trim().min(1).max(500);
const optionalText = z.string().trim().max(500).optional();
const stage = z.enum(['IMPORTED','PENDING_AUTHORIZATION','ELIGIBLE','CONTACTED','RESPONDED','INTERESTED','NEGOTIATION','CUSTOMER','LOST','DO_NOT_CONTACT']);
const connectionSelect = { id:true, name:true, phone:true, wabaId:true, phoneNumberId:true, enabled:true, status:true, quality:true, mode:true, ratePerMinute:true, createdAt:true, updatedAt:true } as const;
const userSelect = { id:true, email:true, name:true, role:true } as const;
const contactInclude = { company:true, consents: { orderBy: { grantedAt:'desc' as const } } };

async function body(request: Request) {
  try { const raw = await readLimitedBody(request, 1024 * 1024); return JSON.parse(raw.toString('utf8')); }
  catch (e) { if ((e as {status?:number}).status) throw e; return fail('JSON inválido.'); }
}
async function audit(userId: string, action: string, entityId?: string, metadata: Prisma.InputJsonValue = {}) {
  await db.auditLog.create({ data: { userId, action, entityId, metadata } });
}
async function dashboard() {
  const [companies, contacts, connections, campaigns, sent, delivered, responses, optOuts, groups, recentImports, recentCampaigns, candidates, suppressions] = await Promise.all([
    db.company.count(), db.contact.count(), db.connection.count({where:{enabled:true,status:'CONNECTED'}}),
    db.campaign.count({where:{status:{in:['RUNNING','SCHEDULED']}}}),
    db.message.count({where:{direction:'OUTBOUND',status:{in:['SENT','DELIVERED','READ']}}}),
    db.message.count({where:{direction:'OUTBOUND',status:{in:['DELIVERED','READ']}}}),
    db.message.count({where:{direction:'INBOUND'}}), db.suppression.count(),
    db.contact.groupBy({by:['stage'],_count:{_all:true}}),
    db.importBatch.findMany({orderBy:{createdAt:'desc'},take:5}),
    db.campaign.findMany({orderBy:{createdAt:'desc'},take:5,include:{connection:{select:connectionSelect},_count:{select:{recipients:true}}}}),
    db.contact.findMany({where:{doNotContact:false,stage:{not:'DO_NOT_CONTACT'},phone:{not:null},consents:{some:{revokedAt:null,grantedAt:{lte:new Date()}}}},select:{phone:true,consents:{where:{revokedAt:null,grantedAt:{lte:new Date()}},select:{source:true,purpose:true,evidence:true}}}}),
    db.suppression.findMany({select:{phone:true}}),
  ]);
  const blocked = new Set(suppressions.map(x=>x.phone));
  const eligible = candidates.filter(c=>c.phone && /^\+[1-9]\d{7,14}$/.test(c.phone) && !blocked.has(c.phone) && c.consents.some(x=>x.source.trim()&&x.purpose.trim()&&x.evidence.trim())).length;
  const [contactedConversations,answeredConversations,interested,conversions,validContacts] = await Promise.all([db.conversation.count({where:{messages:{some:{direction:'OUTBOUND',status:{in:['SENT','DELIVERED','READ']}}}}}),db.conversation.count({where:{AND:[{messages:{some:{direction:'OUTBOUND',status:{in:['SENT','DELIVERED','READ']}}}},{messages:{some:{direction:'INBOUND'}}}]}}),db.contact.count({where:{stage:{in:['INTERESTED','NEGOTIATION']}}}),db.contact.count({where:{stage:'CUSTOMER'}}),db.contact.count({where:{phone:{not:null}}})]);
  return {companies,contacts,eligible,connections,campaigns,sent,delivered,responses,optOuts,stages:groups.map(x=>({stage:x.stage,count:x._count._all})),recentImports,recentCampaigns,responseRate:contactedConversations ? Math.round(answeredConversations/contactedConversations*100) : 0,interested,conversions,validContacts};
}
function csvCell(value: unknown) {
  let s = String(value ?? ''); if (/^[\s]*[=+@\-\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"','""')}"`;
}
async function uploaded(request: NextRequest) {
  const bytes = await readLimitedBody(request, MAX_UPLOAD + 100000);
  let form: FormData;
  try { form = await new Response(new Uint8Array(bytes), {headers: {'Content-Type': request.headers.get('content-type') || ''}}).formData(); }
  catch { fail('Envie um formulário multipart válido contendo o CSV.'); }
  const file = form.get('file');
  if (!(file instanceof File) || !file.size) fail('Selecione um arquivo CSV.');
  if (file.size > MAX_UPLOAD) fail('CSV excede o limite de 20 MB.',413);
  let mapping: Record<string,string> | undefined;
  if (form.get('mapping')) {
    try { mapping = z.record(z.string(),z.string().max(500)).parse(JSON.parse(String(form.get('mapping')))); }
    catch { fail('Mapeamento de colunas inválido.'); }
  }
  return {buffer:Buffer.from(await file.arrayBuffer()),fileName:file.name.slice(0,255),mapping};
}

type Context = { params: Promise<{ path: string[] }> };
async function handler(request: NextRequest, context: Context) {
  try {
    const {path} = await context.params; const [resource,id,sub] = path; const method = request.method; const url = new URL(request.url);
    if (resource === 'webhooks' || resource === 'webhook') {
      if (method === 'GET') {
        const challenge = verifyWebhookChallenge(url.searchParams.get('hub.mode'),url.searchParams.get('hub.verify_token'),url.searchParams.get('hub.challenge'));
        return challenge === null ? new Response('Verificação negada',{status:403}) : new Response(challenge);
      }
      if (method !== 'POST') return json({error:'Método não permitido.'},405);
      const raw = await readLimitedBody(request, 1024 * 1024);
      if (!verifyWebhookSignature(raw,request.headers.get('x-hub-signature-256'))) fail('Assinatura de webhook inválida.',403);
      let payload:unknown; try { payload=JSON.parse(raw.toString('utf8')); } catch { fail('JSON inválido.'); }
      await processWebhook(payload);
      return json({received:true});
    }
    if (resource === 'health' && method === 'GET') {
      let redis: IORedis | undefined;
      try {
        await db.$queryRaw`SELECT 1`;
        redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379',{connectTimeout:2000,maxRetriesPerRequest:1,retryStrategy:()=>null,lazyConnect:true});
        redis.on('error',()=>{}); await redis.connect(); await redis.ping();
        return json({status:'ok',database:'ok',queue:'ok',mode:process.env.WHATSAPP_MODE || 'mock'});
      } catch { return json({status:'unavailable'},503); } finally { redis?.disconnect(); }
    }
    if (method !== 'GET') assertMutationOrigin(request);
    if (resource === 'auth' && id === 'login' && method === 'POST') {
      const input=z.object({email:z.string().email().max(254),password:z.string().min(1).max(200)}).parse(await body(request));
      return await login(request,input.email,input.password);
    }
    if (resource === 'auth' && id === 'logout' && method === 'POST') return await logout(request);
    const user = await getUser(request);
    if (resource === 'session' && method === 'GET') return json({user:user ? {id:user.id,email:user.email,name:user.name,role:user.role} : null,mode:process.env.WHATSAPP_MODE || 'mock'});
    if (!user) fail('Faça login para continuar.',401);
    const currentUser = user!;
    const admin = () => { if(currentUser.role !== 'ADMIN') fail('Acesso restrito a administradores.',403); };

    if (resource === 'dashboard' && method === 'GET') return json(await dashboard());
    if (resource === 'reports' && method === 'GET') {
      const summary=await dashboard();
      const connections=await db.connection.findMany({select:connectionSelect});
      const byNumber=await Promise.all(connections.map(async connection=>({connection,sent:await db.message.count({where:{conversation:{connectionId:connection.id},direction:'OUTBOUND',status:{in:['SENT','DELIVERED','READ']}}}),delivered:await db.message.count({where:{conversation:{connectionId:connection.id},direction:'OUTBOUND',status:{in:['DELIVERED','READ']}}}),read:await db.message.count({where:{conversation:{connectionId:connection.id},direction:'OUTBOUND',status:'READ'}}),responses:await db.message.count({where:{conversation:{connectionId:connection.id},direction:'INBOUND'}})})));
      const campaigns=await db.campaign.findMany({include:{connection:{select:connectionSelect},recipients:{select:{status:true}}},orderBy:{createdAt:'desc'},take:500});
      const byCampaign=campaigns.map(c=>({id:c.id,name:c.name,status:c.status,connection:c.connection,total:c.recipients.length,sent:c.recipients.filter(r=>['SENT','DELIVERED','READ'].includes(r.status)).length,delivered:c.recipients.filter(r=>['DELIVERED','READ'].includes(r.status)).length,blocked:c.recipients.filter(r=>r.status==='BLOCKED').length,failed:c.recipients.filter(r=>['FAILED','UNKNOWN'].includes(r.status)).length,estimatedCostCents:c.recipients.filter(r=>['SENT','DELIVERED','READ','UNKNOWN'].includes(r.status)).length*c.costPerMessageCents,maxBudgetCents:c.maxBudgetCents}));
      return json({...summary,byNumber,byCampaign,costSource:'Estimativa operacional configurada pelo usuário; não representa faturamento confirmado pela Meta.'});
    }
    if(resource==='auth' && id==='password' && method==='POST'){
      const input=z.object({currentPassword:z.string().min(1).max(200),password:z.string().min(12).max(200)}).parse(await body(request));
      const account=await db.user.findUniqueOrThrow({where:{id:user.id}});if(!await compare(input.currentPassword,account.passwordHash))fail('Senha atual incorreta.',403);
      await db.$transaction([db.user.update({where:{id:user.id},data:{passwordHash:await hash(input.password,12)}}),db.session.deleteMany({where:{userId:user.id}})]);await audit(user.id,'PASSWORD_CHANGED',user.id);return logout(request);
    }
    if (resource === 'events' && method === 'GET') {
      const encoder=new TextEncoder(); let timer:ReturnType<typeof setInterval>;
      const stream=new ReadableStream({start(controller){
        let count=0; const send=()=>{try{controller.enqueue(encoder.encode(`data: ${JSON.stringify({event:'refresh',timestamp:Date.now()})}\n\n`)); if(++count>=30){clearInterval(timer);controller.close();}}catch{clearInterval(timer);}};
        send(); timer=setInterval(send,10000);
        request.signal.addEventListener('abort',()=>{clearInterval(timer);try{controller.close();}catch{}},{once:true});
      },cancel(){clearInterval(timer);}});
      return new Response(stream,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive'}});
    }
    if (resource === 'contacts') {
      if (!id && method === 'GET') {
        const q=(url.searchParams.get('q')||'').slice(0,150); const take=Math.min(200,Math.max(1,Math.trunc(Number(url.searchParams.get('limit')))||100)); const page=Math.min(100000,Math.max(1,Math.trunc(Number(url.searchParams.get('page')))||1));
        const company: Prisma.CompanyWhereInput = {};
        for(const key of ['city','state','segment'] as const) if(url.searchParams.get(key)) company[key]={equals:url.searchParams.get(key)!.slice(0,100),mode:'insensitive'};
        const where:Prisma.ContactWhereInput={company};
        if(q) where.OR=[{name:{contains:q,mode:'insensitive'}},{phone:{contains:q}},{company:{name:{contains:q,mode:'insensitive'}}},{company:{cnpj:{contains:q}}}];
        if(url.searchParams.get('priority')) where.priority=url.searchParams.get('priority');
        if(url.searchParams.get('stage')) where.stage=url.searchParams.get('stage')!;
        const [contacts,total]=await Promise.all([db.contact.findMany({where,include:contactInclude,orderBy:{createdAt:'desc'},take,skip:(page-1)*take}),db.contact.count({where})]);
        return json({contacts,total,page});
      }
      if (!id && method === 'POST') {
        const input=z.object({companyName:text,name:text,phone:optionalText,email:z.union([z.string().email(),z.literal('')]).optional(),city:optionalText,state:z.string().max(2).optional(),segment:optionalText,priority:optionalText,messageDraft:z.string().max(10000).optional()}).parse(await body(request));
        const normalized=input.phone ? normalizeBrazilianPhone(input.phone) : null;
        if(input.phone && !normalized) fail('Telefone brasileiro inválido.');
        const result=await db.company.create({data:{name:input.companyName,city:input.city,state:input.state,segment:input.segment,contacts:{create:{name:input.name,phone:normalized,rawPhone:input.phone,email:input.email||null,priority:input.priority,messageDraft:input.messageDraft}}},include:{contacts:true}});
        await audit(user.id,'CONTACT_CREATED',result.contacts[0].id); return json({contact:result.contacts[0]},201);
      }
      if(id && !sub && method==='GET') {
        const contact=await db.contact.findUnique({where:{id},include:{...contactInclude,messageDraftVersions:{orderBy:{createdAt:'desc'},take:50},notes:{include:{author:{select:userSelect}},orderBy:{createdAt:'desc'}},tasks:{orderBy:{createdAt:'desc'}}}});
        if(!contact) fail('Contato não encontrado.',404); return json({contact});
      }
      if(id && !sub && method==='PATCH') {
        const input=z.object({name:text.optional(),email:z.union([z.string().email(),z.literal('')]).optional(),phone:z.string().trim().max(100).nullable().optional(),company:z.object({name:text.optional(),legalName:optionalText.nullable(),city:optionalText.nullable(),state:z.string().trim().max(2).nullable().optional(),segment:optionalText.nullable()}).strict().optional(),messageDraft:z.string().max(10000).optional(),priority:optionalText,stage:stage.optional(),doNotContact:z.boolean().optional(),tags:z.array(z.string().max(50)).max(30).optional(),potentialValueCents:z.number().int().min(0).max(1000000000).optional()}).strict().parse(await body(request));
        const manualBlock=input.doNotContact===true || input.stage==='DO_NOT_CONTACT';
        const normalizedPhone=input.phone===undefined?undefined:normalizeBrazilianPhone(input.phone);
        if(input.phone && !normalizedPhone) fail('Telefone brasileiro inválido.');
        const contact=await db.$transaction(async tx=>{
          const previous=await tx.contact.findUniqueOrThrow({where:{id}});
          const phoneChanged=normalizedPhone!==undefined && normalizedPhone!==previous.phone;
          const {company,phone,...fields}=input;
          if(company) await tx.company.update({where:{id:previous.companyId},data:company});
          if(input.messageDraft!==undefined && previous.messageDraft!==input.messageDraft)await tx.messageDraftVersion.create({data:{contactId:id,body:previous.messageDraft||'',authorId:user.id}});
          let phoneChangeData: Prisma.ContactUpdateInput={};
          if(phoneChanged){
            const suppressed=normalizedPhone?await tx.suppression.findUnique({where:{phone:normalizedPhone}}):null;
            const blocked=Boolean(previous.doNotContact || previous.stage==='DO_NOT_CONTACT' || input.doNotContact || input.stage==='DO_NOT_CONTACT' || suppressed);
            const original=(previous.originalData && typeof previous.originalData==='object' && !Array.isArray(previous.originalData)?previous.originalData:{}) as Prisma.JsonObject;
            const history=Array.isArray(original._crmPhoneHistory)?original._crmPhoneHistory:[];
            phoneChangeData={phone:normalizedPhone,rawPhone:phone||null,doNotContact:blocked,stage:blocked?'DO_NOT_CONTACT':'PENDING_AUTHORIZATION',originalData:{...original,_crmPhoneHistory:[...history,{oldPhone:previous.phone,oldRawPhone:previous.rawPhone,newPhone:normalizedPhone,changedAt:new Date().toISOString(),userId:user.id}]}};
            await tx.$executeRaw`SELECT "id" FROM "Contact" WHERE "id" = ${id} FOR UPDATE`;
            const aiConversations=await tx.conversation.findMany({where:{contactId:id},select:{id:true},orderBy:{id:'asc'}});
            const conversationIds=aiConversations.map(conversation=>conversation.id);
            for(const conversationId of conversationIds)await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-permission-${conversationId}`}))`;
            const corrections=await tx.aiCorrection.findMany({where:{run:{conversationId:{in:conversationIds}}},select:{sourceId:true}});
            const derivedSourceIds=corrections.flatMap(correction=>correction.sourceId?[correction.sourceId]:[]);
            if(derivedSourceIds.length)await tx.knowledgeSource.deleteMany({where:{id:{in:derivedSourceIds}}});
            await tx.aiCorrection.deleteMany({where:{run:{conversationId:{in:conversationIds}}}});
            await tx.aiConversationPermission.updateMany({where:{conversationId:{in:conversationIds}},data:{allowed:false,revokedAt:new Date()}});
            await tx.aiRun.updateMany({where:{conversationId:{in:conversationIds},status:{in:['QUEUED','PROCESSING','SUGGESTED']}},data:{status:'CANCELED'}});
            await tx.aiRun.updateMany({where:{conversationId:{in:conversationIds}},data:{input:'',output:null,sources:[],reason:'Conteúdo removido após alteração do telefone. Nova autorização de IA é necessária.',error:null,retainHistory:false,expiresAt:new Date()}});
            await tx.consent.updateMany({where:{contactId:id,revokedAt:null},data:{revokedAt:new Date()}});
            await tx.recipient.updateMany({where:{contactId:id,status:{in:['PENDING','RETRY']}},data:{status:'BLOCKED',error:'Telefone alterado; nova autorização e nova seleção de destinatário são necessárias.'}});
            // Neither the service window nor the AI authorization belongs to the new phone.
            await tx.conversation.updateMany({where:{contactId:id},data:{lastInboundAt:null,aiPaused:true}});
          }
          const c=await tx.contact.update({where:{id},data:{...fields,...(normalizedPhone!==undefined?{phone:normalizedPhone,rawPhone:phone||null}:{}),...(manualBlock?{stage:'DO_NOT_CONTACT',doNotContact:true}:{}),...phoneChangeData}});
          if(manualBlock && c.phone){await tx.suppression.upsert({where:{phone:c.phone},create:{phone:c.phone,reason:'Bloqueio manual'},update:{reason:'Bloqueio manual'}});await tx.consent.updateMany({where:{contactId:id,revokedAt:null},data:{revokedAt:new Date()}});}
          return c;
        }); await audit(user.id,'CONTACT_UPDATED',id); return json({contact});
      }
      if(id && !sub && method==='DELETE') {
        admin(); await db.$transaction(async tx=>{
          const contact=await tx.contact.findUniqueOrThrow({where:{id}});
          if(contact.phone) await tx.suppression.upsert({where:{phone:contact.phone},create:{phone:contact.phone,reason:'Exclusão de dados solicitada'},update:{reason:'Exclusão de dados solicitada'}});
          // Serialize new conversation references and correction approvals before collecting derived material.
          await tx.$executeRaw`SELECT "id" FROM "Contact" WHERE "id" = ${id} FOR UPDATE`;
          const aiConversations=await tx.conversation.findMany({where:{contactId:id},select:{id:true},orderBy:{id:'asc'}});
          for(const conversation of aiConversations)await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-permission-${conversation.id}`}))`;
          // Curated conversation excerpts belong to the agent, so remove them before the contact cascade loses their provenance.
          const aiCorrections=await tx.aiCorrection.findMany({where:{run:{conversation:{contactId:id}}},select:{sourceId:true}});
          const derivedSourceIds=aiCorrections.flatMap(correction=>correction.sourceId?[correction.sourceId]:[]);
          if(derivedSourceIds.length)await tx.knowledgeSource.deleteMany({where:{id:{in:derivedSourceIds}}});
          await tx.importRow.deleteMany({where:{contactId:id}});
          await tx.contact.delete({where:{id}});
          if(await tx.contact.count({where:{companyId:contact.companyId}})===0) await tx.company.delete({where:{id:contact.companyId}});
        }); await audit(user.id,'CONTACT_ERASED',id);return json({deleted:true});
      }
      if(id && sub==='consent' && method==='POST') {
        admin();const input=z.object({source:z.string().trim().min(3).max(500),purpose:z.string().trim().min(3).max(1000),evidence:z.string().trim().min(3).max(10000)}).strict().parse(await body(request));
        const consent=await db.$transaction(async tx=>{const c=await tx.contact.findUniqueOrThrow({where:{id}});if(!c.phone) fail('Registre um telefone válido antes do opt-in.');await tx.consent.updateMany({where:{contactId:id,revokedAt:null},data:{revokedAt:new Date()}});if(c.phone) await tx.suppression.deleteMany({where:{phone:c.phone}});await tx.contact.update({where:{id},data:{doNotContact:false,stage:'ELIGIBLE'}});return tx.consent.create({data:{...input,contactId:id}});});
        await audit(user.id,'CONSENT_GRANTED',id);return json({consent},201);
      }
      if(id && sub==='consent' && method==='DELETE') {
        admin(); await db.$transaction(async tx=>{const c=await tx.contact.findUniqueOrThrow({where:{id}});await tx.consent.updateMany({where:{contactId:id,revokedAt:null},data:{revokedAt:new Date()}});await tx.contact.update({where:{id},data:{doNotContact:true,stage:'DO_NOT_CONTACT'}});if(c.phone)await tx.suppression.upsert({where:{phone:c.phone},create:{phone:c.phone,reason:'Consentimento revogado'},update:{reason:'Consentimento revogado'}});});
        await audit(user.id,'CONSENT_REVOKED',id);return json({revoked:true});
      }
      if(id && sub==='notes' && method==='POST') {const input=z.object({body:z.string().trim().min(1).max(10000)}).parse(await body(request));const note=await db.note.create({data:{contactId:id,authorId:user.id,body:input.body}});await audit(user.id,'NOTE_CREATED',id);return json({note},201);}
      if(id && sub==='tasks' && method==='POST') {const input=z.object({title:text,dueAt:z.string().datetime().optional()}).parse(await body(request));const task=await db.task.create({data:{contactId:id,title:input.title,dueAt:input.dueAt}});await audit(user.id,'TASK_CREATED',id);return json({task},201);}
    }
    if(resource==='tasks') {
      if(method==='GET') return json({tasks:await db.task.findMany({include:{contact:{include:{company:true}}},orderBy:{createdAt:'desc'},take:200})});
      if(method==='PATCH' && id){const input=z.object({completed:z.boolean()}).parse(await body(request));return json({task:await db.task.update({where:{id},data:input})});}
    }
    if(resource==='imports') {
      if(method==='GET')return json({imports:await db.importBatch.findMany({orderBy:{createdAt:'desc'},take:100})});
      if(method==='POST'){admin();const file=await uploaded(request);let parsed:ReturnType<typeof parseCsv>;try{parsed=parseCsv(file.buffer,file.mapping);if(id!=='preview'&&!parsed.suggestedMapping.companyName)fail('Mapeie a coluna Empresa antes de importar.');}catch(error){fail((error as Error).message||'CSV inválido.',400);}if(id==='preview')return json({...parsed,rows:parsed.rows.slice(0,5)});const batch=await importContacts(file.buffer,file.fileName,file.mapping,user.id);return json(batch,201);}
    }
    if(resource==='connections') {
      if(method==='GET')return json({connections:await db.connection.findMany({select:connectionSelect,orderBy:{createdAt:'asc'}})});
      admin();
      if(!id && method==='POST'){
        const input=z.object({name:text,phone:text,wabaId:text,phoneNumberId:text,token:z.string().min(1).max(5000).optional(),mode:z.enum(['MOCK','META']),ratePerMinute:z.number().int().min(1).max(60).optional()}).parse(await body(request));
        if(input.mode==='MOCK' && process.env.WHATSAPP_MODE!=='mock')fail('Modo simulado não está habilitado.');
        if(input.mode==='META' && !input.token)fail('Informe o token oficial da Meta.');
        if(input.mode==='META' && (!/^\d+$/.test(input.wabaId)||!/^\d+$/.test(input.phoneNumberId)))fail('IDs da Meta devem ser numéricos.');
        const {token,...data}=input;const connection=await db.connection.create({data:{...data,encryptedToken:token?encryptSecret(token):null,status:input.mode==='MOCK'?'CONNECTED':'PENDING'},select:connectionSelect});
        await audit(user.id,'CONNECTION_CREATED',connection.id);return json({connection},201);
      }
      if(id && sub==='sync' && method==='POST'){await verifyConnection(id);await syncTemplates(id);await audit(user.id,'CONNECTION_SYNCED',id);return json({connection:await db.connection.findUnique({where:{id},select:connectionSelect})});}
      if(id && method==='PATCH'){const input=z.object({enabled:z.boolean().optional(),name:text.optional(),token:z.string().min(1).max(5000).optional(),ratePerMinute:z.number().int().min(1).max(60).optional()}).strict().parse(await body(request));const {token,...data}=input;const connection=await db.connection.update({where:{id},data:{...data,...(token?{encryptedToken:encryptSecret(token)}:{})},select:connectionSelect});await audit(user.id,'CONNECTION_UPDATED',id);return json({connection});}
      if(id && method==='DELETE'){const campaigns=await db.campaign.count({where:{connectionId:id}});if(campaigns)fail('A conexão possui campanhas no histórico. Desabilite-a para preservar os registros.',409);await db.connection.delete({where:{id}});await audit(user.id,'CONNECTION_DELETED',id);return json({deleted:true});}
    }
    if(resource==='templates') {
      if(method==='GET')return json({templates:await db.template.findMany({include:{connection:{select:connectionSelect}},orderBy:{createdAt:'desc'}})});
      if(method==='POST'){admin();const input=z.object({connectionId:text,name:z.string().regex(/^[a-z0-9_]{1,100}$/),language:z.string().max(10).default('pt_BR'),parameterNames:z.array(z.string().max(100)).max(20).default([])}).parse(await body(request));const connection=await db.connection.findUniqueOrThrow({where:{id:input.connectionId}});if(connection.mode!=='MOCK'||process.env.WHATSAPP_MODE!=='mock')fail('Modelos reais devem ser aprovados na Meta e sincronizados.');const template=await db.template.create({data:{...input,status:'APPROVED',components:[{type:'BODY',text:'Modelo simulado para testes locais.'}]}});await audit(user.id,'MOCK_TEMPLATE_CREATED',template.id);return json({template},201);}
    }
    if(resource==='campaigns') {
      if(method==='GET')return json({campaigns:await db.campaign.findMany({include:{connection:{select:connectionSelect},template:true,recipients:{select:{id:true,status:true,error:true,contactId:true}},_count:{select:{recipients:true}}},orderBy:{createdAt:'desc'},take:100})});
      admin();
      if(!id && method==='POST'){const input=z.object({name:text,connectionId:text,templateId:text,contactIds:z.array(text).min(1).max(10000),scheduledAt:z.string().datetime().optional(),maxBudgetCents:z.number().int().min(0).max(100000000).optional(),costPerMessageCents:z.number().int().min(0).max(100000).optional(),ratePerMinute:z.number().int().min(1).max(60).optional(),parameters:z.record(z.string(),z.string().max(2000)).optional()}).parse(await body(request));return json({campaign:await createCampaign(input,user.id)},201);}
      if(id && sub==='action' && method==='POST'){const input=z.object({action:z.enum(['start','pause','resume','cancel'])}).parse(await body(request));return json({campaign:await campaignAction(id,input.action,user.id)});}
    }
    if(resource==='conversations') {
      if(!id && method==='GET') {
        const where: Prisma.ConversationWhereInput={};if(url.searchParams.get('connectionId'))where.connectionId=url.searchParams.get('connectionId')!;if(url.searchParams.get('assignedToId'))where.assignedToId=url.searchParams.get('assignedToId')!;if(url.searchParams.get('status'))where.status=url.searchParams.get('status')!;if(url.searchParams.get('q'))where.contact={company:{name:{contains:url.searchParams.get('q')!.slice(0,100),mode:'insensitive'}}};
        return json({conversations:await db.conversation.findMany({where,include:{contact:{include:{company:true}},connection:{select:connectionSelect},assignedTo:{select:userSelect},messages:{orderBy:{createdAt:'desc'},take:1}},orderBy:{updatedAt:'desc'},take:200})});
      }
      if(id && !sub && method==='GET'){const conversation=await db.conversation.findUnique({where:{id},include:{contact:{include:{company:true,notes:{include:{author:{select:userSelect}}},tasks:true}},connection:{select:connectionSelect},assignedTo:{select:userSelect},messages:{orderBy:{createdAt:'asc'},take:1000}}});if(!conversation)fail('Conversa não encontrada.',404);return json({conversation});}
      if(id && !sub && method==='PATCH'){const input=z.object({status:z.enum(['PENDING','OPEN','IN_PROGRESS','CLOSED']).optional(),assignedToId:z.string().nullable().optional()}).strict().parse(await body(request));if(input.assignedToId && !await db.user.findUnique({where:{id:input.assignedToId}}))fail('Atendente não encontrado.');const conversation=await db.conversation.update({where:{id},data:input});await audit(user.id,'CONVERSATION_UPDATED',id);return json({conversation});}
      if(id && sub==='messages' && method==='POST'){const input=z.object({body:z.string().trim().min(1).max(4096),idempotencyKey:z.string().min(8).max(200).optional()}).parse(await body(request));const key=input.idempotencyKey || request.headers.get('Idempotency-Key');if(!key||key.length<8||key.length>200)fail('Informe uma chave de idempotência válida.');return json({message:await replyToConversation(id,input.body,key,user.id)},201);}
    }
    if(resource==='users') {
      if(method==='GET')return json({users:await db.user.findMany({select:userSelect,orderBy:{name:'asc'}})});
      if(method==='POST'){admin();const input=z.object({email:z.string().email(),name:text,password:z.string().min(12).max(200),role:z.enum(['ADMIN','AGENT'])}).parse(await body(request));const {password,...data}=input;const created=await db.user.create({data:{...data,passwordHash:await hash(password,12)},select:userSelect});await audit(user.id,'USER_CREATED',created.id);return json({user:created},201);}
    }
    if(resource==='settings') {
      if(method==='GET'){const setting=await db.setting.findUnique({where:{key:'emergencyStop'}});return json({emergencyStop:setting?.value===true,mode:process.env.WHATSAPP_MODE||'mock',metaConfigured:Boolean(process.env.META_APP_SECRET&&process.env.META_VERIFY_TOKEN)});}
      if(method==='POST'){admin();const input=z.object({emergencyStop:z.boolean()}).parse(await body(request));await setEmergencyStop(input.emergencyStop,user.id);return json(input);}
    }
    if(resource==='audit' && method==='GET'){admin();return json({logs:await db.auditLog.findMany({orderBy:{createdAt:'desc'},take:200,include:{user:{select:userSelect}}})});}
    if(resource==='export' && method==='GET') {
      const contacts=await db.contact.findMany({include:contactInclude,orderBy:{createdAt:'asc'},take:50000});
      const originalColumns=[...new Set(contacts.flatMap(c=>Object.keys((c.originalData as Record<string,unknown>)||{})))];
      const columns=['Empresa','Razão social','CNPJ','Contato','Telefone','E-mail','Município','UF','Segmento','Prioridade','Etapa','Não contatar','Mensagem personalizada',...originalColumns.map(key=>`Original: ${key}`)];
      const rows=contacts.map(c=>[c.company.name,c.company.legalName,c.company.cnpj,c.name,c.phone,c.email,c.company.city,c.company.state,c.company.segment,c.priority,c.stage,c.doNotContact?'Sim':'Não',c.messageDraft,...originalColumns.map(key=>String((c.originalData as Record<string,unknown>)?.[key]??''))]);
      await audit(user.id,'CONTACTS_EXPORTED',undefined,{count:contacts.length,format:url.searchParams.get('format')||'csv'});
      if(url.searchParams.get('format')==='xlsx'){
        const book=new ExcelJS.Workbook();const sheet=book.addWorksheet('Contatos');sheet.addRow(columns);for(const row of rows)sheet.addRow(row.map(c=>String(c??'')));sheet.getRow(1).font={bold:true};sheet.columns.forEach(c=>{c.width=24;});const buffer=await book.xlsx.writeBuffer();return new Response(new Uint8Array(buffer),{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="contatos.xlsx"','Cache-Control':'no-store'}});
      }
      const csv='\uFEFF'+[columns,...rows].map(row=>row.map(csvCell).join(';')).join('\r\n');return new Response(csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="contatos.csv"','Cache-Control':'no-store'}});
    }
    // Controlled inbound simulator; never enabled for live integrations.
    if(resource==='test' && id==='inbound' && method==='POST'){
      admin();if(process.env.WHATSAPP_MODE!=='mock')fail('Simulador indisponível.',404);
      const input=z.object({connectionId:text,phone:text,body:z.string().min(1).max(4096)}).parse(await body(request));const connection=await db.connection.findUniqueOrThrow({where:{id:input.connectionId}});if(connection.mode!=='MOCK')fail('Selecione uma conexão simulada.');const phone=normalizeBrazilianPhone(input.phone);if(!phone)fail('Telefone inválido.');
      await processWebhook({object:'whatsapp_business_account',entry:[{id:connection.wabaId,changes:[{field:'messages',value:{messaging_product:'whatsapp',metadata:{phone_number_id:connection.phoneNumberId},contacts:[{profile:{name:'Contato de teste'},wa_id:phone.replace('+','')}],messages:[{id:`mock-inbound-${crypto.randomUUID()}`,from:phone.replace('+',''),timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:input.body}}]}}]}]});
      await audit(user.id,'MOCK_INBOUND',connection.id);return json({received:true});
    }
    return json({error:'Recurso não encontrado.'},404);
  } catch (error) {
    if(error instanceof z.ZodError) return json({error:'Verifique os campos informados.',details:error.flatten().fieldErrors},400);
    if(error instanceof Prisma.PrismaClientKnownRequestError){if(error.code==='P2025')return json({error:'Registro não encontrado.'},404);if(error.code==='P2002')return json({error:'Já existe um registro com estes dados.'},409);if(error.code==='P2003')return json({error:'O registro possui dependências e não pode ser removido.'},409);}
    const e=error as Error & {status?:number};
    const status=e.status||(/consent|autoriz|bloque|template|modelo|janela|budget|orçamento|connection|conex|campanh|campaign|emergency|suspens|not found|inválid|invalid|rate|limite/i.test(e.message||'')?400:500);
    if(status>=500) console.error('API request failed:',e.name);
    return json({error:status>=500?'Não foi possível concluir a operação. Verifique os serviços e tente novamente.':e.message},status);
  }
}
export const GET=handler;
export const POST=handler;
export const PATCH=handler;
export const DELETE=handler;
