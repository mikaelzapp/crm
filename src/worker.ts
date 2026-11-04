import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { db } from './lib/db';
import { QUEUE_NAME, processRecipient, reconcileCampaigns, closeQueues } from './lib/campaigns';
import { AI_QUEUE_NAME, reconcileAiQueue, closeAiQueues } from './lib/ai-queue';
import { processAiRun, processKnowledgeIndex } from './lib/ai-runtime';

const redis=new IORedis(process.env.REDIS_URL||'redis://127.0.0.1:6379',{maxRetriesPerRequest:null});
redis.on('error',error=>console.error(JSON.stringify({event:'redis_error',error:error.message})));
const worker=new Worker(QUEUE_NAME,async job=>{
  if(job.name!=='send'||typeof job.data.recipientId!=='string')throw new Error('Job inválido.');
  await processRecipient(job.data.recipientId);
},{connection:redis as any,concurrency:1,lockDuration:60000,maxStalledCount:1});
const aiWorker=new Worker(AI_QUEUE_NAME,async job=>{
  if(job.name==='ai-run'&&typeof job.data.runId==='string')return processAiRun(job.data.runId);
  if(job.name==='knowledge-index'&&typeof job.data.sourceId==='string')return processKnowledgeIndex(job.data.sourceId);
  throw new Error('Job de IA inválido.');
},{connection:redis as any,concurrency:2,lockDuration:120000,maxStalledCount:1});
for(const [name,item] of [['campaigns',worker],['ai',aiWorker]] as const){
  item.on('completed',job=>console.info(JSON.stringify({event:'job_completed',queue:name,id:job.id})));
  item.on('failed',(job,error)=>console.error(JSON.stringify({event:'job_failed',queue:name,id:job?.id,error:error.message})));
  item.on('error',error=>console.error(JSON.stringify({event:'worker_error',queue:name,error:error.message})));
}
let scanning=false;
async function scan(){if(scanning)return;scanning=true;try{
  const results=await Promise.allSettled([reconcileCampaigns(),reconcileAiQueue()]);
  for(let i=0;i<results.length;i++){const result=results[i];if(result.status==='rejected')console.error('Falha ao reconciliar fila:',i,result.reason instanceof Error?result.reason.message:'erro');}
}finally{scanning=false;}}
void scan();
const timer=setInterval(scan,15000);
console.info('Workers CRM iniciados: campanhas + IA. WhatsApp:',process.env.WHATSAPP_MODE==='mock'?'SIMULADO':'REAL (exige WHATSAPP_MODE=live)');
let stopping=false;
async function stop(){if(stopping)return;stopping=true;clearInterval(timer);await Promise.all([worker.close(),aiWorker.close()]);await Promise.all([closeQueues(),closeAiQueues()]);await redis.quit();await db.$disconnect();process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
