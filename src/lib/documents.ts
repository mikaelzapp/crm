import { Worker } from 'node:worker_threads';
import path from 'node:path';

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_CHARACTERS = 100_000;
export type ExtractedDocument = { type: 'TXT' | 'PDF' | 'DOCX'; content: string };

// Parsers run outside the web event loop, with a hard deadline and bounded heap.
// No document is written to disk, rendered as HTML, or given a network URL.
const extractionWorker = String.raw`
const {parentPort,workerData}=require('node:worker_threads');
const {createRequire}=require('node:module');
const requirePackage=createRequire(workerData.packagePath);
const buffer=Buffer.from(workerData.buffer);
const maxChars=workerData.maxChars;
function textLimit(text){
  text=text.replace(/\u0000/g,'').replace(/\r\n?/g,'\n').trim();
  if(Array.from(text).length>maxChars)throw new Error('Documento excede 100 mil caracteres de texto. Divida o documento antes de enviar.');
  if(!text)throw new Error('Documento sem texto extraível. PDFs digitalizados e imagens precisam de OCR externo, que não está incluído.');
  return text;
}
async function inspectDocx(){
 const yauzl=requirePackage('yauzl');
 await new Promise((resolve,reject)=>{
  yauzl.fromBuffer(buffer,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true,autoClose:true},(error,zip)=>{
   if(error||!zip){reject(new Error('DOCX inválido ou corrompido.'));return;}
   let settled=false,count=0,total=0,hasDocument=false,hasTypes=false;
   const fail=message=>{if(settled)return;settled=true;zip.close();reject(new Error(message));};
   zip.on('error',()=>fail('DOCX inválido ou descompactação inconsistente.'));
   zip.on('end',()=>{if(!settled){settled=true;if(!hasDocument||!hasTypes)reject(new Error('O arquivo não contém a estrutura de um DOCX.'));else resolve();}});
   zip.on('entry',entry=>{
    count++;
    if(count>300)return fail('DOCX excede o limite de 300 componentes.');
    if(entry.generalPurposeBitFlag&1)return fail('DOCX criptografado não é suportado.');
    if(entry.fileName.startsWith('/')||entry.fileName.split('/').includes('..')||entry.fileName.includes('\\'))return fail('DOCX contém caminho de arquivo inválido.');
    if(((entry.externalFileAttributes>>>16)&0xf000)===0xa000)return fail('DOCX com links simbólicos não é suportado.');
    if(entry.uncompressedSize>8*1024*1024||entry.uncompressedSize>Math.max(1024*1024,entry.compressedSize*200))return fail('DOCX excede os limites seguros de descompactação.');
    if(entry.fileName==='word/document.xml')hasDocument=true;
    if(entry.fileName==='[Content_Types].xml')hasTypes=true;
    if(entry.fileName.endsWith('/')){zip.readEntry();return;}
    zip.openReadStream(entry,(error,stream)=>{
     if(error||!stream){fail('Não foi possível ler um componente do DOCX.');return;}
     let current=0;
     stream.on('error',()=>fail('DOCX corrompido ou tamanho descompactado inválido.'));
     stream.on('data',chunk=>{
      current+=chunk.length;total+=chunk.length;
      if(current>8*1024*1024||total>20*1024*1024){stream.destroy();fail('DOCX excede o limite total de descompactação.');}
     });
     stream.on('end',()=>{if(!settled)zip.readEntry();});
    });
   });
   zip.readEntry();
  });
 });
}
async function main(){
 if(workerData.type==='DOCX'){
  await inspectDocx();
  const mammoth=requirePackage('mammoth');
  const result=await mammoth.extractRawText({buffer});
  return textLimit(result.value);
 }
 const {PDFParse}=requirePackage('pdf-parse');
 const parser=new PDFParse({data:new Uint8Array(buffer),isEvalSupported:false,useSystemFonts:false,disableFontFace:true,verbosity:0});
 try{
  const info=await parser.getInfo();
  if(info.total>100)throw new Error('PDF excede o limite de 100 páginas. Divida o documento antes de enviar.');
  let text='';
  for(let page=1;page<=info.total;page++){
   const result=await parser.getText({partial:[page],pageJoiner:'',parseHyperlinks:false});
   text+='\n'+result.text;
   if(text.length>maxChars*2||Array.from(text).length>maxChars)throw new Error('Documento excede 100 mil caracteres de texto.');
  }
  return textLimit(text);
 }catch(error){
  if(error?.name==='PasswordException'||/password|encrypted/i.test(error?.message||''))throw new Error('PDF criptografado ou protegido por senha não é suportado.');
  throw error;
 }finally{await parser.destroy();}
}
main().then(content=>parentPort.postMessage({content})).catch(error=>parentPort.postMessage({error:error instanceof Error?error.message:'Documento inválido.'}));
`;

export async function extractDocument(buffer: Buffer, fileName: string): Promise<ExtractedDocument> {
  if (!buffer.length || buffer.length > MAX_DOCUMENT_BYTES) throw new Error('O arquivo deve conter entre 1 byte e 5 MiB.');
  const extension = path.extname(fileName).toLowerCase();
  if (!['.txt', '.pdf', '.docx'].includes(extension)) throw new Error('Formato não suportado. Envie TXT UTF-8, PDF com texto ou DOCX.');
  if (extension === '.txt') {
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim(); }
    catch { throw new Error('O TXT deve estar codificado em UTF-8.'); }
    if (content.includes('\u0000') || /[\u0001-\u0008\u000B\u000C\u000E-\u001F]/.test(content)) throw new Error('O TXT contém dados binários.');
    if (!content || Array.from(content).length > MAX_DOCUMENT_CHARACTERS) throw new Error('O texto deve conter entre 1 e 100 mil caracteres.');
    return { type: 'TXT', content };
  }
  const type = extension === '.pdf' ? 'PDF' : 'DOCX';
  if (type === 'PDF' && buffer.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('O conteúdo não corresponde a um PDF.');
  if (type === 'DOCX' && !buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new Error('O conteúdo não corresponde a um DOCX.');
  return new Promise((resolve, reject) => {
    const worker = new Worker(extractionWorker, {
      eval: true,
      execArgv: [],
      workerData: { buffer, type, maxChars: MAX_DOCUMENT_CHARACTERS, packagePath: path.join(process.cwd(), 'package.json') },
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    let settled = false;
    const finish = (error?: Error, content?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      void worker.terminate();
      if (error) reject(error); else resolve({ type, content: content! });
    };
    const deadline = setTimeout(() => finish(new Error('Extração excedeu 20 segundos. Divida o documento em arquivos menores.')), 20_000);
    worker.on('message', (result: { content?: string; error?: string }) => {
      if (result.error) finish(new Error(result.error.slice(0, 500)));
      else if (typeof result.content === 'string') finish(undefined, result.content);
      else finish(new Error('O parser não retornou texto utilizável.'));
    });
    worker.on('error', () => finish(new Error('Documento excedeu os limites de processamento ou está corrompido.')));
    worker.on('exit', () => { if (!settled) finish(new Error('A extração do documento foi interrompida.')); });
  });
}
