import {test,expect,type Page,type Locator} from '@playwright/test';
import {mkdir} from 'node:fs/promises';

const browserErrors=new WeakMap<Page,string[]>();
test.beforeEach(async({page})=>{
  const errors:string[]=[];browserErrors.set(page,errors);
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
});
test.afterEach(async({page})=>{expect(browserErrors.get(page)||[]).toEqual([]);});
const heading='Seu CRM, pronto para começar.';
async function commandBlock(panel:Locator,pattern:RegExp){
  const blocks=panel.locator('.installation-code-block');
  for(let i=0;i<await blocks.count();i++)if(pattern.test(await blocks.nth(i).locator('pre code').innerText()))return blocks.nth(i);
  throw new Error(`Nenhum comando da plataforma contém o padrão esperado ${pattern}`);
}
async function imagesLoaded(page:Page){
  const gallery=page.locator('.installation-gallery img');await expect(gallery).toHaveCount(3);
  for(const image of await gallery.all()){
    await image.scrollIntoViewIfNeeded();
    await expect.poll(()=>image.evaluate(element=>({loaded:(element as HTMLImageElement).complete,width:(element as HTMLImageElement).naturalWidth}))).toMatchObject({loaded:true});
    expect(await image.evaluate(element=>(element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect((await image.getAttribute('alt'))?.trim().length).toBeGreaterThan(10);
  }
}

test('Guia público: quatro plataformas, comandos específicos e cópia real sem executar instalações',async({page,context,baseURL})=>{
  const apiCalls:string[]=[],mutations:string[]=[];
  page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/'))apiCalls.push(request.method());if(!['GET','HEAD','OPTIONS'].includes(request.method()))mutations.push(request.method());});
  await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(baseURL!).origin});
  await page.goto('/instalacao');
  await expect(page.getByRole('heading',{name:heading,exact:true})).toBeVisible();
  expect((await context.cookies()).some(cookie=>cookie.name==='crm_session')).toBe(false);
  const tabs=page.getByRole('tablist',{name:'Sistema operacional'});await expect(tabs.getByRole('tab')).toHaveCount(4);
  const platforms=[
    {name:/^Windows 11\b/,id:'windows',command:/instalar\.bat/i},
    {name:/^Linux\b/,id:'linux',command:/id -u/},
    {name:/^TrueNAS SCALE\b/,id:'truenas',command:/APP_URL|BIND_ADDRESS/},
    {name:/^macOS\b/,id:'macos',command:/id -u/},
  ];
  const copiedCommands=new Set<string>();
  for(const platform of platforms){
    const tab=tabs.getByRole('tab',{name:platform.name});await tab.click();await expect(tab).toHaveAttribute('aria-selected','true');await expect(tabs.locator('[role="tab"][aria-selected="true"]')).toHaveCount(1);
    await expect(page).toHaveURL(new RegExp(`[?&]platform=${platform.id}(?:&|$)`));
    const panel=page.getByRole('tabpanel');await expect(panel).toHaveAttribute('id',`installation-platform-${platform.id}`);await expect(panel.getByRole('heading',{name:new RegExp(`Instalar no ${platform.id==='macos'?'macOS':platform.id==='truenas'?'TrueNAS SCALE':platform.id==='linux'?'Linux':'Windows 11'}`)})).toBeVisible();
    const commands=await panel.locator('pre code').allTextContents();
    expect(commands.join('\n')).toMatch(/docker/i);
    if(platform.id==='truenas'){
      expect(await panel.innerText()).toMatch(/APP_URL/);
      expect(await panel.innerText()).toMatch(/192\.168\.|10\.\d+\.\d+\.|endereço.*LAN|IP.*NAS/i);
      const appUrlLines=commands.flatMap(command=>command.split('\n')).filter(line=>/^\s*APP_URL\s*=/.test(line));
      expect(appUrlLines.length).toBeGreaterThan(0);expect(appUrlLines.every(line=>!/(localhost|127\.0\.0\.1)/.test(line))).toBe(true);
    }
    if(platform.id==='linux'||platform.id==='macos'){
      expect(commands.join('\n')).toMatch(/id -u/);expect(commands.join('\n')).toMatch(/id -g/);
    }
    const block=await commandBlock(panel,platform.command);const expected=await block.locator('pre code').textContent();expect(expected).toBeTruthy();
    await block.getByRole('button',{name:/^Copiar /}).click();await expect(page.getByRole('status').filter({hasText:/Comando copiado/})).toBeVisible();
    await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(expected!);copiedCommands.add(expected!);
  }
  expect(copiedCommands.size).toBeGreaterThanOrEqual(3);
  const mac=tabs.getByRole('tab',{name:/^macOS\b/});await mac.focus();await mac.press('Home');await expect(tabs.getByRole('tab',{name:/^Windows 11\b/})).toHaveAttribute('aria-selected','true');await page.keyboard.press('ArrowRight');await expect(tabs.getByRole('tab',{name:/^Linux\b/})).toHaveAttribute('aria-selected','true');await page.keyboard.press('End');await expect(mac).toHaveAttribute('aria-selected','true');
  expect(apiCalls).toEqual([]);expect(mutations).toEqual([]);
});

test('Guia mobile: conteúdo cabe em 390 px, três fotos carregam e ampliação pode ser fechada',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/instalacao?platform=truenas');
  await expect(page.getByRole('heading',{name:heading,exact:true})).toBeVisible();
  await expect(page.getByRole('tab',{name:/^TrueNAS SCALE\b/})).toHaveAttribute('aria-selected','true');
  for(const name of [/^Windows 11\b/,/^Linux\b/,/^TrueNAS SCALE\b/,/^macOS\b/]){
    await page.getByRole('tab',{name}).click();
    const widths=await page.evaluate(()=>({document:document.documentElement.scrollWidth,viewport:innerWidth,main:document.querySelector('main')!.getBoundingClientRect().width}));expect(widths.document).toBeLessThanOrEqual(widths.viewport+1);expect(widths.main).toBeLessThanOrEqual(widths.viewport+1);
    const preOverflow=await page.getByRole('tabpanel').locator('pre').evaluateAll(elements=>elements.map(element=>({width:element.getBoundingClientRect().width,viewport:innerWidth,overflow:getComputedStyle(element).overflowX})));
    for(const pre of preOverflow){expect(pre.width).toBeLessThanOrEqual(391);expect(['auto','scroll']).toContain(pre.overflow);}
  }
  await imagesLoaded(page);
  const first=page.locator('.installation-gallery').getByRole('button',{name:/^Ampliar imagem:/}).first();await first.click();const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();await expect.poll(()=>dialog.locator('img').evaluate(element=>(element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);await dialog.getByRole('button',{name:'Fechar imagem ampliada'}).click();await expect(dialog).not.toBeVisible();
  await first.click();await expect(dialog).toBeVisible();await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();
  await mkdir('private',{recursive:true});await page.screenshot({path:'private/browser-installation-mobile.png',fullPage:true});
});

test('Ajuda acessível antes e depois do login: link público e navegação Instalação',async({page})=>{
  if(!process.env.ADMIN_EMAIL||!process.env.ADMIN_PASSWORD)throw new Error('Credenciais locais necessárias para validar o acesso autenticado ao guia.');
  await page.goto('/');const link=page.getByRole('link',{name:'Como instalar o CRM',exact:true});await expect(link).toBeVisible();await link.click();await expect(page.getByRole('heading',{name:heading,exact:true})).toBeVisible();
  await page.getByRole('link',{name:'Voltar para o CRM',exact:true}).click();
  await page.getByLabel('E-mail',{exact:true}).fill(process.env.ADMIN_EMAIL);await page.getByLabel('Senha',{exact:true}).fill(process.env.ADMIN_PASSWORD);await page.getByRole('button',{name:'Entrar no CRM'}).click();await expect(page.getByRole('heading',{name:/Visão geral/})).toBeVisible();
  await page.getByRole('navigation',{name:'Navegação principal'}).getByRole('button',{name:'Instalação',exact:true}).click();await expect(page.getByRole('heading',{name:heading,exact:true})).toBeVisible();await imagesLoaded(page);
  await mkdir('private',{recursive:true});await page.screenshot({path:'private/browser-installation-desktop.png',fullPage:true});
});
