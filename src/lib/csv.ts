import { parse } from 'csv-parse/sync';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import type { Prisma } from '@prisma/client';

export const CSV_FIELDS = [
  { key: 'companyName', label: 'Empresa' },
  { key: 'legalName', label: 'Razão social' },
  { key: 'cnpj', label: 'CNPJ' },
  { key: 'name', label: 'Nome do contato' },
  { key: 'email', label: 'E-mail' },
  { key: 'phone', label: 'Telefone' },
  { key: 'messageDraft', label: 'Rascunho de mensagem' },
  { key: 'city', label: 'Município' },
  { key: 'state', label: 'UF' },
  { key: 'segment', label: 'Segmento' },
  { key: 'priority', label: 'Prioridade' },
  { key: 'doNotContact', label: 'Não contatar' },
] as const;
export type CsvField = typeof CSV_FIELDS[number]['key'];
export type CsvMapping = Partial<Record<CsvField, string>>;
export type CsvRow = Record<string, string>;
const normalized = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const aliases: Record<CsvField, string[]> = {
  companyName: ['Empresa', 'Nome fantasia', 'company', 'companyName'],
  legalName: ['Razão social', 'legalName'],
  cnpj: ['CNPJ'],
  name: ['Sócio para saudação', 'Nome do sócio (cadastro)', 'Nome do contato', 'Nome', 'name'],
  email: ['E-mail empresarial', 'E-mail', 'email'],
  phone: ['Telefone escolhido para abordagem', 'Telefone WhatsApp encontrado', 'Telefone comercial encontrado', 'Telefone', 'phone'],
  messageDraft: ['Mensagem personalizada para WhatsApp', 'Mensagem', 'messageDraft'],
  city: ['Município', 'Cidade', 'city'],
  state: ['UF', 'Estado', 'state'],
  segment: ['Segmento', 'segment'],
  priority: ['Prioridade', 'priority'],
  doNotContact: ['Não contatar', 'doNotContact'],
};

export function detectCsvMapping(columns: string[]): CsvMapping {
  const byName = new Map(columns.map(column => [normalized(column), column]));
  return Object.fromEntries(Object.entries(aliases).flatMap(([key, names]) => {
    const column = names.map(name => byName.get(normalized(name))).find(Boolean);
    return column ? [[key, column]] : [];
  }));
}

function detectDelimiter(text: string): string {
  const counts = new Map([[';', 0], [',', 0], ['\t', 0], ['|', 0]]);
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { i++; continue; }
      quoted = !quoted;
    }
    if (!quoted && (c === '\n' || c === '\r')) break;
    if (!quoted && counts.has(c)) counts.set(c, counts.get(c)! + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

export function parseCsv(buffer: Buffer | string, mapping: CsvMapping = {}) {
  if (Buffer.byteLength(buffer) > 20 * 1024 * 1024) throw new Error('Arquivo excede 20 MB. Divida a base em arquivos menores.');
  const text = (typeof buffer === 'string' ? buffer : buffer.toString('utf8')).replace(/^\uFEFF/, '');
  const records = parse(text, { delimiter: detectDelimiter(text), bom: true, skip_empty_lines: true, max_record_size: 1024 * 1024 }) as string[][];
  if (records.length === 0) throw new Error('CSV vazio.');
  const columns = records[0].map(column => column.trim());
  if (columns.some(column => !column)) throw new Error('O CSV contém coluna sem nome.');
  if (new Set(columns).size !== columns.length) throw new Error('O CSV contém nomes de coluna duplicados. Renomeie as colunas antes de importar.');
  if (records.length > 100001) throw new Error('Limite de 100 mil registros por importação.');
  const rows = records.slice(1).filter(row => row.some(value => value.trim())).map(row => Object.fromEntries(columns.map((column, i) => [column, row[i] ?? ''])));
  for (const [field, column] of Object.entries(mapping)) {
    if (!CSV_FIELDS.some(item => item.key === field)) throw new Error(`Campo de mapeamento inválido: ${field}`);
    if (column && !columns.includes(column)) throw new Error(`Coluna mapeada não encontrada: ${column}`);
  }
  return { columns, rows, suggestedMapping: { ...detectCsvMapping(columns), ...mapping } };
}

/** Only valid Brazilian geographic mobile/landline numbers; no WhatsApp or consent claim. */
export function normalizeBrazilianPhone(value?: string | null): string | null {
  if (!value?.trim()) return null;
  const raw = value.trim();
  if (/[a-zA-Z]/.test(raw) || /(?:\s(?:ou|e)\s)|[;/]/i.test(raw)) return null;
  const digits = raw.replace(/\D/g, '');
  const candidate = digits.startsWith('0055') ? '+' + digits.slice(2) : raw;
  const number = parsePhoneNumberFromString(candidate, 'BR');
  if (!number || number.country !== 'BR' || !number.isValid() || number.ext) return null;
  const type = number.getType();
  return type === 'MOBILE' || type === 'FIXED_LINE' || type === 'FIXED_LINE_OR_MOBILE' ? number.number : null;
}

export function normalizeCnpj(value?: string | null): string | null {
  const digits = (value ?? '').replace(/\D/g, '');
  // Preserve supplied identifiers; structural/check-digit problems are reported independently.
  return digits.length === 14 ? digits : null;
}

export function validCnpj(value: string): boolean {
  if (!/^\d{14}$/.test(value) || /^(\d)\1+$/.test(value)) return false;
  const digit = (base: string) => {
    const weights = base.length === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
    const remainder = base.split('').reduce((sum, char, i) => sum + Number(char) * weights[i], 0) % 11;
    return remainder < 2 ? '0' : String(11 - remainder);
  };
  return digit(value.slice(0,12)) === value[12] && digit(value.slice(0,13)) === value[13];
}

export async function importContacts(buffer: Buffer | string, fileName: string, mapping: CsvMapping = {}, userId?: string) {
  const { db } = await import('./db');
  const { columns, rows, suggestedMapping } = parseCsv(buffer, mapping);
  if (!suggestedMapping.companyName) throw new Error('Mapeie a coluna Empresa antes de importar.');
  const batch = await db.importBatch.create({ data: { fileName: fileName.slice(0, 255), columns, total: rows.length } });
  const errors: { row: number; field: string; message: string }[] = [];
  let created = 0, updated = 0, invalid = 0;
  try {
    for (const [index, row] of rows.entries()) {
      const get = (field: CsvField) => row[suggestedMapping[field] ?? '']?.trim() || '';
      const companyName = get('companyName');
      const warnings: string[] = [];
      const rawPhone = get('phone');
      const phone = normalizeBrazilianPhone(rawPhone);
      const cnpj = normalizeCnpj(get('cnpj'));
      if (get('cnpj') && (!cnpj || !validCnpj(cnpj))) warnings.push('CNPJ com formato ou dígitos verificadores inválidos; revise o dado original.');
      if (!phone) warnings.push(rawPhone ? 'Telefone brasileiro inválido; contato bloqueado para envio até correção.' : 'Telefone ausente; contato bloqueado para envio.');
      if (!companyName) warnings.push('Empresa ausente; registro não cadastrado.');
      if (warnings.length) {
        invalid++;
        for (const message of warnings) errors.push({ row: index + 2, field: message.startsWith('CNPJ') ? 'cnpj' : message.startsWith('Empresa') ? 'companyName' : 'phone', message });
      }
      await db.$transaction(async tx => {
        // Serialize overlapping imports to keep company/contact matching deterministic.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(82611421)`;
        if (!companyName) {
          await tx.importRow.create({ data: { importBatchId: batch.id, rowNumber: index + 2, originalData: row, warnings } });
          return;
        }
        let company = cnpj ? await tx.company.findUnique({ where: { cnpj } }) : null;
        let contact = phone ? await tx.contact.findFirst({ where: { phone, ...(company ? { companyId: company.id } : {}) }, orderBy: { createdAt: 'asc' }, include: { company: true } }) : null;
        // A different nonempty CNPJ is a different business even if they share a switchboard.
        if (contact && cnpj && contact.company.cnpj && contact.company.cnpj !== cnpj) contact = null;
        if (!company && contact) company = contact.company;
        if (!company && !cnpj) company = await tx.company.findFirst({ where: { name: companyName, city: get('city') || null, state: get('state') || null }, orderBy: { createdAt: 'asc' } });
        const companyData = {
          name: companyName,
          ...(get('legalName') ? { legalName: get('legalName') } : {}),
          ...(cnpj ? { cnpj } : {}),
          ...(get('segment') ? { segment: get('segment') } : {}),
          ...(get('city') ? { city: get('city') } : {}),
          ...(get('state') ? { state: get('state') } : {}),
        };
        company = company ? await tx.company.update({ where: { id: company.id }, data: companyData }) : await tx.company.create({ data: companyData });
        if (!contact) contact = await tx.contact.findFirst({ where: { companyId: company.id, phone }, orderBy: { createdAt: 'asc' }, include: { company: true } });
        const excluded = ['sim','s','yes','true','1'].includes(normalized(get('doNotContact')));
        const suppressed = phone ? await tx.suppression.findUnique({ where: { phone } }) : null;
        const doNotContact = excluded || !!suppressed || !!contact?.doNotContact;
        const contactData = {
          companyId: company.id,
          name: get('name') || companyName,
          ...(phone ? { phone } : {}),
          ...(rawPhone ? { rawPhone } : {}),
          ...(get('email') ? { email: get('email') } : {}),
          ...(get('priority') ? { priority: get('priority') } : {}),
          ...(get('messageDraft') ? { messageDraft: get('messageDraft') } : {}),
          originalData: row,
          doNotContact,
          ...(doNotContact ? { stage: 'DO_NOT_CONTACT' } : {}),
        };
        const saved = contact ? await tx.contact.update({ where: { id: contact.id }, data: contactData }) : await tx.contact.create({ data: contactData });
        if (contact?.messageDraft && get('messageDraft') && contact.messageDraft !== get('messageDraft')) {
          await tx.messageDraftVersion.create({ data: { contactId: saved.id, body: contact.messageDraft, authorId: userId } });
        }
        if (contact) updated++; else created++;
        if (excluded && phone) await tx.suppression.upsert({ where: { phone }, create: { phone, reason: 'Não contatar informado em importação CSV' }, update: {} });
        if (doNotContact && phone) {
          await tx.contact.updateMany({ where: { phone }, data: { doNotContact: true, stage: 'DO_NOT_CONTACT' } });
          await tx.consent.updateMany({ where: { contact: { phone }, revokedAt: null }, data: { revokedAt: new Date() } });
        }
        await tx.importRow.create({ data: { importBatchId: batch.id, rowNumber: index + 2, contactId: saved.id, originalData: row, warnings } });
      }, { timeout: 15000 });
    }
    const saved = await db.importBatch.update({ where: { id: batch.id }, data: { status: 'COMPLETED', created, updated, invalid, errors: errors as Prisma.InputJsonValue } });
    await db.auditLog.create({ data: { userId, action: 'CSV_IMPORTED', entityId: batch.id, metadata: { total: rows.length, created, updated, invalid } } });
    return saved;
  } catch (error) {
    await db.importBatch.update({ where: { id: batch.id }, data: { status: 'FAILED', created, updated, invalid, errors: [...errors, { message: 'Falha de processamento. Os registros já importados foram preservados; reimporte para retomar sem duplicação.' }] } });
    throw error;
  }
}
