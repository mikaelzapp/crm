/** Capture the real UI with browser-only fictional data; never reads/writes CRM records. */
import {chromium} from '@playwright/test';
import {existsSync,mkdirSync} from 'node:fs';
const base=process.env.SCREENSHOT_BASE_URL||'http://localhost:3000';
const executablePath=['/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync);
const browser=await chromium.launch({headless:true,executablePath,args:['--no-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
let signedIn=false;
const date='2026-01-01T12:00:00.000Z';
const user={id:'tutorial-user',name:'Equipe Exemplo',email:'equipe@example.invalid',role:'ADMIN'};
const connection={id:'tutorial-channel',name:'Atendimento · Exemplo',phone:'Número de demonstração',wabaId:'tutorial-waba',phoneNumberId:'tutorial-phone',enabled:true,status:'CONNECTED',quality:'MOCK',mode:'MOCK',ratePerMinute:10};
const agent={id:'tutorial-agent',connectionId:connection.id,name:'Atendente de demonstração',mode:'OFF',model:'qwen3.5:4b',embeddingModel:'all-minilm:latest',instructions:'Atenda com cordialidade. Consulte a base aprovada e encaminhe dúvidas para a equipe humana.',faqs:[{question:'Qual é o horário de atendimento?',answer:'De segunda a sexta, das 9h às 18h.'}],services:[{name:'Consultoria empresarial',description:'Atendimento consultivo conforme a necessidade da empresa.'}],prices:[{item:'Consulta inicial',price:'150,00',currency:'BRL'}],retainHistory:false,maxHistoryMessages:10,timeoutSeconds:60,connection,createdAt:date,updatedAt:date};
const dashboard={companies:2,contacts:2,validContacts:2,eligible:0,connections:1,campaigns:0,sent:0,delivered:0,responses:0,optOuts:0,stages:[{stage:'PENDING_AUTHORIZATION',count:2}],recentImports:[],recentCampaigns:[]};
await page.route('**/api/**',async route=>{
 const request=route.request(),path=new URL(request.url()).pathname.replace(/^\/api\//,'');
 if(request.method()!=='GET')return route.fulfill({status:405,json:{error:'Captura ilustrativa: alterações desabilitadas.'}});
 if(path==='events')return route.fulfill({status:200,contentType:'text/event-stream',body:': tutorial\n\n'});
 let data={};
 if(path==='session')data={user:signedIn?user:null,mode:'mock'};
 else if(path==='dashboard'||path==='reports')data={...dashboard,byNumber:[],byCampaign:[]};
 else if(path==='connections')data={connections:[connection]};
 else if(path==='settings')data={mode:'mock',emergencyStop:false};
 else if(path==='users')data={users:[user]};
 else if(path==='contacts')data={contacts:[],total:2};
 else if(path==='ai/status')data={available:true,models:[{name:'qwen3.5:4b',size:3100000000,digest:'tutorial',capabilities:['completion']},{name:'all-minilm:latest',size:46000000,digest:'tutorial',capabilities:['embedding']}],defaultModel:'qwen3.5:4b'};
 else if(path==='ai/agents')data={agents:[agent],connections:[connection]};
 else if(path==='ai/agents/'+agent.id)data={agent};
 else if(path.endsWith('/knowledge'))data={sources:[]};
 else if(path.endsWith('/runs'))data={runs:[]};
 else if(path.endsWith('/corrections'))data={corrections:[]};
 else if(path==='ai/queue')data={queue:[]};
 else {const key=path==='audit'?'logs':path;data={[key]:[]};}
 return route.fulfill({status:200,json:data});
});
try{
 mkdirSync('public/installation',{recursive:true});
 await page.goto(base);
 await page.getByRole('button',{name:'Entrar no CRM'}).waitFor();
 await page.screenshot({path:'public/installation/login.png',fullPage:true,style:'nextjs-portal{display:none!important}'});
 signedIn=true;await page.reload();
 await page.getByRole('heading',{name:/Visão geral/}).waitFor();
 await page.locator('.stat-card').first().getByText('2',{exact:true}).waitFor();
 await page.screenshot({path:'public/installation/dashboard.png',fullPage:true,style:'nextjs-portal{display:none!important}'});
 await page.getByRole('navigation').getByRole('button',{name:'Treinamento da IA',exact:true}).click();
 await page.getByRole('heading',{name:'Treinamento da IA'}).waitFor();
 await page.getByText(agent.name,{exact:true}).first().waitFor();
 await page.getByText('Instruções do agente',{exact:false}).first().waitFor({timeout:10000}).catch(()=>{});
 await page.screenshot({path:'public/installation/ai-training.png',fullPage:true,style:'nextjs-portal{display:none!important}'});
 console.log('Três capturas da interface criadas com dados fictícios e APIs reais bloqueadas.');
}finally{await browser.close();}
