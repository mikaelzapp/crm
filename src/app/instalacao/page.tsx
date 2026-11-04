import type { Metadata } from 'next';
import { ArrowLeft, MessageCircle } from 'lucide-react';
import InstallationGuide from '../../components/InstallationGuide';
export const metadata: Metadata = { title: 'Como instalar · Conecta CRM', description: 'Guia de instalação do Conecta CRM para Windows 11, Linux, TrueNAS SCALE e macOS, com comandos para copiar e fotos da interface.' };
export default function InstallationPage() { return <div className="installation-public-shell"><header className="installation-public-header"><a href="/" className="installation-public-brand" aria-label="Conecta CRM · Início"><span className="brand-mark"><MessageCircle size={23}/></span><strong>conecta<span>.</span></strong><span className="badge neutral">Central de ajuda</span></a><a href="/" className="button secondary"><ArrowLeft size={15}/>Voltar para o CRM</a></header><main className="installation-public-content"><InstallationGuide standalone/></main></div>; }
