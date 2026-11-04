/** Explicit local mock-environment restart test; briefly restarts PostgreSQL/Redis. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import Redis from 'ioredis';
assert.equal(process.env.WHATSAPP_MODE,'mock','Restart test requires explicit mock mode');
const marker=`crm:test:persistence:${randomUUID()}`;
async function snapshot(){
 const client=new pg.Client({connectionString:process.env.DATABASE_URL});
 try{await client.connect();const result=await client.query('SELECT id, "originalData", "messageDraft", phone FROM "Contact" ORDER BY id');return {count:result.rows.length,hash:createHash('sha256').update(JSON.stringify(result.rows)).digest('hex')};}finally{await client.end();}
}
const before=await snapshot();assert.ok(before.count>=30);
let redis=new Redis(process.env.REDIS_URL,{retryStrategy:()=>null});
await redis.set(marker,'preserved','EX',300);await redis.quit();
const restart=spawnSync('docker',['compose','-f','docker-compose.yml','-f','docker-compose.dev.yml','restart','postgres','redis'],{encoding:'utf8',timeout:60000});
assert.equal(restart.status,0,'Docker services must restart successfully');
let after;
for(let attempt=0;attempt<60;attempt++){try{after=await snapshot();break;}catch{await new Promise(resolve=>setTimeout(resolve,1000));}}
assert.deepEqual(after,before,'Every persisted contact, source data and draft must survive restart');
redis=new Redis(process.env.REDIS_URL,{retryStrategy:()=>null});
try{assert.equal(await redis.get(marker),'preserved','Redis AOF must preserve queue state');await redis.del(marker);}finally{await redis.quit();}
console.log(`PASS restart persistence: ${before.count} complete contacts unchanged; Redis AOF marker preserved.`);
