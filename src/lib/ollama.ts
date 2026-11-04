import {Agent, EnvHttpProxyAgent, fetch as ollamaFetch} from 'undici';

export const DEFAULT_OLLAMA_MODEL = 'qwen3.5:4b';
export class OllamaError extends Error {
  constructor(message:string,public code:string,public status=503){super(message);this.name='OllamaError';}
}
export type OllamaModel={name:string;size:number;digest:string;capabilities:string[]};
export type ChatTurn={role:'system'|'user'|'assistant';content:string};
export type OllamaOptions={signal?:AbortSignal;timeoutSeconds?:number;format?:object};
const directAgent=new Agent({connections:4});
let proxyAgent:EnvHttpProxyAgent|undefined;
function endpoint(path:string){
  let url:URL;
  try{url=new URL(process.env.OLLAMA_BASE_URL||'http://127.0.0.1:11434');}catch{throw new OllamaError('OLLAMA_BASE_URL inválida.','INVALID_URL');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new OllamaError('Configure uma URL HTTP/HTTPS sem credenciais, consulta ou fragmento.','INVALID_URL');
  url.pathname=url.pathname.replace(/\/$/,'')+path;
  return url;
}
async function readJson(response:Awaited<ReturnType<typeof ollamaFetch>>,limit=8*1024*1024){
  if(!response.body)throw new OllamaError('Resposta vazia do Ollama.','INVALID_RESPONSE');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>limit){await reader.cancel();throw new OllamaError('Resposta do Ollama excedeu o limite.','RESPONSE_TOO_LARGE');}chunks.push(part.value);}}
  finally{reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new OllamaError('Ollama retornou JSON inválido.','INVALID_RESPONSE');}
}
async function request(path:string,body?:unknown,options:OllamaOptions={}){
  const url=endpoint(path);
  // Only the explicitly configured local API uses the local network; external endpoints retain the session proxy.
  const local=['localhost','127.0.0.1','[::1]','ollama','host.docker.internal'].includes(url.hostname);
  const dispatcher=local?directAgent:(proxyAgent??=new EnvHttpProxyAgent());
  const configuredTimeout=options.timeoutSeconds??Number(process.env.OLLAMA_TIMEOUT_MS||60000)/1000;
  if(!Number.isFinite(configuredTimeout)||configuredTimeout<=0)throw new OllamaError('OLLAMA_TIMEOUT_MS deve ser um número positivo.','INVALID_TIMEOUT',400);
  const timeout=Math.max(1,Math.min(120,configuredTimeout));
  const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(timeout*1000)]):AbortSignal.timeout(timeout*1000);
  try{
    const response=await ollamaFetch(url,{dispatcher,method:body===undefined?'GET':'POST',redirect:'error',signal,
      headers:{'Content-Type':'application/json',...(process.env.OLLAMA_API_KEY?{Authorization:`Bearer ${process.env.OLLAMA_API_KEY}`}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!response.ok){await response.body?.cancel();throw new OllamaError(response.status===404?'Modelo ou endpoint não encontrado no Ollama.':`Ollama recusou a operação (HTTP ${response.status}).`,response.status===404?'MODEL_NOT_FOUND':'HTTP_ERROR',response.status===404?422:503);}
    return await readJson(response);
  }catch(error){if(error instanceof OllamaError)throw error;if(signal.aborted)throw new OllamaError('Ollama excedeu o tempo de resposta ou a operação foi cancelada.','TIMEOUT',504);throw new OllamaError('Ollama indisponível. Verifique a URL e o serviço local.','UNAVAILABLE');}
}
export async function listOllamaModels():Promise<{models:OllamaModel[];defaultModel:string|null}>{
  const data=await request('/api/tags',undefined,{timeoutSeconds:8});
  if(!Array.isArray(data.models))throw new OllamaError('Lista de modelos inválida.','INVALID_RESPONSE');
  const models:OllamaModel[]=data.models.filter((m:any)=>typeof m.name==='string').map((m:any)=>({name:m.name,size:typeof m.size==='number'?m.size:0,digest:typeof m.digest==='string'?m.digest:'',capabilities:Array.isArray(m.capabilities)?m.capabilities.filter((v:unknown)=>typeof v==='string'):[]}));
  return {models,defaultModel:models.some(m=>m.name===DEFAULT_OLLAMA_MODEL)?DEFAULT_OLLAMA_MODEL:null};
}
export async function getOllamaModel(name:string):Promise<OllamaModel>{
  if(!/^[a-zA-Z0-9._:/-]{1,180}$/.test(name))throw new OllamaError('Nome de modelo inválido.','INVALID_MODEL',400);
  const {models}=await listOllamaModels();const model=models.find(m=>m.name===name);
  if(!model)throw new OllamaError('O modelo selecionado não está instalado no Ollama.','MODEL_NOT_INSTALLED',422);
  const data=await request('/api/show',{model:name},{timeoutSeconds:10});
  const capabilities=Array.isArray(data.capabilities)?data.capabilities.filter((v:unknown)=>typeof v==='string'):[];
  return {...model,capabilities};
}
export function validateEmbedding(value:unknown):number[]{
  if(!Array.isArray(value)||value.length<1||value.length>8192||value.some(n=>typeof n!=='number'||!Number.isFinite(n))||!value.some(n=>n!==0))throw new OllamaError('Ollama retornou um vetor de embeddings inválido.','INVALID_EMBEDDING',422);
  return value;
}
export async function embedText(model:string,text:string,options:OllamaOptions={}):Promise<number[]>{
  if(!text.trim()||text.length>24000)throw new OllamaError('Texto para embeddings inválido.','INVALID_INPUT',400);
  const data=await request('/api/embed',{model,input:text,truncate:false,keep_alive:process.env.OLLAMA_KEEP_ALIVE||'5m'},options);
  return validateEmbedding(data.embeddings?.[0]);
}
export async function chatCompletion(model:string,messages:ChatTurn[],options:OllamaOptions={}):Promise<string>{
  if(messages.length<1||messages.length>26||messages.some(m=>!['system','user','assistant'].includes(m.role)||typeof m.content!=='string'||m.content.length>40000))throw new OllamaError('Contexto de conversa inválido.','INVALID_INPUT',400);
  const data=await request('/api/chat',{model,messages,stream:false,think:false,format:options.format||'json',keep_alive:process.env.OLLAMA_KEEP_ALIVE||'5m',options:{temperature:0.15,num_predict:700,num_ctx:8192}},options);
  if(data.done!==true||data.message?.role!=='assistant'||typeof data.message.content!=='string'||data.message.tool_calls?.length)throw new OllamaError('Resposta do modelo incompleta ou não suportada.','INVALID_RESPONSE');
  return data.message.content;
}
export async function closeOllamaClient(){await directAgent.close();await proxyAgent?.close();}
