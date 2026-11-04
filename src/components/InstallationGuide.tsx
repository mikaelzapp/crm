'use client';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AppWindow, BookOpen, Check, CheckCircle2, ChevronRight, Clipboard, Copy, ExternalLink, HardDrive, ImageIcon, Laptop, LockKeyhole, Monitor, Server, ShieldCheck, Terminal, TerminalSquare, X, ZoomIn } from 'lucide-react';
import { installationPlatforms, installationImages, installationTroubleshooting, installationSafetyNotes, installationLinks, type InstallationPlatformId, type InstallationCommand, type InstallationImage } from '../lib/installation-guide';
const platformIcons = { windows: AppWindow, linux: TerminalSquare, truenas: Server, macos: Laptop };
const platformSubtitles = { windows: 'Windows 11 + WSL 2', linux: 'Ubuntu / Debian', truenas: 'Docker no seu servidor', macos: 'Apple Silicon ou Intel' };
const languageNames = { powershell: 'PowerShell', bash: 'Terminal · Bash', text: 'Arquivo de configuração' };
function InstallationCode({ command, id, onCopied }: {
    command: InstallationCommand;
    id: string;
    onCopied: (message: string, error?: boolean) => void;
}) {
    const [copied, setCopied] = useState(false), codeRef = useRef<HTMLElement>(null);
    const copy = async () => { let successful = false; try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(command.code);
            successful = true;
        }
    }
    catch { } if (!successful) {
        const previous = document.activeElement as HTMLElement | null;
        const temporary = document.createElement('textarea');
        temporary.value = command.code;
        temporary.readOnly = true;
        temporary.style.position = 'fixed';
        temporary.style.left = '-9999px';
        document.body.appendChild(temporary);
        temporary.select();
        try {
            successful = document.execCommand('copy');
        }
        catch { }
        temporary.remove();
        previous?.focus();
    } if (successful) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
        onCopied('Comando copiado. Cole no terminal ou arquivo indicado.');
        return;
    } if (codeRef.current) {
        const range = document.createRange();
        range.selectNodeContents(codeRef.current);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        codeRef.current.focus();
    } onCopied('Não foi possível copiar automaticamente. O texto foi selecionado: use Ctrl+C ou ⌘C.', true); };
    return <div className="installation-code-block"><div className="installation-code-header"><span><Terminal size={14}/><strong>{command.label}</strong><small>{languageNames[command.language] || command.language}</small></span><button type="button" className="installation-copy-button" aria-label={`Copiar ${command.label}`} onClick={() => void copy()}>{copied ? <Check size={14}/> : <Copy size={14}/>}<span>{copied ? 'Copiado' : 'Copiar'}</span></button></div><pre id={id} tabIndex={0} aria-label={command.label}><code ref={codeRef} tabIndex={-1}>{command.code}</code></pre>{command.note && <p className="installation-code-note">{command.note}</p>}</div>;
}
export default function InstallationGuide({ standalone = false }: {
    standalone?: boolean;
}) {
    const [platformId, setPlatformId] = useState<InstallationPlatformId>('windows'), [toast, setToast] = useState<{
        message: string;
        error?: boolean;
    } | null>(null), [activeImage, setActiveImage] = useState<InstallationImage | null>(null);
    const dialogRef = useRef<HTMLDialogElement>(null), toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null), tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
    const platform = installationPlatforms.find(item => item.id === platformId) || installationPlatforms[0];
    const images = [installationImages.login, installationImages.dashboard, installationImages.ai];
    useEffect(() => { const read = () => { const requested = new URLSearchParams(window.location.search).get('platform'); setPlatformId(installationPlatforms.some(item => item.id === requested) ? requested as InstallationPlatformId : 'windows'); }; read(); window.addEventListener('popstate', read); return () => window.removeEventListener('popstate', read); }, []);
    useEffect(() => () => { if (toastTimer.current)
        clearTimeout(toastTimer.current); }, []);
    useEffect(() => { if (activeImage && !dialogRef.current?.open)
        dialogRef.current?.showModal(); if (!activeImage && dialogRef.current?.open)
        dialogRef.current.close(); }, [activeImage]);
    const choosePlatform = (id: InstallationPlatformId, focus = false) => { setPlatformId(id); const url = new URL(window.location.href); url.searchParams.set('platform', id); if (!standalone)
        url.searchParams.set('view', 'installation'); window.history.pushState(null, '', url); if (focus)
        tabRefs.current[id]?.focus(); };
    const keyboard = (event: KeyboardEvent<HTMLButtonElement>, index: number) => { let next = index; if (event.key === 'ArrowRight')
        next = (index + 1) % installationPlatforms.length;
    else if (event.key === 'ArrowLeft')
        next = (index - 1 + installationPlatforms.length) % installationPlatforms.length;
    else if (event.key === 'Home')
        next = 0;
    else if (event.key === 'End')
        next = installationPlatforms.length - 1;
    else
        return; event.preventDefault(); choosePlatform(installationPlatforms[next].id, true); };
    const notify = (message: string, error = false) => { if (toastTimer.current)
        clearTimeout(toastTimer.current); setToast({ message, error }); toastTimer.current = setTimeout(() => setToast(null), 6500); };
    return <div className="installation-guide"><div className="installation-hero"><div><span className="eyebrow">GUIA DE INSTALAÇÃO</span><h1>Seu CRM, pronto para começar.</h1><p>Do primeiro comando à primeira conversa. Escolha seu sistema e acompanhe cada etapa da instalação.</p><div className="installation-hero-labels"><span><CheckCircle2 size={14}/>Passo a passo em português</span><span><Clipboard size={14}/>Comandos para copiar</span><span><ImageIcon size={14}/>Fotos do sistema</span></div></div><div className="installation-hero-icon" aria-hidden="true"><TerminalSquare size={49}/><span className="installation-terminal-dots"><i /><i /><i /></span><small>conecta · ambiente local</small><code><span>›</span> aplicação + banco + fila</code><code><span>✓</span> tudo no mesmo workspace</code></div></div>
    <div className="installation-overview"><article><span className="stat-icon teal"><Monitor size={20}/></span><div><strong>Escolha seu ambiente</strong><p>Windows, Linux, TrueNAS SCALE ou macOS.</p></div></article><article><span className="stat-icon purple"><HardDrive size={20}/></span><div><strong>Dados em volumes persistentes</strong><p>O banco e os arquivos permanecem após reiniciar.</p></div></article><article><span className="stat-icon teal"><ShieldCheck size={20}/></span><div><strong>Comece com controle</strong><p>A instalação não dispara mensagens nem baixa modelos de IA.</p></div></article></div>
    <section aria-labelledby="installation-platform-title"><div className="installation-platform-heading"><div><span className="eyebrow">01 · ESCOLHA A PLATAFORMA</span><h2 id="installation-platform-title">Onde você vai instalar?</h2></div><small>Comandos específicos para cada sistema</small></div><div className="installation-platform-tabs" role="tablist" aria-label="Sistema operacional">{installationPlatforms.map((item, index) => { const Icon = platformIcons[item.id]; return <button type="button" key={item.id} id={`installation-tab-${item.id}`} ref={node => { tabRefs.current[item.id] = node; }} role="tab" aria-selected={platformId === item.id} aria-controls={`installation-platform-${item.id}`} tabIndex={platformId === item.id ? 0 : -1} className={`installation-platform-tab ${platformId === item.id ? 'selected' : ''}`} onClick={() => choosePlatform(item.id)} onKeyDown={event => keyboard(event, index)}><Icon size={25}/><span><strong>{item.label}</strong><small>{platformSubtitles[item.id]}</small></span>{platformId === item.id && <CheckCircle2 size={17}/>}</button>; })}</div></section>
    <section id={`installation-platform-${platform.id}`} role="tabpanel" aria-labelledby={`installation-tab-${platform.id}`} tabIndex={0}><div className="installation-platform-heading"><div><span className="eyebrow">02 · SIGA AS ETAPAS</span><h2>Instalar no {platform.label}</h2><p>{platform.description}</p></div><span className="badge neutral">{platform.steps.length} etapas</span></div><div className="installation-guide-layout"><div className="installation-steps">{platform.steps.map((step, index) => <article className="installation-step" id={`installation-step-${platform.id}-${step.id}`} key={`${platform.id}-${step.id}`}><span className="installation-step-number" aria-label={`Etapa ${index + 1}`}>{String(index + 1).padStart(2, '0')}</span><div className="installation-step-body"><h3 className="installation-step-title">{step.title}</h3><div className="installation-step-description">{step.body.map((paragraph, i) => <p key={i}>{paragraph}</p>)}</div>{step.commands.map((command, i) => <InstallationCode key={`${platform.id}-${step.id}-${i}`} command={command} id={`installation-code-${platform.id}-${step.id}-${i}`} onCopied={notify}/>)}{step.links && step.links.length > 0 && <div className="installation-links">{step.links.map(link => <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer">{link.label}<ExternalLink size={12}/></a>)}</div>}{step.image && <button className="button secondary small" onClick={() => setActiveImage(step.image!)}><ImageIcon size={14}/>Ver imagem desta etapa<ZoomIn size={13}/></button>}</div></article>)}</div><aside className="installation-quicknav"><section className="installation-prerequisites"><div className="company-cell"><span className="stat-icon teal"><CheckCircle2 size={18}/></span><h3>Antes de começar</h3></div><ul>{platform.prerequisites.map((item, i) => <li key={i}>{item}</li>)}</ul></section><section className="installation-checklist"><span className="eyebrow">NESTE GUIA</span><nav aria-label="Etapas da instalação">{platform.steps.map((step, i) => <a href={`#installation-step-${platform.id}-${step.id}`} key={step.id}><span>{String(i + 1).padStart(2, '0')}</span>{step.title}<ChevronRight size={13}/></a>)}</nav><div className="installation-note"><LockKeyhole size={17}/><p>Substitua os exemplos de configuração por seus próprios valores. Guarde senhas e chaves fora do repositório.</p></div></section></aside></div></section>
    <section className="installation-gallery-section" aria-labelledby="installation-gallery-heading"><div className="installation-platform-heading"><div><span className="eyebrow">03 · CONHEÇA O RESULTADO</span><h2 id="installation-gallery-heading">Assim fica o seu CRM</h2><p>Capturas reais da interface. Clique em uma foto para ampliar.</p></div></div><div className="installation-gallery">{images.map((image, index) => <figure key={image.src}><button type="button" className="installation-gallery-image" aria-label={`Ampliar imagem: ${image.alt}`} onClick={() => setActiveImage(image)}><img src={image.src} alt={image.alt} width={1600} height={1000} loading="lazy" decoding="async"/><span><ZoomIn size={18}/>Ampliar</span></button><figcaption className="installation-caption"><span>{String(index + 1).padStart(2, '0')}</span><p>{image.caption}</p></figcaption></figure>)}</div></section>
    <section className="installation-diagnostics" aria-labelledby="installation-diagnostics-heading"><div className="installation-platform-heading"><div><span className="eyebrow">PRECISA DE AJUDA?</span><h2 id="installation-diagnostics-heading">Verificações rápidas</h2><p>Encontre o problema e consulte o comando indicado.</p></div><Terminal size={24}/></div>{installationTroubleshooting.map((item, index) => <details className="installation-diagnostic" key={item.title}><summary><span>{item.title}</span><PlusMinus /></summary><div>{item.body.map((paragraph, i) => <p key={i}>{paragraph}</p>)}{item.commands.map((command, i) => <InstallationCode key={`${index}-${i}`} id={`installation-diagnostic-code-${index}-${i}`} command={command} onCopied={notify}/>)}</div></details>)}</section>
    <footer className="installation-footer"><div className="installation-footer-title"><ShieldCheck size={23}/><div><h2>Uma instalação segura começa com bons cuidados</h2><p>Nenhum comando é executado por esta página. Você decide o que copiar e quando executar.</p></div></div><ul>{installationSafetyNotes.map(note => <li key={note}>{note}</li>)}</ul><div className="installation-links">{installationLinks.map(link => <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer">{link.label}<ExternalLink size={12}/></a>)}</div></footer>
    <dialog ref={dialogRef} className="installation-image-dialog" aria-label={activeImage?.alt || 'Imagem da instalação'} onCancel={() => setActiveImage(null)} onClose={() => setActiveImage(null)} onClick={event => { if (event.target === event.currentTarget)
        setActiveImage(null); }}>{activeImage && <div><div className="installation-image-dialog-header"><span>{activeImage.caption}</span><button type="button" className="icon-button" aria-label="Fechar imagem ampliada" onClick={() => setActiveImage(null)}><X size={22}/></button></div><img src={activeImage.src} alt={activeImage.alt}/></div>}</dialog>
    <div className="installation-toast-region" aria-live="polite" aria-atomic="true">{toast && <div className={`installation-toast ${toast.error ? 'manual' : 'success'}`} role="status">{toast.error ? <Clipboard size={18}/> : <CheckCircle2 size={18}/>}<span>{toast.message}</span><button className="icon-button" aria-label="Fechar aviso de cópia" onClick={() => setToast(null)}><X size={15}/></button></div>}</div>
    </div>;
}
function PlusMinus() { return <span className="installation-details-marker" aria-hidden="true">+</span>; }
