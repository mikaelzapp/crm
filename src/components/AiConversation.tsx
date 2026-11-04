'use client';
import { useCallback, useEffect, useState } from 'react';
import { BrainCircuit, ShieldCheck, AlertCircle, Pause, Play, RefreshCw, LoaderCircle, Send, CheckCircle2, MessagesSquare } from 'lucide-react';
import { aiApi, AiRunResult, AiCorrectionForm, type AiRecord } from './AiTraining';
export default function AiConversation({ conversationId, user, onMessageSent }: {
    conversationId: string;
    user: AiRecord;
    onMessageSent?: () => void;
}) {
    const [data, setData] = useState<AiRecord | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [permissionForm, setPermissionForm] = useState(false), [correctionRun, setCorrectionRun] = useState<AiRecord | null>(null);
    const load = useCallback(async () => { try {
        const result = await aiApi(`conversations/${conversationId}`);
        setData(result);
        setError('');
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setLoading(false);
    } }, [conversationId]);
    useEffect(() => { setData(null); setLoading(true); setError(''); setNotice(''); setPermissionForm(false); setCorrectionRun(null); void load(); const timer = setInterval(() => void load(), 5000); return () => clearInterval(timer); }, [load]);
    const action = async (key: string, fn: () => Promise<void>) => { setBusy(key); setError(''); setNotice(''); try {
        await fn();
        await load();
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy('');
    } };
    const permission = data?.permission;
    const authorized = permission?.allowed === true && !permission.revokedAt;
    const paused = !!data?.conversation?.aiPaused;
    const agent = data?.agent;
    const runs: AiRecord[] = data?.runs || [];
    return <details className="ai-inbox-panel"><summary><span className="company-cell"><BrainCircuit size={17}/><strong>Assistente de IA</strong>{agent && <span className={`badge ${agent.mode === 'AUTO' ? 'warning' : agent.mode === 'SUGGEST' ? 'success' : 'neutral'}`}>{agent.mode === 'AUTO' ? 'Automático' : agent.mode === 'SUGGEST' ? 'Sugestões' : 'Desligado'}</span>}{paused && <span className="badge warning">Encaminhado para pessoa</span>}</span></summary><div style={{ paddingTop: 14 }}>{loading ? <div className="muted"><LoaderCircle className="spinner" size={16}/> Carregando assistente…</div> : !agent ? <p className="muted">Nenhum agente foi configurado para este número. Um administrador pode adicioná-lo em “Treinamento da IA”.</p> : <><div className="metric-row"><span><strong>{agent.name}</strong><small className="cell-subtitle">{agent.model} · {agent.retainHistory ? 'Histórico configurado para contexto autorizado' : 'Sem histórico permanente · expira em até 24h'}</small></span><button className="icon-button" onClick={() => void load()} aria-label="Atualizar sugestões da IA"><RefreshCw size={16}/></button></div><div className={`ai-inline-alert ${authorized ? 'success' : 'warning'}`}><ShieldCheck size={17}/><span>{authorized ? 'Processamento de IA autorizado para esta conversa.' : 'Processamento de IA ainda não autorizado para esta conversa.'} Essa permissão é independente do consentimento para receber mensagens.</span></div><div className="ai-inbox-controls"><button className="button secondary small" disabled={!!busy} onClick={() => void action('pause', async () => { await aiApi(`conversations/${conversationId}`, { method: 'PATCH', body: JSON.stringify({ aiPaused: !paused }) }); setNotice(paused ? 'Pausa humana removida. O agente continua respeitando as permissões e seu modo.' : 'Atendimento encaminhado para uma pessoa. Respostas automáticas pausadas.'); })}>{paused ? <Play size={13}/> : <Pause size={13}/>} {paused ? 'Retomar agente nesta conversa' : 'Encaminhar para pessoa'}</button>{!authorized && user.role === 'ADMIN' && <button className="button secondary small" onClick={() => setPermissionForm(v => !v)}><ShieldCheck size={13}/>Registrar autorização de IA</button>}{authorized && user.role === 'ADMIN' && <button className="button secondary small" disabled={!!busy} onClick={() => { if (!confirm('Revogar o processamento de IA e remover o histórico de IA desta conversa?'))
            return; void action('permission', async () => { await aiApi(`conversations/${conversationId}/permission`, { method: 'POST', body: JSON.stringify({ allowed: false, source: permission.source || 'Revogação manual no CRM', purpose: permission.purpose || 'Processamento de IA para atendimento', evidence: 'Revogação solicitada manualmente pelo atendente.' }) }); setNotice('Permissão revogada. O histórico de IA foi removido.'); setCorrectionRun(null); }); }}>Revogar permissão e histórico</button>}</div>
        {permissionForm && !authorized && user.role === 'ADMIN' && <form className="ai-permission-form" onSubmit={async (e) => { e.preventDefault(); const values = Object.fromEntries(new FormData(e.currentTarget)); void action('permission', async () => { await aiApi(`conversations/${conversationId}/permission`, { method: 'POST', body: JSON.stringify({ ...values, allowed: true }) }); setPermissionForm(false); setNotice('Autorização de processamento de IA registrada.'); }); }}><p className="muted">Registre uma autorização real e verificável. Receber uma mensagem não autoriza, por si só, seu processamento pela IA ou a retenção do histórico. Informe na finalidade se a autorização também abrange retenção e uso de mensagens anteriores.</p><div className="form-grid"><label className="field"><span className="field-label">Origem da autorização de IA</span><input className="input" name="source" required minLength={3} maxLength={200} placeholder="Formulário de privacidade, registro de atendimento…"/></label><label className="field"><span className="field-label">Finalidade autorizada para IA</span><input className="input" name="purpose" required minLength={3} maxLength={500} placeholder="Assistência de IA neste atendimento"/></label></div><label className="field"><span className="field-label">Evidência da autorização de IA</span><textarea className="input" name="evidence" required minLength={3} rows={2} maxLength={3000}/></label>{agent.retainHistory && <label className="ai-toggle-label"><input type="checkbox" required/><span>A evidência registrada também autoriza a retenção e o uso do histórico para a finalidade informada.</span></label>}<div className="ai-source-actions"><button className="button primary small" disabled={!!busy}><CheckCircle2 size={14}/>Registrar autorização</button><button type="button" className="button ghost small" onClick={() => setPermissionForm(false)}>Cancelar</button></div></form>}
        {authorized && <details style={{ marginTop: 10 }}><summary>Ver autorização registrada</summary><p className="muted" style={{ whiteSpace: 'pre-wrap', marginTop: 10 }}><strong>{permission.purpose}</strong><br />{permission.source}<br />{permission.evidence}</p></details>}
        {!authorized && user.role !== 'ADMIN' && <p className="muted" style={{ marginTop: 10 }}>Um administrador deve registrar a autorização de processamento de IA antes de gerar sugestões para esta conversa.</p>}<div style={{ marginTop: 18 }}>{runs.slice(0, 5).map(run => <AiRunResult key={run.id} run={run} onCorrect={user.role === 'ADMIN' ? setCorrectionRun : undefined} actions={run.output && !run.outboundMessageId && !['SENT', 'AUTO_SENT', 'FAILED', 'BLOCKED', 'UNKNOWN', 'HUMAN_REQUIRED', 'HANDOFF', 'CANCELED', 'SKIPPED'].includes(run.status) && <button className="button primary small" disabled={!!busy || !authorized} onClick={() => { if (!confirm('Você revisou esta sugestão e deseja enviá-la ao cliente? As regras de consentimento e janela de atendimento serão verificadas.'))
            return; void action('send', async () => { await aiApi(`runs/${run.id}/send`, { method: 'POST', body: '{}' }); setNotice('Sugestão aprovada enviada pelo número desta conversa.'); onMessageSent?.(); }); }}><Send size={13}/>Revisar e enviar sugestão</button>}/>)}</div>{!runs.length && <p className="muted" style={{ marginTop: 18 }}><MessagesSquare size={15}/> As sugestões para novas mensagens autorizadas aparecerão aqui. Ativar um agente não processa automaticamente todo o histórico.</p>}{correctionRun && <AiCorrectionForm run={correctionRun} onClose={() => setCorrectionRun(null)} onSaved={() => { void load(); setNotice('Correção enviada para revisão de um administrador.'); }}/>}</>}{error && <div className="ai-inline-alert error" role="alert"><AlertCircle size={16}/>{error}</div>}{notice && <div className="ai-inline-alert success" role="status"><CheckCircle2 size={16}/>{notice}</div>}</div></details>;
}
