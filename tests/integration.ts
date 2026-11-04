/** Runs only against a local/test DB in explicit mock mode. Never grants consent to imported people. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { db } from '../src/lib/db';
import { importContacts, parseCsv } from '../src/lib/csv';
import { QUEUE_NAME, processRecipient, eligibility, createCampaign, campaignAction, replyToConversation, closeQueues, setEmergencyStop } from '../src/lib/campaigns';
import { processWebhook } from '../src/lib/webhooks';

async function main() {
  assert.equal(process.env.WHATSAPP_MODE, 'mock', 'Integration tests require explicit WHATSAPP_MODE=mock');
  const csvPath = process.env.TEST_CSV_PATH || 'private/CONTATOS_FINAIS_30.csv';
  const buffer = readFileSync(csvPath);
  const parsed = parseCsv(buffer);
  assert.equal(parsed.rows.length,30); assert.equal(parsed.columns.length,37);
  const batch = await importContacts(buffer,'CONTATOS_FINAIS_30.csv');
  assert.equal(batch.total,30); assert.equal(batch.status,'COMPLETED');
  const imported = await db.importRow.findMany({where:{importBatchId:batch.id},include:{contact:{include:{company:true}}}});
  assert.equal(imported.length,30);
  assert.equal(new Set(imported.map(r=>r.contact?.companyId)).size,30);
  for(const row of imported) {
    assert.equal(Object.keys(row.originalData as object).length,37);
    const original=row.originalData as Record<string,string>;
    assert.equal(row.contact?.messageDraft,original['Mensagem personalizada para WhatsApp'].trim());
    assert.equal((await eligibility(row.contactId!)).eligible,false,'Imported CSV must never supply consent');
  }
  const count = await db.contact.count();
  const repeat=await importContacts(buffer,'CONTATOS_FINAIS_30.csv');
  assert.equal(repeat.updated,30); assert.equal(repeat.created,0); assert.equal(await db.contact.count(),count);
  console.log('PASS CSV: 30 companies, all 37 original fields, draft association, repeat import deduplication, no consent inferred.');
  const connections=await db.connection.findMany({where:{mode:'MOCK',enabled:true},include:{templates:true}});
  assert.ok(connections.length>=2,'Seed MOCK_WHATSAPP_ENABLED=true to exercise multiple numbers');
  const connection=connections[0], template=connection.templates.find(t=>t.status==='APPROVED')!;
  assert.ok(template);
  const tag=`integration-${randomUUID()}`; const campaignIds:string[]=[];
  const company=await db.company.create({data:{name:`Teste automatizado ${tag}`,contacts:{create:[{name:'Contato sintético autorizado',phone:'+5511999999001'},{name:'Contato sintético pendente',phone:'+5511999999002'}]}},include:{contacts:true}});
  const [authorized,pending]=company.contacts;
  const input={name:tag,connectionId:connection.id,templateId:template.id,contactIds:[authorized.id,pending.id],parameters:Object.fromEntries((template.parameterNames as string[]).map((_,i)=>[String(i+1),i===0?'{{socio}}':'{{empresa}}'])),ratePerMinute:30};
  const redis=new IORedis(process.env.REDIS_URL!,{maxRetriesPerRequest:null});
  let worker:Worker|undefined;
  const webhook=(conn:typeof connection,id:string,text:string)=>({object:'whatsapp_business_account',entry:[{id:conn.wabaId,changes:[{field:'messages',value:{metadata:{phone_number_id:conn.phoneNumberId},messages:[{id,from:authorized.phone!.replace('+',''),timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:text}}]}}]}]});
  try {
    assert.equal((await eligibility(authorized.id)).eligible,false);
    await db.consent.create({data:{contactId:authorized.id,source:'Teste automatizado simulado',purpose:'marketing de teste',evidence:'Fixture sintética sem envio externo.'}});
    assert.equal((await eligibility(authorized.id)).eligible,true);
    const campaign=await createCampaign(input); campaignIds.push(campaign.id);
    assert.equal((await db.recipient.findFirstOrThrow({where:{campaignId:campaign.id,contactId:pending.id}})).status,'BLOCKED');
    worker=new Worker(QUEUE_NAME,job=>processRecipient(job.data.recipientId),{connection:redis as any,concurrency:1});
    await campaignAction(campaign.id,'start');
    const recipient=await db.recipient.findFirstOrThrow({where:{campaignId:campaign.id,contactId:authorized.id}});
    const until=Date.now()+20000;
    while(Date.now()<until) {const r=await db.recipient.findUniqueOrThrow({where:{id:recipient.id}});if(r.status==='SENT') break; await new Promise(r=>setTimeout(r,200));}
    const sent=await db.recipient.findUniqueOrThrow({where:{id:recipient.id},include:{message:true}});
    assert.equal(sent.status,'SENT'); assert.ok(sent.message?.externalId?.startsWith('mock_'));
    await processRecipient(recipient.id);
    assert.equal(await db.message.count({where:{idempotencyKey:sent.message!.idempotencyKey}}),1);
    console.log('PASS BullMQ: actual Redis job consumed, consent gate enforced, deterministic mock ID, duplicate invocation has no duplicate send.');
    const payload=webhook(connection,`${tag}-inbound`,'Tenho interesse');
    await processWebhook(payload); await processWebhook(payload);
    await processWebhook(webhook(connections[1],`${tag}-second-number`,'Olá na segunda conexão'));
    assert.equal(await db.message.count({where:{externalId:`${tag}-inbound`}}),1);
    assert.equal(await db.conversation.count({where:{contactId:authorized.id}}),2);
    const conversation=await db.conversation.findUniqueOrThrow({where:{contactId_connectionId:{contactId:authorized.id,connectionId:connection.id}}});
    const reply=await replyToConversation(conversation.id,'Resposta de teste',`${tag}-reply`);
    assert.equal((await replyToConversation(conversation.id,'Resposta de teste',`${tag}-reply`)).id,reply.id);
    const statusPayload={object:'whatsapp_business_account',entry:[{id:connection.wabaId,changes:[{field:'messages',value:{metadata:{phone_number_id:connection.phoneNumberId},statuses:[{id:reply.externalId,status:'read',timestamp:String(Math.floor(Date.now()/1000))}]}}]}]};
    await processWebhook(statusPayload);
    assert.equal((await db.message.findUniqueOrThrow({where:{id:reply.id}})).status,'READ');
    await db.conversation.update({where:{id:conversation.id},data:{lastInboundAt:new Date(Date.now()-86400001)}});
    await assert.rejects(()=>replyToConversation(conversation.id,'Fora da janela',`${tag}-expired`),/24 horas/);
    await processWebhook(webhook(connection,`${tag}-optout`,'Não quero receber mensagens'));
    assert.equal((await eligibility(authorized.id)).eligible,false);
    assert.ok(await db.suppression.findUnique({where:{phone:authorized.phone!}}));
    assert.equal(await db.consent.count({where:{contactId:authorized.id,revokedAt:null}}),0);
    console.log('PASS webhooks: two-number inbox, deduplication, read receipt, 24-hour window, reply idempotency and global opt-out.');
    // A crashed in-flight request has an uncertain result. Recovery must never resend it.
    const recovery=await db.campaign.create({data:{name:`${tag}-recovery`,connectionId:connection.id,templateId:template.id,status:'RUNNING',recipients:{create:{contactId:pending.id,status:'PROCESSING'}}},include:{recipients:true}});campaignIds.push(recovery.id);
    await processRecipient(recovery.recipients[0].id);
    assert.equal((await db.recipient.findUniqueOrThrow({where:{id:recovery.recipients[0].id}})).status,'UNKNOWN');
    const emergency=await db.campaign.create({data:{name:`${tag}-emergency`,connectionId:connection.id,templateId:template.id,status:'DRAFT'}});campaignIds.push(emergency.id);
    await setEmergencyStop(true); await assert.rejects(()=>campaignAction(emergency.id,'start'),/emergencial/); await setEmergencyStop(false);
    console.log('PASS recovery: uncertain in-flight jobs stop as UNKNOWN; emergency stop blocks new campaign execution.');
  } finally {
    await worker?.close(); await redis.quit(); await closeQueues();
    await db.campaign.deleteMany({where:{id:{in:campaignIds}}});
    await db.company.delete({where:{id:company.id}});
    await db.suppression.deleteMany({where:{phone:{in:['+5511999999001','+5511999999002']}}});
    await db.$disconnect();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>db.$disconnect());
