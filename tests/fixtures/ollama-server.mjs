/** Explicit test double for the Ollama HTTP API. No model weights or external calls. */
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const MODELS=['fixture-chat:latest','fixture-embed:latest'];
const STOP=new Set('a as o os de da das do dos e em na nas no nos um uma uns umas para por com qual quais que quanto quantos como sobre me voce voces nossa nosso suas seus favor poderia diga saber'.split(' '));
const GROUPS=[['preco','precos','valor','valores','custa','custo','custos','orcamento','price'],['servico','servicos','consulta','consultas','atendimento','avaliacao'],['horario','horarios','abre','funcionamento','expediente'],['segunda','terca','quarta','quinta','sexta','sabado','domingo'],['prazo','entrega','dias','demora'],['telefone','email','endereco','localizacao'],['garantia','garantias'],['cancelamento','excluir','remover','parar'],['plano','planos','pacote','mensal','assinatura']];
const normalize=text=>String(text).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export function fixtureEmbedding(text){
  const vector=Array(256).fill(0), tokens=normalize(text).match(/[a-z0-9]+/g)||[];
  for(const token of new Set(tokens)){
    if(STOP.has(token)||token.length<2)continue;
    const group=GROUPS.findIndex(words=>words.includes(token));
    if(group>=0)vector[group]+=3;
    const bytes=createHash('sha256').update(token).digest();
    vector[16+(bytes.readUInt16BE(0)%239)]+=1;
  }
  if(!vector.some(Boolean))vector[255]=1;
  const norm=Math.sqrt(vector.reduce((sum,value)=>sum+value*value,0));
  return vector.map(value=>Number((value/norm).toFixed(8)));
}
export function fixtureReply(messages){
  let input={};try{input=JSON.parse(messages.at(-1)?.content||'{}');}catch{}
  const question=String(input.currentCustomerMessage||'');
  const refs=Array.isArray(input.referenceData)?input.referenceData:[];
  const reference=refs.find(ref=>typeof ref.sourceId==='string'&&typeof ref.content==='string');
  const suspicious=/ignore|desconsidere|finja|instru[cç][oõ]es|(?:revele|mostre).*(?:segred|senha|token)|chave.*api/i;
  const passage=reference?.content.split(/(?<=[.!?])\s+|\n+/).filter(line=>!suspicious.test(line)).join(' ').trim().slice(0,700);
  const requestedHuman=/\[human\]|falar com.*(humano|pessoa|atendente)/i.test(question);
  if(requestedHuman)return {answer:'[SIMULAÇÃO OLLAMA] Encaminhar para a equipe humana.',intent:'HUMAN',handoff:true,reason:'Solicitação de atendimento humano em teste.',sourceIds:[]};
  if(!reference||!passage)return {answer:'[SIMULAÇÃO OLLAMA] Não há referência suficiente; encaminhar para humano.',intent:'GENERAL',handoff:true,reason:'Referência de teste ausente.',sourceIds:[]};
  return {answer:`[SIMULAÇÃO OLLAMA] Conforme a referência aprovada: ${passage}`,intent:/quero (comprar|contratar|agendar)|tenho interesse/i.test(question)?'INTEREST':'GENERAL',handoff:false,reason:'Resposta determinística do servidor de teste; nenhum modelo real executado.',sourceIds:[reference.sourceId]};
}
export function createFixtureServer(){
  const stats={tags:0,show:0,embed:0,chat:0,lastChatRoles:[],lastChatModel:null};
  const json=(response,status,data)=>{response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(data));};
  return createServer(async(request,response)=>{
    const path=new URL(request.url||'/','http://fixture.local').pathname;
    if(request.method==='GET'&&path==='/'){response.end('Ollama API fixture (SIMULATION, no model weights).');return;}
    if(request.method==='GET'&&path==='/api/version'){json(response,200,{version:'fixture-not-a-real-ollama-model'});return;}
    if(request.method==='GET'&&path==='/__fixture/metrics'){json(response,200,stats);return;}
    if(request.method==='GET'&&path==='/api/tags'){
      stats.tags++;json(response,200,{models:MODELS.map(name=>({name,model:name,modified_at:'2026-01-01T00:00:00Z',size:0,digest:createHash('sha256').update(name).digest('hex'),details:{format:'fixture',family:'synthetic',parameter_size:'0',quantization_level:'NONE'}}))});return;
    }
    if(request.method!=='POST'){json(response,404,{error:'Fixture endpoint not found.'});return;}
    let bytes=0,parts=[];
    try{for await(const part of request){bytes+=part.length;if(bytes>2*1024*1024){json(response,413,{error:'Fixture payload too large.'});return;}parts.push(part);}}catch{return;}
    let body;try{body=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{json(response,400,{error:'Invalid JSON.'});return;}
    if(!MODELS.includes(body.model)){json(response,404,{error:'Model not installed in test fixture.'});return;}
    const complete=()=>{
      if(response.destroyed)return;
      if(path==='/api/show'){
        stats.show++;json(response,200,{capabilities:[body.model===MODELS[1]?'embedding':'completion'],details:{family:'synthetic',parameter_size:'0'},model_info:{'general.architecture':'fixture'},modelfile:'# SIMULATION — no model weights'});return;
      }
      if(path==='/api/embed'&&body.model===MODELS[1]){
        stats.embed++;const inputs=Array.isArray(body.input)?body.input:[body.input];
        if(inputs.some(value=>typeof value!=='string')){json(response,400,{error:'String input required.'});return;}
        json(response,200,{model:body.model,embeddings:inputs.map(fixtureEmbedding),total_duration:1,load_duration:0,prompt_eval_count:inputs.join(' ').length});return;
      }
      if(path==='/api/chat'&&body.model===MODELS[0]&&Array.isArray(body.messages)){
        stats.chat++;stats.lastChatRoles=body.messages.map(message=>message.role);stats.lastChatModel=body.model;
        json(response,200,{model:body.model,created_at:new Date().toISOString(),message:{role:'assistant',content:JSON.stringify(fixtureReply(body.messages))},done:true,done_reason:'stop',total_duration:1,load_duration:0,prompt_eval_count:1,eval_count:1});return;
      }
      json(response,400,{error:'Unsupported fixture operation or model capability.'});
    };
    if(JSON.stringify(body).includes('TEST_OLLAMA_TIMEOUT')){
      const timer=setTimeout(complete,30000);timer.unref();response.on('close',()=>clearTimeout(timer));return;
    }
    complete();
  });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const port=Number(process.env.OLLAMA_FIXTURE_PORT||11435);
  const host=process.env.OLLAMA_FIXTURE_HOST||'127.0.0.1';
  if(!['127.0.0.1','::1','0.0.0.0'].includes(host))throw new Error('OLLAMA_FIXTURE_HOST must be a local bind address.');
  const server=createFixtureServer();
  server.listen(port,host,()=>console.log(`Ollama TEST FIXTURE listening on ${host}:${port}; no real model is running.`));
  const stop=()=>{server.closeAllConnections();server.close(()=>process.exit(0));};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
