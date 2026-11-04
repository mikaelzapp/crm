import { describe, expect, it } from 'vitest';
import { detectCsvMapping, normalizeBrazilianPhone, normalizeCnpj, parseCsv, validCnpj } from '../src/lib/csv';

describe('CSV parsing and original source preservation', () => {
  it('handles BOM, Portuguese semicolon headings, quoted separators and multiline drafts', () => {
    const input = '\uFEFFEmpresa;CNPJ;Telefone escolhido para abordagem;Mensagem personalizada para WhatsApp;Não contatar\r\n"Empresa; um";11.222.333/0001-81;(11) 99999-1234;"Olá, Ana!\nPodemos conversar?";Não\r\n';
    const preview = parseCsv(Buffer.from(input));
    expect(preview.columns).toHaveLength(5);
    expect(preview.rows).toHaveLength(1);
    expect(preview.rows[0]['Empresa']).toBe('Empresa; um');
    expect(preview.rows[0]['Mensagem personalizada para WhatsApp']).toBe('Olá, Ana!\nPodemos conversar?');
    expect(preview.rows[0]['Não contatar']).toBe('Não');
    expect(preview.suggestedMapping.phone).toBe('Telefone escolhido para abordagem');
    expect(preview.suggestedMapping.messageDraft).toBe('Mensagem personalizada para WhatsApp');
  });
  it('detects commas and tabs without splitting quoted values', () => {
    expect(parseCsv('Empresa,Telefone,Descrição\nEmpresa A,11999991234,"texto, com vírgula"').rows[0]['Descrição']).toBe('texto, com vírgula');
    expect(parseCsv('Empresa\tTelefone\nEmpresa A\t11999991234').columns).toEqual(['Empresa', 'Telefone']);
  });
  it('preserves all 37 original columns without creating consent', () => {
    const columns = ['Empresa', ...Array.from({ length: 36 }, (_, i) => `Fonte ${i}`)];
    const preview = parseCsv(columns.join(';') + '\n' + columns.map((_, i) => `valor ${i}`).join(';'));
    expect(Object.keys(preview.rows[0])).toEqual(columns);
    expect(preview.rows[0]).not.toHaveProperty('consent');
  });
  it('accepts manual mappings, accents, and rejects unknown columns', () => {
    const preview = parseCsv('Fornecedor;Celular\nA;11999991234', { companyName: 'Fornecedor', phone: 'Celular' });
    expect(preview.suggestedMapping).toMatchObject({ companyName: 'Fornecedor', phone: 'Celular' });
    expect(detectCsvMapping(['razao social', 'Municipio'])).toEqual({ legalName: 'razao social', city: 'Municipio' });
    expect(() => parseCsv('Empresa;Telefone\nA;11999991234', { phone: 'missing' })).toThrow('Coluna mapeada');
  });
  it('rejects duplicate headers, malformed records, and empty files', () => {
    expect(() => parseCsv('Empresa;Empresa\nA;B')).toThrow('duplicados');
    expect(() => parseCsv('Empresa;Telefone\nA;123;extra')).toThrow();
    expect(() => parseCsv('')).toThrow('vazio');
  });
});

describe('Brazilian phone validation', () => {
  it.each(['(11) 99999-1234', '+55 11 99999-1234', '5511999991234', '005511999991234'])('normalizes %s', input => {
    expect(normalizeBrazilianPhone(input)).toBe('+5511999991234');
  });
  it('accepts geographic business landlines', () => {
    expect(normalizeBrazilianPhone('(11) 3333-4444')).toBe('+551133334444');
  });
  it.each(['', '00000000000', '+1 202 555 0100', '11999991234;11999995678', 'não encontrado', '11999991234 ramal 3', '123'])('rejects unusable or ambiguous %s', input => {
    expect(normalizeBrazilianPhone(input)).toBeNull();
  });
});

describe('CNPJ source identifiers', () => {
  it('normalizes without deleting original source values', () => {
    expect(normalizeCnpj('11.222.333/0001-81')).toBe('11222333000181');
    expect(validCnpj('11222333000181')).toBe(true);
    expect(validCnpj('11222333000180')).toBe(false);
    expect(validCnpj('00000000000000')).toBe(false);
    expect(normalizeCnpj('missing')).toBeNull();
  });
});
