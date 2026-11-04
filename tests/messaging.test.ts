import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
const mocked=vi.hoisted(()=>({
  contact:{findUnique:vi.fn()},suppression:{findUnique:vi.fn()},setting:{findUnique:vi.fn()},
  template:{findUniqueOrThrow:vi.fn()},campaign:{create:vi.fn()},auditLog:{create:vi.fn()},connection:{update:vi.fn()},
}));
vi.mock('../src/lib/db',()=>({db:mocked}));
import { decryptSecret, encryptSecret, verifyWebhookSignature } from '../src/lib/crypto';
import { eligibility, createCampaign, renderTemplateBody } from '../src/lib/campaigns';
import { sendTemplate, sendText } from '../src/lib/whatsapp';
import { isOptOut, nextDeliveryStatus, verifyWebhookChallenge } from '../src/lib/webhooks';

beforeEach(()=>{
  vi.clearAllMocks();process.env.ENCRYPTION_KEY='ab'.repeat(32);process.env.WHATSAPP_MODE='mock';process.env.META_APP_SECRET='unit-test-secret';
  mocked.suppression.findUnique.mockResolvedValue(null);
  mocked.contact.findUnique.mockResolvedValue({id:'c',phone:'+5511999999999',doNotContact:false,stage:'PENDING_AUTHORIZATION',consents:[]});
});
describe('segredos e autenticidade da Meta',()=>{
  it('criptografa tokens com nonce diferente e rejeita adulteração',()=>{
    const first=encryptSecret('meta-token'),second=encryptSecret('meta-token');
    expect(first).not.toContain('meta-token');expect(first).not.toBe(second);expect(decryptSecret(first)).toBe('meta-token');
    const parts=first.split('.');parts[3]=Buffer.from('alteração').toString('base64url');
    expect(()=>decryptSecret(parts.join('.'))).toThrow();
  });
  it('valida os bytes originais; rejeita assinatura ausente, chave errada e JSON reformatado',()=>{
    const body='{"object":"whatsapp_business_account"}';
    const sig='sha256='+createHmac('sha256','unit-test-secret').update(body).digest('hex');
    expect(verifyWebhookSignature(body,sig)).toBe(true);expect(verifyWebhookSignature(body+' ',sig)).toBe(false);
    expect(verifyWebhookSignature(body,null)).toBe(false);expect(verifyWebhookSignature(body,'sha256=xyz')).toBe(false);
    delete process.env.META_APP_SECRET;expect(verifyWebhookSignature(body,sig)).toBe(false);
  });
  it('desafio exige token exato configurado e modo subscribe',()=>{
    process.env.META_VERIFY_TOKEN='verify-token';
    expect(verifyWebhookChallenge('subscribe','verify-token','123')).toBe('123');
    expect(verifyWebhookChallenge('subscribe','verify','123')).toBeNull();
    expect(verifyWebhookChallenge('anything','verify-token','123')).toBeNull();
  });
});
describe('bloqueios de comunicação',()=>{
  it('um telefone publicado e Não contatar=Não não fornecem consentimento',async()=>{
    expect(await eligibility('c')).toEqual({eligible:false,reason:'Consentimento documentado não encontrado.'});
  });
  it('exige evidência completa e permite autorização registrada',async()=>{
    mocked.contact.findUnique.mockResolvedValue({phone:'+5511999999999',doNotContact:false,consents:[{source:'formulário',purpose:'marketing',evidence:''}]});
    expect((await eligibility('c')).eligible).toBe(false);
    mocked.contact.findUnique.mockResolvedValue({phone:'+5511999999999',doNotContact:false,consents:[{source:'formulário',purpose:'marketing',evidence:'evento 123'}]});
    expect((await eligibility('c')).eligible).toBe(true);
  });
  it('lista global e marcação não contatar prevalecem sobre autorização',async()=>{
    mocked.contact.findUnique.mockResolvedValue({phone:'+5511999999999',doNotContact:true,consents:[{source:'formulário',purpose:'marketing',evidence:'evento 123'}]});
    expect((await eligibility('c')).eligible).toBe(false);
    mocked.contact.findUnique.mockResolvedValue({phone:'+5511999999999',doNotContact:false,consents:[{source:'formulário',purpose:'marketing',evidence:'evento 123'}]});
    mocked.suppression.findUnique.mockResolvedValue({reason:'opt-out'});expect((await eligibility('c')).eligible).toBe(false);
  });
  it('rejeita modelos não aprovados antes de criar a campanha',async()=>{
    mocked.template.findUniqueOrThrow.mockResolvedValue({connectionId:'n',status:'PENDING',connection:{enabled:true}});
    await expect(createCampaign({name:'Campanha',connectionId:'n',templateId:'t',contactIds:['c']})).rejects.toThrow('aprovado');
    expect(mocked.campaign.create).not.toHaveBeenCalled();
  });
  it('rejeita cabeçalhos variáveis e modelos com mídia não suportados',async()=>{
    mocked.template.findUniqueOrThrow.mockResolvedValue({connectionId:'n',status:'APPROVED',connection:{enabled:true,ratePerMinute:10},components:[{type:'HEADER',format:'TEXT',text:'Olá {{1}}'}],parameterNames:[]});
    await expect(createCampaign({name:'Campanha',connectionId:'n',templateId:'t',contactIds:['c']})).rejects.toThrow('MVP');
    expect(mocked.campaign.create).not.toHaveBeenCalled();
  });
  it('valida posições dos parâmetros e variáveis conhecidas',async()=>{
    mocked.template.findUniqueOrThrow.mockResolvedValue({connectionId:'n',status:'APPROVED',connection:{enabled:true,ratePerMinute:10},components:[],parameterNames:['1']});
    await expect(createCampaign({name:'Campanha',connectionId:'n',templateId:'t',contactIds:['c'],parameters:{'0':'Nome'}})).rejects.toThrow('parâmetros');
    await expect(createCampaign({name:'Campanha',connectionId:'n',templateId:'t',contactIds:['c'],parameters:{'1':'{{consentimento_inventado}}'}})).rejects.toThrow('Variável não suportada');
    expect(mocked.campaign.create).not.toHaveBeenCalled();
  });
  it('orçamento exige preço conservador por envio',async()=>{
    mocked.template.findUniqueOrThrow.mockResolvedValue({connectionId:'n',status:'APPROVED',connection:{enabled:true,ratePerMinute:10},components:[],parameterNames:[]});
    await expect(createCampaign({name:'Campanha',connectionId:'n',templateId:'t',contactIds:['c'],maxBudgetCents:100})).rejects.toThrow('custo conservador');
  });
  it('modo simulado exige habilitação explícita e usa identificador estável',async()=>{
    const connection={id:'n',mode:'MOCK',encryptedToken:null,phoneNumberId:'123',wabaId:'w',enabled:true};
    const template={name:'teste',language:'pt_BR',status:'APPROVED'};
    const first=await sendTemplate(connection,template,'+5511999999999',[],'unique');
    expect(first).toMatch(/^mock_/);expect(await sendTemplate(connection,template,'+5511999999999',[],'unique')).toBe(first);
    process.env.WHATSAPP_MODE='live';await expect(sendTemplate(connection,template,'+5511999999999',[],'unique')).rejects.toThrow('simulada');
  });
  it('não faz fallback de conexão real para simulação e não envia com modelo rejeitado',async()=>{
    const connection={id:'n',mode:'META',encryptedToken:null,phoneNumberId:'123',wabaId:'w',enabled:true};
    await expect(sendText(connection,'+5511999999999','teste','key')).rejects.toThrow('real exige');
    await expect(sendTemplate({...connection,mode:'MOCK'},{name:'x',language:'pt_BR',status:'REJECTED'},'+5511999999999',[],'key')).rejects.toThrow('aprovado');
  });
});
describe('renderização de modelos',()=>{
  it('mantém a mensagem com as posições exatas aprovadas no histórico',()=>{
    expect(renderTemplateBody([{type:'BODY',text:'Olá {{1}}, a {{2}} agradece. Até breve, {{1}}!'}],'boas_vindas',['Maria','Empresa X'])).toBe('Olá Maria, a Empresa X agradece. Até breve, Maria!');
  });
});
describe('webhooks e cancelamento',()=>{
  it.each(['SAIR','Parar!','não quero receber mais mensagens','Pare de me enviar ofertas','remova meu número','Excluir.'])('reconhece opt-out: %s',text=>expect(isOptOut(text)).toBe(true));
  it('não confunde respostas normais com revogação',()=>{expect(isOptOut('Quero falar com um atendente')).toBe(false);expect(isOptOut('O produto tem botão parar?')).toBe(false);});
  it('webhooks fora de ordem não fazem status de leitura regredir',()=>{
    expect(nextDeliveryStatus('READ','SENT')).toBe('READ');expect(nextDeliveryStatus('DELIVERED','SENT')).toBe('DELIVERED');
    expect(nextDeliveryStatus('UNKNOWN','DELIVERED')).toBe('DELIVERED');expect(nextDeliveryStatus('READ','FAILED')).toBe('READ');
    expect(nextDeliveryStatus('SENT','FAILED')).toBe('FAILED');
  });
});
