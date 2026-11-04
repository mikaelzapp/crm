import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Conecta CRM · Multi WhatsApp Pro', description: 'Relacionamentos que geram negócios. Atendimento, contatos e campanhas autorizadas em um só lugar.' };
export default function RootLayout({ children }: Readonly<{
    children: React.ReactNode;
}>) { return <html lang="pt-BR"><body>{children}</body></html>; }
