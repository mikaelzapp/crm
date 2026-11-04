import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { db } from './db';
import { prepareIncomingAi, redactExpiredAiHistory } from './ai-runtime';

export const AI_QUEUE_NAME='crm-ai';
let redis:IORedis|undefined;
let queue:Queue|undefined;
export function aiQueueRedis(){
  if(!redis){redis=new IORedis(process.env.REDIS_URL||'redis://127.0.0.1:6379',{maxRetriesPerRequest:1,connectTimeout:3000});redis.on('error',()=>{});}
  return redis;
}
export function aiQueue(){
  queue??=new Queue(AI_QUEUE_NAME,{connection:aiQueueRedis() as any,defaultJobOptions:{attempts:1,removeOnComplete:500,removeOnFail:500}});
  return queue;
}
async function addJob(name:string,id:string,data:object,attempts=1) {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([addJobInternal(name,id,data,attempts),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Fila de IA temporariamente indisponível; a tarefa persistida será recuperada pelo worker.')),3000);})]);}
  finally{if(timer)clearTimeout(timer);}
}
async function addJobInternal(name:string,id:string,data:object,attempts:number) {
  const target=aiQueue();
  const current=await target.getJob(id);
  if(current){const state=await current.getState();if(state==='completed'||state==='failed')await current.remove();else return current;}
  return target.add(name,data,{jobId:id,attempts,...(attempts>1?{backoff:{type:'exponential',delay:5000}}:{})});
}
export async function enqueueIncomingAi(messageId:string) {
  const runId=await prepareIncomingAi(messageId);
  return runId?addJob('ai-run',`ai-run-${runId}`,{runId}):null;
}
export async function enqueueTestRun(runId:string) {
  const run=await db.aiRun.findUniqueOrThrow({where:{id:runId}});
  if(!['QUEUED','PROCESSING'].includes(run.status))return null;
  return addJob('ai-run',`ai-run-${runId}`,{runId});
}
export async function enqueueKnowledgeIndex(sourceId:string) {
  const source=await db.knowledgeSource.findUniqueOrThrow({where:{id:sourceId}});
  if(!source.approved)throw new Error('A fonte precisa de aprovação administrativa.');
  return addJob('knowledge-index',`knowledge-${source.id}-${source.contentHash.slice(0,20)}`,{sourceId},3);
}
/** Only IDs enter Redis jobs. Conversation contents remain in the governed database. */
export async function reconcileAiQueue() {
  await redactExpiredAiHistory();
  const [runs,sources]=await Promise.all([
    db.aiRun.findMany({where:{status:{in:['QUEUED','PROCESSING']}},orderBy:{createdAt:'asc'},take:200,select:{id:true}}),
    db.knowledgeSource.findMany({where:{approved:true,status:{in:['PENDING','INDEXING']}},orderBy:{createdAt:'asc'},take:100,select:{id:true}}),
  ]);
  for(const source of sources)await enqueueKnowledgeIndex(source.id);
  for(const run of runs)await enqueueTestRun(run.id);
  // Recover a webhook committed just before its process stopped, even if no Redis job was created.
  const conversations=await db.conversation.findMany({where:{aiPaused:false,lastInboundAt:{gte:new Date(Date.now()-86400000)},connection:{aiAgent:{mode:{in:['SUGGEST','AUTO']}}}},select:{id:true,messages:{where:{direction:'INBOUND'},orderBy:[{createdAt:'desc'},{id:'desc'}],take:1,select:{id:true}}},take:200,orderBy:{updatedAt:'desc'}});
  for(const conversation of conversations){const message=conversation.messages[0];if(message)await enqueueIncomingAi(message.id);}
}
export async function closeAiQueues(){await queue?.close();await redis?.quit();queue=undefined;redis=undefined;}
