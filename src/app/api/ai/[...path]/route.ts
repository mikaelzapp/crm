import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { db } from '@/lib/db';
import { getUser, assertMutationOrigin } from '@/lib/auth';
import { readLimitedBody } from '@/lib/api';
import { listOllamaModels, getOllamaModel } from '@/lib/ollama';
import { createKnowledgeSource } from '@/lib/knowledge';
import { extractDocument } from '@/lib/documents';
import { enqueueTestRun, enqueueKnowledgeIndex } from '@/lib/ai-queue';
import { approveAiSuggestion } from '@/lib/ai-runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const MAX_DOCUMENT = 5 * 1024 * 1024;
const json = (value: unknown, status = 200) => Response.json(value, {status, headers:{'Cache-Control':'no-store'}});
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), {status}); }
const name = z.string().trim().min(1).max(300);
const modelName = z.string().trim().regex(/^[a-zA-Z0-9._:/-]{1,180}$/, 'Nome de modelo inválido.');
const configSchema = z.object({
  name:name.optional(),mode:z.enum(['OFF','SUGGEST','AUTO']).optional(),model:modelName.optional(),embeddingModel:modelName.nullable().optional(),
  instructions:z.string().max(20000).optional(),
  faqs:z.array(z.object({question:z.string().trim().min(1).max(2000),answer:z.string().trim().min(1).max(10000)}).strict()).max(200).optional(),
  services:z.array(z.object({name,description:z.string().trim().max(10000)}).strict()).max(200).optional(),
  prices:z.array(z.object({item:name,price:z.union([z.string().trim().max(1000),z.number().nonnegative()]).transform(String),currency:z.string().trim().max(10).optional()}).strict()).max(200).optional(),
  retainHistory:z.boolean().optional(),maxHistoryMessages:z.number().int().min(0).max(30).optional(),timeoutSeconds:z.number().int().min(5).max(120).optional(),
}).strict();
const connectionSelect = {id:true,name:true,phone:true,enabled:true,status:true,mode:true} as const;
const agentSummarySelect = {id:true,connectionId:true,name:true,mode:true,model:true,embeddingModel:true,retainHistory:true,maxHistoryMessages:true,timeoutSeconds:true,createdAt:true,updatedAt:true,connection:{select:connectionSelect},_count:{select:{sources:true,runs:true,corrections:true}}} as const;
async function body(request:Request){const raw=await readLimitedBody(request,1024*1024);try{return JSON.parse(raw.toString('utf8'));}catch{fail('JSON inválido.');}}
async function audit(userId:string,action:string,entityId?:string,metadata:Prisma.InputJsonValue={}){await db.auditLog.create({data:{userId,action,entityId,metadata}});}
async function validateModel(model:string,capability:'completion'|'embedding'){
  try{const details=await getOllamaModel(model);if(!details.capabilities.includes(capability))fail(capability==='completion'?'Selecione um modelo local com geração de texto.':'Selecione um modelo local de embeddings.');}
  catch(error){const status=(error as {status?:number}).status;if(status===400||status===422)throw error;fail('O modelo não pôde ser validado no Ollama. Confira se está instalado e se o serviço está disponível.',503);}
}
async function queueSource(sourceId:string){try{await enqueueKnowledgeIndex(sourceId);}catch{await db.knowledgeSource.updateMany({where:{id:sourceId},data:{status:'FAILED',error:'Fila indisponível. Use reindexar após restabelecer o Redis.'}});}}
function visibleRun<T extends {expiresAt:Date|null;input:string;output:string|null;sources:Prisma.JsonValue;reason:string|null;error:string|null}>(run:T){return run.expiresAt && run.expiresAt<=new Date()?{...run,input:'',output:null,sources:[],reason:'Conteúdo temporário expirado.',error:null}:run;}
async function permissionValid(conversationId:string){const permission=await db.aiConversationPermission.findUnique({where:{conversationId}});return Boolean(permission?.allowed && permission.grantedAt && permission.grantedAt<=new Date() && !permission.revokedAt && permission.source.trim() && permission.purpose.trim() && permission.evidence?.trim());}
function structuredContent(agent:{faqs:unknown;services:unknown;prices:unknown}){
  const parts:string[]=[];
  for(const entry of agent.faqs as Array<{question:string;answer:string}>)parts.push(`Pergunta: ${entry.question}\nResposta: ${entry.answer}`);
  for(const entry of agent.services as Array<{name:string;description:string}>)parts.push(`Serviço: ${entry.name}\nDescrição: ${entry.description}`);
  for(const entry of agent.prices as Array<{item:string;price:string;currency?:string}>)parts.push(`Item: ${entry.item}\nPreço informado: ${entry.price} ${entry.currency||''}`.trim());
  return parts.join('\n\n');
}
async function rebuildStructuredSource(agentId:string){
  const agent=await db.aiAgent.findUniqueOrThrow({where:{id:agentId}});const content=structuredContent(agent);
  const previous=await db.knowledgeSource.findFirst({where:{agentId,type:'STRUCTURED'},orderBy:{createdAt:'asc'}});
  if(!content){if(previous)await db.knowledgeSource.delete({where:{id:previous.id}});return;}
  if(previous){await db.$transaction([db.knowledgeChunk.deleteMany({where:{sourceId:previous.id}}),db.knowledgeSource.update({where:{id:previous.id},data:{content,contentHash:createHash('sha256').update(content).digest('hex'),indexedHash:null,embeddingModel:null,dimensions:null,status:'PENDING',error:null,approved:true}})]);await queueSource(previous.id);}
  else{const source=await createKnowledgeSource(agentId,{title:'Cadastro estruturado do agente',type:'STRUCTURED',content,approved:true});await queueSource(source.id);}
}

async function handler(request:NextRequest,{params}:{params:Promise<{path:string[]}>}){
  try{
    const {path}=await params;const [resource,id,sub]=path;const method=request.method;const url=new URL(request.url);
    if(method!=='GET')assertMutationOrigin(request);
    const user=await getUser(request);if(!user)fail('Faça login para continuar.',401);
    const account=user!;const admin=()=>{if(account.role!=='ADMIN')fail('Acesso restrito a administradores.',403);};
    if(resource==='status' && method==='GET'){
      try{const status=await listOllamaModels();return json({available:true,...status});}
      catch{return json({available:false,models:[],defaultModel:null,error:'Ollama indisponível. Confira o endereço configurado no servidor e a disponibilidade dos modelos locais.'});}
    }
    if(resource==='agents'){
      if(!id && method==='GET'){
        const [agents,connections]=await Promise.all([account.role==='ADMIN'?db.aiAgent.findMany({include:{connection:{select:connectionSelect},_count:{select:{sources:true,runs:true,corrections:true}}},orderBy:{createdAt:'asc'}}):db.aiAgent.findMany({select:agentSummarySelect,orderBy:{createdAt:'asc'}}),db.connection.findMany({select:connectionSelect,orderBy:{name:'asc'}})]);
        return json({agents,connections});
      }
      admin();
      if(!id && method==='POST'){
        const input=z.object({connectionId:name,name,model:modelName.optional(),embeddingModel:modelName.nullable().optional()}).strict().parse(await body(request));
        if(input.model)await validateModel(input.model,'completion');if(input.embeddingModel)await validateModel(input.embeddingModel,'embedding');
        const agent=await db.aiAgent.create({data:{...input,mode:'OFF'}});await audit(account.id,'AI_AGENT_CREATED',agent.id);return json({agent},201);
      }
      if(id && !sub && method==='GET'){const agent=await db.aiAgent.findUniqueOrThrow({where:{id},include:{connection:{select:connectionSelect},_count:{select:{sources:true,runs:true,corrections:true}}}});return json({agent});}
      if(id && !sub && method==='PATCH'){
        const input=configSchema.parse(await body(request));const previous=await db.aiAgent.findUniqueOrThrow({where:{id}});
        if(Array.from(structuredContent({...previous,...input})).length>100000)fail('O cadastro estruturado excede 100 mil caracteres. Divida o conteúdo em fontes menores.');
        if((input.model!==undefined&&input.model!==previous.model)||(input.mode!==undefined&&input.mode!=='OFF'&&input.mode!==previous.mode))await validateModel(input.model||previous.model,'completion');
        if(input.embeddingModel && input.embeddingModel!==previous.embeddingModel)await validateModel(input.embeddingModel,'embedding');
        const agent=await db.aiAgent.update({where:{id},data:input});
        if(input.embeddingModel!==undefined && input.embeddingModel!==previous.embeddingModel){
          await db.$transaction([db.knowledgeChunk.deleteMany({where:{agentId:id}}),db.knowledgeSource.updateMany({where:{agentId:id},data:{status:'PENDING',error:null,indexedHash:null,embeddingModel:null,dimensions:null}})]);
          for(const source of await db.knowledgeSource.findMany({where:{agentId:id,approved:true},select:{id:true}}))await queueSource(source.id);
        }
        if((['faqs','services','prices'] as const).some(key=>input[key]!==undefined&&JSON.stringify(input[key])!==JSON.stringify(previous[key])))await rebuildStructuredSource(id);
        if(input.retainHistory===false && previous.retainHistory){await db.aiRun.updateMany({where:{agentId:id,retainHistory:true},data:{retainHistory:false,expiresAt:new Date(Date.now()+86400000)}});}
        if(input.mode==='OFF')await db.aiRun.updateMany({where:{agentId:id,origin:'INCOMING',status:'QUEUED'},data:{status:'CANCELED',reason:'Agente desativado.'}});
        await audit(account.id,'AI_AGENT_UPDATED',id,{fields:Object.keys(input)});return json({agent});
      }
      if(id && sub==='knowledge' && method==='GET')return json({sources:await db.knowledgeSource.findMany({where:{agentId:id},orderBy:{createdAt:'desc'}})});
      if(id && sub==='knowledge' && method==='POST'){
        await db.aiAgent.findUniqueOrThrow({where:{id}});if(await db.knowledgeSource.count({where:{agentId:id}})>=100)fail('Limite de 100 fontes por agente. Remova documentos antigos antes de continuar.');
        let sourceInput:{title:string;content:string;type:string};
        if(request.headers.get('content-type')?.includes('multipart/form-data')){
          const bytes=await readLimitedBody(request,MAX_DOCUMENT+100000);let form:FormData;try{form=await new Response(new Uint8Array(bytes),{headers:{'Content-Type':request.headers.get('content-type')!}}).formData();}catch{fail('Formulário de documento inválido.');}
          const file=form.get('file');if(!(file instanceof File)||!file.size)fail('Selecione um documento PDF, TXT ou DOCX.');if(file.size>MAX_DOCUMENT)fail('O documento excede 5 MB.',413);
          const extracted=await extractDocument(Buffer.from(await file.arrayBuffer()),file.name);const title=name.max(200).parse(form.get('title')||file.name);sourceInput={title,content:extracted.content,type:extracted.type};
        }else{const input=z.object({title:name.max(200),text:z.string().trim().min(1).max(100000)}).strict().parse(await body(request));sourceInput={title:input.title,content:input.text,type:'TEXT'};}
        const source=await createKnowledgeSource(id,{...sourceInput,approved:true});await queueSource(source.id);await audit(account.id,'AI_KNOWLEDGE_ADDED',source.id,{agentId:id,type:source.type});return json({source:await db.knowledgeSource.findUnique({where:{id:source.id}})},201);
      }
      if(id && sub==='runs' && method==='GET'){
        const page=Math.min(10000,Math.max(1,Math.trunc(Number(url.searchParams.get('page')))||1));const where={agentId:id};const [runs,total]=await Promise.all([db.aiRun.findMany({where,orderBy:{createdAt:'desc'},take:50,skip:(page-1)*50}),db.aiRun.count({where})]);return json({runs:runs.map(visibleRun),total,page});
      }
      if(id && sub==='corrections' && method==='GET')return json({corrections:await db.aiCorrection.findMany({where:{agentId:id},orderBy:{createdAt:'desc'},take:200})});
      if(id && sub==='test' && method==='POST'){
        const input=z.object({message:z.string().trim().min(1).max(10000),sessionId:z.string().max(100).optional()}).strict().parse(await body(request));const agent=await db.aiAgent.findUniqueOrThrow({where:{id}});await validateModel(agent.model,'completion');
        const run=await db.aiRun.create({data:{agentId:id,origin:'TEST',input:input.message,mode:agent.mode,retainHistory:agent.retainHistory,expiresAt:agent.retainHistory?null:new Date(Date.now()+86400000)}});
        try{await enqueueTestRun(run.id);}catch{await db.aiRun.update({where:{id:run.id},data:{status:'FAILED',error:'Fila indisponível. Tente novamente após restabelecer o Redis.'}});}
        await audit(account.id,'AI_PLAYGROUND_QUEUED',run.id);return json({run:await db.aiRun.findUnique({where:{id:run.id}})},202);
      }
    }
    if(resource==='knowledge'){
      admin();if(!id)fail('Fonte não informada.');
      if(method==='DELETE'){await db.knowledgeSource.delete({where:{id}});await db.aiCorrection.updateMany({where:{sourceId:id},data:{sourceId:null,status:'REVOKED'}});await audit(account.id,'AI_KNOWLEDGE_REMOVED',id);return json({deleted:true});}
      if(sub==='reindex' && method==='POST'){const source=await db.knowledgeSource.findUniqueOrThrow({where:{id}});if(!source.approved)fail('A fonte precisa de aprovação antes de indexar.');await db.$transaction([db.knowledgeChunk.deleteMany({where:{sourceId:id}}),db.knowledgeSource.update({where:{id},data:{status:'PENDING',indexedHash:null,dimensions:null,embeddingModel:null,error:null}})]);await queueSource(id);await audit(account.id,'AI_KNOWLEDGE_REINDEXED',id);return json({source:await db.knowledgeSource.findUnique({where:{id}})},202);}
    }
    if(resource==='runs' && id){
      const run=await db.aiRun.findUniqueOrThrow({where:{id},include:{agent:{select:{id:true,name:true,mode:true,connectionId:true}}}});
      if(account.role!=='ADMIN' && (!run.conversationId || !await permissionValid(run.conversationId)))fail('Acesso não autorizado à execução de IA.',403);
      if(!sub && method==='GET')return json({run:visibleRun(run)});
      if(sub==='send' && method==='POST'){const message=await approveAiSuggestion(id,account.id);return json({message});}
      if(sub==='corrections' && method==='POST'){
        admin();if(run.conversationId && !await permissionValid(run.conversationId))fail('A conversa precisa de autorização documentada para uso pela IA.',403);
        if(!run.input||!run.output||run.expiresAt&&run.expiresAt<=new Date())fail('O conteúdo desta execução não está disponível para correção.');
        const input=z.object({correctedAnswer:z.string().trim().min(1).max(10000)}).strict().parse(await body(request));const correction=await db.$transaction(async tx=>{if(run.conversationId){await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-permission-${run.conversationId}`}))`;const p=await tx.aiConversationPermission.findUnique({where:{conversationId:run.conversationId}});if(!p?.allowed||!p.grantedAt||p.revokedAt||!p.evidence?.trim())fail('A autorização da conversa foi revogada.',403);}const latest=await tx.aiRun.findUniqueOrThrow({where:{id}});if(!latest.input||!latest.output||latest.expiresAt&&latest.expiresAt<=new Date())fail('O conteúdo desta execução não está disponível para correção.');return tx.aiCorrection.create({data:{agentId:run.agentId,runId:id,question:latest.input,originalAnswer:latest.output,correctedAnswer:input.correctedAnswer}});});await audit(account.id,'AI_CORRECTION_SUBMITTED',correction.id);return json({correction},201);
      }
    }
    if(resource==='corrections' && id){
      admin();const correction=await db.aiCorrection.findUniqueOrThrow({where:{id},include:{run:{select:{conversationId:true}}}});
      if(sub==='approve' && method==='POST'){
        if(correction.status!=='PENDING')fail('A correção já foi revisada.',409);if(correction.run.conversationId&&!await permissionValid(correction.run.conversationId))fail('A autorização da conversa não permite reutilizar este conteúdo.',403);
        const content=`Pergunta: ${correction.question}\nResposta aprovada: ${correction.correctedAnswer}`;
        const source=await db.$transaction(async tx=>{if(correction.run.conversationId){await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-permission-${correction.run.conversationId}`}))`;const p=await tx.aiConversationPermission.findUnique({where:{conversationId:correction.run.conversationId}});if(!p?.allowed||!p.grantedAt||p.revokedAt||!p.evidence?.trim())fail('A autorização da conversa foi revogada.',403);}const claim=await tx.aiCorrection.updateMany({where:{id,status:'PENDING'},data:{status:'APPROVED',approvedById:account.id}});if(!claim.count)fail('A correção já foi revisada.',409);const source=await tx.knowledgeSource.create({data:{agentId:correction.agentId,title:'Correção aprovada por administrador',type:'CORRECTION',content,contentHash:createHash('sha256').update(content).digest('hex'),approved:true}});await tx.aiCorrection.update({where:{id},data:{sourceId:source.id}});return source;});await queueSource(source.id);await audit(account.id,'AI_CORRECTION_APPROVED',id);return json({correction:await db.aiCorrection.findUnique({where:{id}}),source},201);
      }
      if(sub==='reject' && method==='POST'){if(correction.status!=='PENDING')fail('A correção já foi revisada.',409);await db.aiCorrection.update({where:{id},data:{status:'REJECTED',approvedById:account.id}});await audit(account.id,'AI_CORRECTION_REJECTED',id);return json({rejected:true});}
    }
    if(resource==='conversations' && id){
      const conversation=await db.conversation.findUniqueOrThrow({where:{id},include:{connection:{select:connectionSelect},contact:{select:{id:true,name:true,company:{select:{id:true,name:true}}}},aiPermission:true}});
      if(method==='GET'){
        const agent=await db.aiAgent.findUnique({where:{connectionId:conversation.connectionId},select:agentSummarySelect});const permitted=await permissionValid(id);const runs=permitted?await db.aiRun.findMany({where:{conversationId:id},orderBy:{createdAt:'desc'},take:30}):[];
        return json({conversation,agent,permission:conversation.aiPermission,runs:runs.map(visibleRun)});
      }
      if(!sub && method==='PATCH'){const input=z.object({aiPaused:z.boolean()}).strict().parse(await body(request));await db.conversation.update({where:{id},data:input});if(input.aiPaused)await db.aiRun.updateMany({where:{conversationId:id,status:'QUEUED'},data:{status:'CANCELED',reason:'IA pausada pelo atendente.'}});await audit(account.id,input.aiPaused?'AI_CONVERSATION_PAUSED':'AI_CONVERSATION_RESUMED',id);return json({conversation:await db.conversation.findUnique({where:{id}})});}
      if(sub==='permission' && method==='POST'){
        admin();const input=z.object({allowed:z.boolean(),source:z.string().trim().min(3).max(500),purpose:z.string().trim().min(3).max(1000),evidence:z.string().trim().min(3).max(10000).optional()}).strict().parse(await body(request));if(input.allowed&&!input.evidence)fail('Registre a evidência da autorização para processamento pela IA.');
        const permission=await db.$transaction(async tx=>{await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ai-permission-${id}`}))`;const permission=await tx.aiConversationPermission.upsert({where:{conversationId:id},create:{conversationId:id,...input,grantedAt:input.allowed?new Date():null,revokedAt:input.allowed?null:new Date()},update:{...input,grantedAt:input.allowed?new Date():null,revokedAt:input.allowed?null:new Date()}});if(!input.allowed){
          const corrections=await tx.aiCorrection.findMany({where:{run:{conversationId:id}},select:{sourceId:true}});const sourceIds=corrections.flatMap(c=>c.sourceId?[c.sourceId]:[]);if(sourceIds.length)await tx.knowledgeSource.deleteMany({where:{id:{in:sourceIds}}});await tx.aiCorrection.deleteMany({where:{run:{conversationId:id}}});
          await tx.aiRun.updateMany({where:{conversationId:id,status:{in:['QUEUED','PROCESSING']}},data:{status:'CANCELED',reason:'Autorização de processamento pela IA revogada.'}});await tx.aiRun.updateMany({where:{conversationId:id},data:{input:'',output:null,sources:[],reason:'Conteúdo removido após revogação da autorização de IA.',error:null,retainHistory:false,expiresAt:new Date()}});
        }return permission;});await audit(account.id,input.allowed?'AI_PERMISSION_GRANTED':'AI_PERMISSION_REVOKED',id);return json({permission});
      }
    }
    if(resource==='queue' && method==='GET'){
      const conversations=await db.conversation.findMany({where:{OR:[{aiPaused:true},{aiRuns:{some:{status:{in:['HANDOFF','HUMAN_REQUIRED','FAILED','TIMEOUT']}}}}]},include:{connection:{select:connectionSelect},contact:{select:{id:true,name:true,company:{select:{id:true,name:true}}}},aiRuns:{orderBy:{createdAt:'desc'},take:1}},orderBy:{updatedAt:'desc'},take:200});
      return json({conversations:conversations.map(c=>({...c,aiRuns:c.aiRuns.map(run=>{const {input,output,sources,...metadata}=run;return metadata;})}))});
    }
    return json({error:'Recurso de IA não encontrado.'},404);
  }catch(error){
    if(error instanceof z.ZodError)return json({error:'Verifique os campos informados.',details:error.flatten().fieldErrors},400);
    if(error instanceof Prisma.PrismaClientKnownRequestError){if(error.code==='P2025')return json({error:'Registro não encontrado.'},404);if(error.code==='P2002')return json({error:'Este número já possui um agente de IA.'},409);if(error.code==='P2003')return json({error:'Registro associado não encontrado.'},400);}
    const e=error as Error&{status?:number};const status=e.status||(/consent|autoriz|bloque|janela|modelo|model|modo|mode|paus|revog|não encontrado|limite|document|arquivo|PDF|DOCX|TXT/i.test(e.message||'')?400:500);if(status>=500)console.error('AI API request failed:',e.name);return json({error:status>=500?'Não foi possível concluir a operação de IA. Verifique os serviços locais.':e.message},status);
  }
}
export const GET=handler;
export const POST=handler;
export const PATCH=handler;
export const DELETE=handler;
