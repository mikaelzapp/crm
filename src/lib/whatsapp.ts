import { EnvHttpProxyAgent, fetch as proxyFetch } from 'undici';
import { createHash } from 'node:crypto';
import { decryptSecret } from './crypto';
import { db } from './db';

export interface WhatsAppConnection { id: string; mode: string; encryptedToken: string | null; phoneNumberId: string; wabaId: string; enabled: boolean; quality?: string; }
export interface WhatsAppTemplate { name: string; language: string; status: string; }
export class ProviderError extends Error {
  constructor(message: string, public code: string, public retryable = false, public ambiguous = false) { super(message); this.name = 'ProviderError'; }
}
let agent: EnvHttpProxyAgent | undefined;
function mockAllowed(connection: WhatsAppConnection) {
  if (connection.mode === 'MOCK') {
    if (process.env.WHATSAPP_MODE !== 'mock') throw new ProviderError('Conexão simulada exige WHATSAPP_MODE=mock.', 'MODE_MISMATCH');
    return true;
  }
  if (process.env.WHATSAPP_MODE !== 'live') throw new ProviderError('Envio real exige WHATSAPP_MODE=live explicitamente.', 'LIVE_DISABLED');
  return false;
}
async function graph(connection: WhatsAppConnection, path: string, body?: object): Promise<Record<string, any>> {
  if (!connection.encryptedToken) throw new ProviderError('Token da Meta não configurado.', 'NO_TOKEN');
  const version = process.env.META_API_VERSION || 'v23.0';
  if (!/^v\d+\.\d+$/.test(version)) throw new ProviderError('Versão Graph inválida.', 'INVALID_VERSION');
  const token = decryptSecret(connection.encryptedToken);
  try {
    agent ??= new EnvHttpProxyAgent();
    const response = await proxyFetch(`https://graph.facebook.com/${version}/${path}`, {
      method: body ? 'POST' : 'GET', dispatcher: agent,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000),
    });
    const data = await response.json() as Record<string, any>;
    if (!response.ok || data.error) {
      const code = String(data.error?.code || response.status);
      // These Graph error codes explicitly reject requests. Unknown server failures may have accepted a send.
      const retryable = response.status === 429 || ['4','17','32','613','130429','131056'].includes(code);
      const restriction = ['368','131031','131048','131049'].includes(code);
      if (restriction) await db.connection.update({where:{id:connection.id},data:{enabled:false,status:'RESTRICTED'}});
      throw new ProviderError(`Meta recusou a operação (HTTP ${response.status}, código ${code}).`, code, retryable, response.status >= 500 && !retryable);
    }
    return data;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    // Network errors are deliberately not retried: Meta may have accepted the request before the connection broke.
    throw new ProviderError('Não foi possível confirmar o resultado da operação na Meta. Reconciliação necessária.', 'UNKNOWN_RESULT', false, true);
  }
}
export async function sendTemplate(connection: WhatsAppConnection, template: WhatsAppTemplate, phone: string, parameters: string[], key: string): Promise<string> {
  if (!connection.enabled || ['RED','FLAGGED'].includes(connection.quality || '')) throw new ProviderError('Conexão desabilitada ou qualidade restrita.', 'CONNECTION_DISABLED');
  if (template.status !== 'APPROVED') throw new ProviderError('O modelo deve estar aprovado.', 'TEMPLATE_UNAPPROVED');
  if (mockAllowed(connection)) return `mock_${createHash('sha256').update(key).digest('hex').slice(0,32)}`;
  const data = await graph(connection, `${encodeURIComponent(connection.phoneNumberId)}/messages`, {
    messaging_product:'whatsapp', to:phone.replace(/^\+/,''), type:'template',
    biz_opaque_callback_data:key,
    template:{ name:template.name, language:{code:template.language},
      ...(parameters.length ? {components:[{type:'body',parameters:parameters.map(text=>({type:'text',text}))}]} : {}) },
  });
  if (!data.messages?.[0]?.id) throw new ProviderError('Resposta da Meta sem ID de mensagem.', 'UNKNOWN_RESULT', false, true);
  return data.messages[0].id;
}
export async function sendText(connection: WhatsAppConnection, phone: string, text: string, key: string): Promise<string> {
  if (!connection.enabled || ['RED','FLAGGED'].includes(connection.quality || '')) throw new ProviderError('Conexão desabilitada ou qualidade restrita.', 'CONNECTION_DISABLED');
  if (mockAllowed(connection)) return `mock_${createHash('sha256').update(key).digest('hex').slice(0,32)}`;
  const data = await graph(connection, `${encodeURIComponent(connection.phoneNumberId)}/messages`, {
    messaging_product:'whatsapp',to:phone.replace(/^\+/,''),type:'text',text:{body:text},biz_opaque_callback_data:key,
  });
  if (!data.messages?.[0]?.id) throw new ProviderError('Resposta da Meta sem ID de mensagem.', 'UNKNOWN_RESULT', false, true);
  return data.messages[0].id;
}
export async function syncTemplates(connectionId: string) {
  const connection = await db.connection.findUniqueOrThrow({where:{id:connectionId}});
  if (mockAllowed(connection)) {
    return db.template.upsert({where:{connectionId_name_language:{connectionId,name:'boas_vindas_teste',language:'pt_BR'}},
      create:{connectionId,name:'boas_vindas_teste',language:'pt_BR',status:'APPROVED',components:[{type:'BODY',text:'Olá {{1}}, recebemos sua autorização para conversar com a {{2}}.'}],parameterNames:['socio','empresa']},
      update:{status:'APPROVED'}});
  }
  let nextPath = `${encodeURIComponent(connection.wabaId)}/message_templates?limit=100`;
  const templates = [];
  for (let page=0;page<100;page++) {
    const data = await graph(connection,nextPath);
    for (const item of data.data || []) {
      const body: string = String(item.components?.find((c: any)=>c.type === 'BODY')?.text || '');
      const variables: string[] = [...new Set<string>((body.match(/\{\{(\d+)\}\}/g) || []).map((s:string)=>s.replace(/[{}]/g,'')))];
      templates.push(await db.template.upsert({where:{connectionId_name_language:{connectionId,name:item.name,language:item.language}},
        create:{connectionId,name:item.name,language:item.language,status:item.status,components:item.components||[],parameterNames:variables},
        update:{status:item.status,components:item.components||[],parameterNames:variables}}));
    }
    const cursor = data.paging?.cursors?.after;
    if (!data.paging?.next || !cursor) return templates;
    nextPath = `${encodeURIComponent(connection.wabaId)}/message_templates?limit=100&after=${encodeURIComponent(cursor)}`;
  }
  throw new ProviderError('Paginação de modelos excedeu limite operacional.', 'PAGINATION_LIMIT');
}
export async function verifyConnection(connectionId: string) {
  const connection = await db.connection.findUniqueOrThrow({where:{id:connectionId}});
  if (mockAllowed(connection)) return db.connection.update({where:{id:connectionId},data:{status:'CONNECTED',quality:'MOCK'}});
  const result = await graph(connection, `${encodeURIComponent(connection.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`);
  return db.connection.update({where:{id:connectionId},data:{status:result.quality_rating==='RED'?'RESTRICTED':'CONNECTED',quality:result.quality_rating || 'UNKNOWN',phone:result.display_phone_number || connection.phone,...(result.quality_rating==='RED'?{enabled:false}:{})}});
}
