import { describe,it,expect,vi } from 'vitest';
vi.mock('../src/lib/db',()=>({db:{}}));
import { assertMutationOrigin } from '../src/lib/auth';
describe('Cross-site request protection',()=>{
 it('accepts only exact configured browser origin',()=>{
  process.env.APP_URL='https://crm.example.com';
  expect(()=>assertMutationOrigin(new Request('https://internal/api/contacts',{headers:{origin:'https://crm.example.com'}}))).not.toThrow();
  for(const origin of ['https://evil.example','http://crm.example.com','https://crm.example.com.evil','null','']) expect(()=>assertMutationOrigin(new Request('https://internal/api/contacts',{headers:{origin}}))).toThrow();
 });
 it('rejects explicit cross-site browser metadata even with a forged origin',()=>{
  process.env.APP_URL='https://crm.example.com';expect(()=>assertMutationOrigin(new Request('https://internal/api/contacts',{headers:{origin:'https://crm.example.com','sec-fetch-site':'cross-site'}}))).toThrow();
 });
});
