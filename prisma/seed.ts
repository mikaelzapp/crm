import { hash } from 'bcryptjs';
import { db } from '../src/lib/db';

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Defina ADMIN_EMAIL válido antes de executar o seed.');
  if (!password || password.length < 12) throw new Error('Defina ADMIN_PASSWORD com pelo menos 12 caracteres. Não há senha padrão.');
  // Rerunning a seed never silently resets an existing account password.
  await db.user.upsert({ where: { email }, create: { email, name: 'Administrador', passwordHash: await hash(password, 12), role: 'ADMIN' }, update: {} });
  await db.setting.upsert({ where: { key: 'emergencyStop' }, create: { key: 'emergencyStop', value: false }, update: {} });
  await db.setting.upsert({ where: { key: 'pipelineStages' }, create: { key: 'pipelineStages', value: [
    { id: 'PENDING_AUTHORIZATION', name: 'Pendente de autorização' },
    { id: 'ELIGIBLE', name: 'Elegível para contato' },
    { id: 'CONTACTED', name: 'Contatado' },
    { id: 'RESPONDED', name: 'Respondeu' },
    { id: 'INTERESTED', name: 'Interessado' },
    { id: 'NEGOTIATION', name: 'Negociação' },
    { id: 'CUSTOMER', name: 'Cliente' },
    { id: 'LOST', name: 'Perdido' },
    { id: 'DO_NOT_CONTACT', name: 'Não contatar' },
  ] }, update: {} });
  if (process.env.MOCK_WHATSAPP_ENABLED === 'true') {
    for (let i = 1; i <= 2; i++) {
      const connection = await db.connection.upsert({ where: { phoneNumberId: `mock-number-${i}` }, create: { name: `TESTE • WhatsApp ${i}`, phone: `+551199999000${i}`, wabaId: 'mock-waba', phoneNumberId: `mock-number-${i}`, mode: 'MOCK', status: 'CONNECTED', quality: 'GREEN', ratePerMinute: 10 }, update: {} });
      await db.template.upsert({ where: { connectionId_name_language: { connectionId: connection.id, name: 'mock_boas_vindas', language: 'pt_BR' } }, create: { connectionId: connection.id, name: 'mock_boas_vindas', language: 'pt_BR', status: 'APPROVED', components: [{ type: 'BODY', text: 'Olá {{1}}, recebemos sua autorização para conversar sobre {{2}}.' }], parameterNames: ['socio', 'empresa'] }, update: {} });
    }
  }
  console.log('Administrador e configurações iniciais preparados. Nenhum contato recebe consentimento pelo seed.');
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Falha no seed'); process.exitCode = 1; }).finally(() => db.$disconnect());
