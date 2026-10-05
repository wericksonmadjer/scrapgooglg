import React, { useState, useEffect, useRef } from 'react';
import { apiFetch, sseUrl } from './apiClient';
import {
  Smartphone, QrCode, Send, Pause, Play, Square, Plus, Trash2,
  Upload, CheckCircle, XCircle, Clock, MessageSquare, Download,
  Users, Settings, AlertTriangle, Wifi, WifiOff, Loader2, FileText,
  LogOut,
} from 'lucide-react';

// ── Tipos ─────────────────────────────────────────────────────────────────────
type SessionStatus = 'idle' | 'starting' | 'qr_waiting' | 'authenticated' | 'disconnected' | 'error';
type ContactStatus = 'pending' | 'sent' | 'failed' | 'skipped' | 'sending';

interface Contact {
  id: string;
  phone: string;
  name: string;
  company: string;
  status: ContactStatus;
  error?: string;
  sentAt?: string;
}

interface SendStats {
  sent: number;
  failed: number;
  pending: number;
  total: number;
}

interface SendConfig {
  delayMinSec: number;
  delayMaxSec: number;
  limitPerHour: number;
  pauseAfterN: number;
  pauseDurationMin: number;
  maxConsecutiveFailsPerSession: number;
  stopIfRotationBroken: boolean;
}

interface WhatsAppPanelProps {
  /** Leads vindos da aba de extração para importação rápida */
  extractedLeads: any[];
}

// ── Utilitários ───────────────────────────────────────────────────────────────
function uid() {
  return Math.random().toString(36).slice(2, 10);
}

const statusColors: Record<ContactStatus, string> = {
  pending: 'bg-slate-100 text-slate-600',
  sending: 'bg-blue-100 text-blue-700',
  sent: 'bg-emerald-100 text-emerald-700',
  failed: 'bg-red-100 text-red-700',
  skipped: 'bg-amber-100 text-amber-700',
};

const statusLabels: Record<ContactStatus, string> = {
  pending: 'Pendente',
  sending: 'Enviando…',
  sent: 'Enviado',
  failed: 'Falhou',
  skipped: 'Ignorado',
};

const statusIcons: Record<ContactStatus, React.ReactNode> = {
  pending: <Clock className="w-3 h-3" />,
  sending: <Loader2 className="w-3 h-3 animate-spin" />,
  sent: <CheckCircle className="w-3 h-3" />,
  failed: <XCircle className="w-3 h-3" />,
  skipped: <AlertTriangle className="w-3 h-3" />,
};

// ── Componente principal ───────────────────────────────────────────────────────
export default function WhatsAppPanel({ extractedLeads }: WhatsAppPanelProps) {
  // Múltiplas sessões
  interface SessionData {
    id: string;
    name: string;
    phone: string;
    status: SessionStatus;
  }
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>('default');
  const [newSessionName, setNewSessionName] = useState<string>('');
  const [sessionToDelete, setSessionToDelete] = useState<string | null>(null);
  const [sessionToLogout, setSessionToLogout] = useState<string | null>(null);

  // Alerta de rotação comprometida
  const [rotationAlert, setRotationAlert] = useState<{
    degradedSession: string;
    remainingCount: number;
    minRequired: number;
  } | null>(null);

  // Rotação no disparo
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>(['default']);
  const [rotationMode, setRotationMode] = useState<'message' | 'batch'>('message');
  const [rotationBatchSize, setRotationBatchSize] = useState<number>(5);

  // Sessão
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('idle');
  const [screenshot, setScreenshot] = useState<string>('');
  const [sessionLogs, setSessionLogs] = useState<string[]>([]);

  // Campanha
  const [message, setMessage] = useState('Olá {nome}! Vi que a {empresa} pode se beneficiar da nossa solução. Podemos conversar?');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [newPhone, setNewPhone] = useState('');
  const [newName, setNewName] = useState('');
  const [newCompany, setNewCompany] = useState('');

  // Disparo
  const [config, setConfig] = useState<SendConfig>({
    delayMinSec: 20,
    delayMaxSec: 60,
    limitPerHour: 20,
    pauseAfterN: 10,
    pauseDurationMin: 5,
    maxConsecutiveFailsPerSession: 3,
    stopIfRotationBroken: true,
  });
  const [senderRunning, setSenderRunning] = useState(false);
  const [senderPaused, setSenderPaused] = useState(false);
  const [stats, setStats] = useState<SendStats>({ sent: 0, failed: 0, pending: 0, total: 0 });
  const [sendLogs, setSendLogs] = useState<string[]>([]);

  // Validação de Números (Fase 2)
  const [validatorRunning, setValidatorRunning] = useState(false);
  const [validatorDone, setValidatorDone] = useState(false);
  const [validatorResults, setValidatorResults] = useState<any[]>([]);
  const [validatorStats, setValidatorStats] = useState({ valid: 0, invalid: 0, unknown: 0, pending: 0, total: 0 });
  const [validateLogs, setValidateLogs] = useState<string[]>([]);
  const [validateActiveSessionId, setValidateActiveSessionId] = useState<string>('default');
  const [validateDelayMs, setValidateDelayMs] = useState<number>(3000);

  // UI
  const [activeSection, setActiveSection] = useState<'auth' | 'campaign' | 'validate' | 'send'>('auth');
  const [csvError, setCsvError] = useState<string>('');
  const sessionLogEndRef = useRef<HTMLDivElement>(null);
  const sendLogEndRef = useRef<HTMLDivElement>(null);
  const validatorLogEndRef = useRef<HTMLDivElement>(null);
  const sessionStreamRef = useRef<EventSource | null>(null);
  const sendStreamRef = useRef<EventSource | null>(null);
  const validatorStreamRef = useRef<EventSource | null>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll logs
  useEffect(() => { sessionLogEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [sessionLogs]);
  useEffect(() => { sendLogEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [sendLogs]);
  useEffect(() => { validatorLogEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [validateLogs]);

  // Conecta ao stream de sessão quando activeSessionId muda
  useEffect(() => {
    if (activeSessionId) {
      connectSessionStream(activeSessionId);
    }
  }, [activeSessionId]);

  // Seleção automática da primeira conta caso a ativa seja deletada ou inicialize
  useEffect(() => {
    if (sessions.length > 0) {
      const exists = sessions.some(s => s.id === activeSessionId);
      if (!exists) {
        setActiveSessionId(sessions[0].id);
      }

      const vExists = sessions.some(s => s.id === validateActiveSessionId);
      if (!vExists) {
        const firstAuth = sessions.find(s => s.status === 'authenticated');
        setValidateActiveSessionId(firstAuth ? firstAuth.id : sessions[0].id);
      }
    } else {
      setActiveSessionId('');
      setValidateActiveSessionId('');
    }
  }, [sessions, activeSessionId, validateActiveSessionId]);

  // Inicialização e Polling
  useEffect(() => {
    connectSendStream();
    connectValidatorStream();
    fetchStatus();
    const interval = setInterval(fetchStatus, 3000);
    return () => {
      sessionStreamRef.current?.close();
      sendStreamRef.current?.close();
      validatorStreamRef.current?.close();
      clearInterval(interval);
    };
  }, []);

  async function fetchStatus() {
    try {
      const res = await apiFetch('/api/whatsapp/status');
      const data = await res.json();
      if (data.sessions) {
        setSessions(data.sessions);
      }
      setSenderRunning(data.senderRunning);
      setSenderPaused(data.senderPaused);
      setStats(data.stats);
    } catch (e) {
      console.error('Erro ao buscar status:', e);
    }
  }

  function connectSessionStream(sessionId: string) {
    sessionStreamRef.current?.close();
    setScreenshot('');
    setSessionLogs([]);

    if (!sessionId) return; // blinda contra string vazia

    const es = new EventSource(sseUrl(`/api/whatsapp/sessions/${sessionId}/stream`));

    es.addEventListener('status', e => {
      const s = JSON.parse(e.data) as SessionStatus;
      setSessions(prev => prev.map(sec => sec.id === sessionId ? { ...sec, status: s } : sec));
      if (sessionId === activeSessionId) {
        setSessionStatus(s);
      }
    });

    es.addEventListener('screenshot', e => {
      setScreenshot(JSON.parse(e.data) as string);
    });

    es.addEventListener('log', e => {
      const msg = JSON.parse(e.data) as string;
      setSessionLogs(prev => [...prev.slice(-99), msg]);
    });

    es.onerror = () => { /* reconecta automaticamente */ };
    sessionStreamRef.current = es;
  }

  function connectSendStream() {
    sendStreamRef.current?.close();
    const es = new EventSource(sseUrl('/api/whatsapp/send-stream'));

    es.addEventListener('stats', e => {
      try {
        const parsed = JSON.parse(e.data);
        if (parsed && typeof parsed === 'object') {
          setStats(prev => ({
            sent: Number(parsed.sent ?? prev.sent ?? 0),
            failed: Number(parsed.failed ?? prev.failed ?? 0),
            pending: Number(parsed.pending ?? prev.pending ?? 0),
            total: Number(parsed.total ?? prev.total ?? 0),
          }));
        }
      } catch {}
    });
    es.addEventListener('contacts', e => {
      try {
        const serverContacts = JSON.parse(e.data) as Contact[];
        if (Array.isArray(serverContacts) && serverContacts.length > 0) setContacts(serverContacts);
      } catch {}
    });
    es.addEventListener('contact_status', e => {
      try {
        const update = JSON.parse(e.data) as { id: string; status: ContactStatus; error?: string; sentAt?: string };
        if (update && update.id) {
          setContacts(prev => prev.map(c => c.id === update.id ? { ...c, ...update } : c));
        }
      } catch {}
    });
    es.addEventListener('log', e => {
      try {
        const msg = JSON.parse(e.data) as string;
        if (typeof msg === 'string') setSendLogs(prev => [...prev.slice(-99), msg]);
      } catch {}
    });
    es.addEventListener('started', () => { setSenderRunning(true); setSenderPaused(false); setRotationAlert(null); });
    es.addEventListener('finished', () => { setSenderRunning(false); setSenderPaused(false); });
    es.addEventListener('stopped', () => { setSenderRunning(false); setSenderPaused(false); });
    es.addEventListener('paused', () => setSenderPaused(true));
    es.addEventListener('resumed', () => setSenderPaused(false));
    es.addEventListener('session_degraded', e => {
      try {
        const data = JSON.parse(e.data);
        setSendLogs(prev => [...prev.slice(-99), `⚠️ Conta [${data?.sessionName || 'desconhecida'}] degradada após ${data?.failCount ?? 0} falhas consecutivas.`]);
      } catch {}
    });
    es.addEventListener('rotation_broken', e => {
      try {
        const data = JSON.parse(e.data);
        setRotationAlert(data);
        setSenderRunning(false);
        setSenderPaused(false);
      } catch {}
    });

    sendStreamRef.current = es;
  }

  function connectValidatorStream() {
    validatorStreamRef.current?.close();
    const es = new EventSource(sseUrl('/api/whatsapp/validate-stream'));

    es.addEventListener('status', e => {
      try {
        const data = JSON.parse(e.data);
        setValidatorRunning(!!data?.running);
        setValidatorResults(Array.isArray(data?.results) ? data.results : []);
        
        if (data?.results && Array.isArray(data.results) && data.results.length > 0) {
          const total = data.results.length;
          const valid = data.results.filter((r: any) => r && r.status === 'valid').length;
          const invalid = data.results.filter((r: any) => r && r.status === 'invalid').length;
          const unknown = data.results.filter((r: any) => r && r.status === 'unknown').length;
          const pending = data.results.filter((r: any) => r && (r.status === 'pending' || r.status === 'checking')).length;
          setValidatorStats({ total, valid, invalid, unknown, pending });
        }
      } catch {}
    });

    es.addEventListener('started', e => {
      try {
        const data = JSON.parse(e.data);
        const total = Number(data?.total ?? 0);
        setValidatorRunning(true);
        setValidatorDone(false);
        setValidatorStats({ total, pending: total, valid: 0, invalid: 0, unknown: 0 });
        setValidatorResults([]);
      } catch {}
    });

    es.addEventListener('progress', e => {
      try {
        const data = JSON.parse(e.data);
        if (data && typeof data.index === 'number') {
          setValidatorResults(prev => {
            const copy = [...prev];
            copy[data.index] = data.result;
            return copy;
          });
        }
      } catch {}
    });

    es.addEventListener('result', e => {
      try {
        const data = JSON.parse(e.data);
        if (data && typeof data.index === 'number') {
          setValidatorResults(prev => {
            const copy = [...prev];
            copy[data.index] = data.result;
            return copy;
          });
        }
        setValidatorStats(prev => {
          const safeTotal = prev?.total ?? 0;
          const stats = { valid: 0, invalid: 0, unknown: 0, pending: 0, total: safeTotal };
          setValidatorResults(current => {
            current.forEach(r => {
              if (r) {
                if (r.status === 'valid') stats.valid++;
                else if (r.status === 'invalid') stats.invalid++;
                else if (r.status === 'unknown') stats.unknown++;
              }
            });
            stats.pending = Math.max(0, stats.total - (stats.valid + stats.invalid + stats.unknown));
            return current;
          });
          return stats;
        });
      } catch {}
    });

    es.addEventListener('log', e => {
      try {
        const msg = JSON.parse(e.data) as string;
        if (typeof msg === 'string') setValidateLogs(prev => [...prev.slice(-99), msg]);
      } catch {}
    });

    es.addEventListener('done', e => {
      try {
        const data = JSON.parse(e.data);
        setValidatorRunning(false);
        setValidatorDone(true);
        setValidatorResults(Array.isArray(data?.results) ? data.results : []);
        setValidatorStats({
          valid: Number(data?.valid ?? 0),
          invalid: Number(data?.invalid ?? 0),
          unknown: Number(data?.unknown ?? 0),
          pending: Number(data?.pending ?? 0),
          total: Number(data?.total ?? 0)
        });
      } catch {}
    });

    es.addEventListener('stopped', e => {
      try {
        const data = JSON.parse(e.data);
        setValidatorRunning(false);
        setValidatorResults(Array.isArray(data?.results) ? data.results : []);
        setValidatorStats({
          valid: Number(data?.valid ?? 0),
          invalid: Number(data?.invalid ?? 0),
          unknown: Number(data?.unknown ?? 0),
          pending: Number(data?.pending ?? 0),
          total: Array.isArray(data?.results) ? data.results.length : 0
        });
      } catch {}
    });

    es.addEventListener('error', (e: any) => {
      if (e.data) {
        try {
          const err = JSON.parse(e.data) as string;
          setValidatorRunning(false);
          setValidateLogs(prev => [...prev, `❌ Erro no Validador: ${err}`]);
        } catch {
          setValidatorRunning(false);
        }
      } else {
        // Erro de conexão nativo do EventSource
        setValidatorRunning(false);
      }
    });

    validatorStreamRef.current = es;
  }

  async function handleStartValidate() {
    if (!validateActiveSessionId) return;
    setValidateLogs([]);
    setValidatorDone(false);
    
    await apiFetch('/api/whatsapp/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contacts: contacts.map(c => ({ id: c.id, phone: c.phone, name: c.name, company: c.company })),
        sessionId: validateActiveSessionId,
        delayMs: validateDelayMs
      }),
    });
  }

  async function handleStopValidate() {
    await apiFetch('/api/whatsapp/validate-stop', { method: 'POST' });
  }

  function handleRemoveInvalidContacts() {
    const invalidPhones = new Set(
      validatorResults
        .filter(r => r && r.status === 'invalid')
        .map(r => r.phone)
    );

    if (invalidPhones.size === 0) return;

    setContacts(prev => prev.filter(c => !invalidPhones.has(c.phone)));
    alert(`✅ ${invalidPhones.size} contatos inválidos foram removidos da lista de disparo!`);
  }

  function downloadValidationReport() {
    if (validatorResults.length === 0) return;
    
    const statusLabelBR = {
      pending: 'Pendente',
      checking: 'Verificando',
      valid: 'Válido (No WhatsApp)',
      invalid: 'Inválido (Fora do WhatsApp)',
      unknown: 'Desconhecido/Erro'
    };

    const headers = ['Nome', 'Telefone', 'Empresa', 'Status', 'Telefone Formatado', 'Verificado em'];
    const csvContent = [
      headers.join(','),
      ...validatorResults.filter(Boolean).map(r => [
        `"${(r.name || '').replace(/"/g, '""')}"`,
        `"${(r.phone || '').replace(/"/g, '""')}"`,
        `"${(r.company || '').replace(/"/g, '""')}"`,
        `"${statusLabelBR[r.status as keyof typeof statusLabelBR] || r.status}"`,
        `"${r.usedPhone || ''}"`,
        `"${r.checkedAt ? new Date(r.checkedAt).toLocaleString('pt-BR') : ''}"`
      ].join(','))
    ].join('\n');

    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `relatorio_validacao_${new Date().toISOString().slice(0, 10)}_${new Date().toTimeString().slice(0, 5).replace(':', 'h')}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Ações de sessão ──────────────────────────────────────────────────────────
  async function handleStartSession(id: string = activeSessionId) {
    if (id === activeSessionId) {
      setSessionLogs([]);
      setScreenshot('');
      setSessionStatus('starting');
    }
    await apiFetch(`/api/whatsapp/sessions/${id}/start`, { method: 'POST' });
    fetchStatus();
  }

  async function handleDisconnect(id: string = activeSessionId) {
    await apiFetch(`/api/whatsapp/sessions/${id}/disconnect`, { method: 'POST' });
    if (id === activeSessionId) {
      setScreenshot('');
      setSessionStatus('idle');
    }
    fetchStatus();
  }

  async function handleLogout(id: string = activeSessionId) {
    setSessionToLogout(id);
  }

  async function confirmLogoutSession(id: string) {
    try {
      await apiFetch(`/api/whatsapp/sessions/${id}/logout`, { method: 'POST' });
      if (id === activeSessionId) {
        setScreenshot('');
        setSessionStatus('idle');
      }
      fetchStatus();
    } catch (e) {
      console.error('Erro ao desvincular sessão:', e);
    }
  }

  async function handleCreateSession() {
    if (!newSessionName.trim()) return;
    try {
      const res = await apiFetch('/api/whatsapp/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newSessionName }),
      });
      const newSession = await res.json();
      setSessions(prev => [...prev, newSession]);
      setActiveSessionId(newSession.id);
      setNewSessionName('');
    } catch (e) {
      console.error('Erro ao criar sessão:', e);
    }
  }

  async function handleDeleteSession(id: string) {
    setSessionToDelete(id);
  }

  async function confirmDeleteSession(id: string) {
    try {
      await apiFetch(`/api/whatsapp/sessions/${id}`, { method: 'DELETE' });
      if (activeSessionId === id) {
        setActiveSessionId('default');
      }
      fetchStatus();
    } catch (e) {
      console.error('Erro ao excluir sessão:', e);
    }
  }

  // ── Ações de contatos ────────────────────────────────────────────────────────
  function addContact() {
    if (!newPhone.trim()) return;
    const contact: Contact = {
      id: uid(),
      phone: newPhone.trim(),
      name: newName.trim(),
      company: newCompany.trim(),
      status: 'pending',
    };
    setContacts(prev => [...prev, contact]);
    setNewPhone('');
    setNewName('');
    setNewCompany('');
  }

  function removeContact(id: string) {
    setContacts(prev => prev.filter(c => c.id !== id));
  }

  function importLeads() {
    if (!extractedLeads.length) return;
    const imported: Contact[] = extractedLeads
      .filter(l => l.Telefone)
      .map(l => ({
        id: uid(),
        phone: l.Telefone || '',
        name: l.Nome || '',
        company: l.Nome || '',
        status: 'pending' as const,
      }));
    setContacts(prev => {
      const existingPhones = new Set(prev.map(c => c.phone));
      const newOnes = imported.filter(c => !existingPhones.has(c.phone));
      return [...prev, ...newOnes];
    });
  }

  // ── Import/Export CSV ────────────────────────────────────────────────────────
  function downloadCSVTemplate() {
    const template = [
      'Telefone,Nome,Empresa',
      '11999999999,Jo\u00e3o Silva,Consultoria Exemplo',
      '21988888888,Maria Santos,Empresa ABC',
      '31977777777,Carlos Lima,Loja XYZ',
    ].join('\n');
    const blob = new Blob(['\uFEFF' + template], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'modelo_contatos_whatsapp.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function downloadSendLogs() {
    if (sendLogs.length === 0) return;
    const timestamp = new Date().toLocaleString('pt-BR');
    const header = [
      `=== LOG DE DISPARO WHATSAPP ===`,
      `Exportado em: ${timestamp}`,
      `Estatísticas: ${stats.sent} Enviados | ${stats.failed} Falhas | ${stats.pending} Pendentes | Total: ${stats.total}`,
      `================================\n\n`
    ].join('\n');
    const content = header + sendLogs.join('\n');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `log_disparo_${new Date().toISOString().slice(0, 10)}_${new Date().toTimeString().slice(0, 5).replace(':', 'h')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function handleCSVUpload(file: File) {
    setCsvError('');
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const imported = parseCSVContacts(text);
        if (imported.length === 0) {
          setCsvError('Nenhum contato válido encontrado no CSV. Verifique se a coluna Telefone existe.');
          return;
        }
        setContacts(prev => {
          const existing = new Set(prev.map(c => c.phone));
          const news = imported.filter(c => !existing.has(c.phone));
          return [...prev, ...news];
        });
        setCsvError(`✅ ${imported.length} contatos importados com sucesso!`);
        setTimeout(() => setCsvError(''), 4000);
      } catch (err: any) {
        setCsvError(`Erro ao processar CSV: ${err.message}`);
      }
    };
    reader.readAsText(file, 'UTF-8');
  }

  function parseCSVContacts(text: string): Contact[] {
    // Suporta separadores , e ;
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) throw new Error('Arquivo vazio ou sem dados.');

    const sep = lines[0].includes(';') ? ';' : ',';

    // Normaliza header: remove aspas, acentos, case-insensitive
    const normalize = (s: string) =>
      s.trim().replace(/["']/g, '')
       .toLowerCase()
       .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const headers = lines[0].split(sep).map(normalize);

    const phoneIdx = headers.findIndex(h =>
      h.includes('telefone') || h.includes('phone') || h.includes('tel') ||
      h.includes('celular') || h.includes('whatsapp') || h.includes('contato'));
    const nameIdx = headers.findIndex(h =>
      h.includes('nome') || h.includes('name'));
    const companyIdx = headers.findIndex(h =>
      h.includes('empresa') || h.includes('company') || h.includes('razao') ||
      h.includes('negocio') || h.includes('estabelecimento'));

    if (phoneIdx === -1) throw new Error('Coluna "Telefone" não encontrada. Use o modelo para garantir o formato correto.');

    const contacts: Contact[] = [];
    for (let i = 1; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw) continue;
      const cols = raw.split(sep).map(c => c.trim().replace(/^["']|["']$/g, ''));
      const phone = cols[phoneIdx] || '';
      if (!phone) continue;
      contacts.push({
        id: uid(),
        phone,
        name: nameIdx >= 0 ? (cols[nameIdx] || '') : '',
        company: companyIdx >= 0 ? (cols[companyIdx] || '') : '',
        status: 'pending',
      });
    }
    return contacts;
  }

  // ── Ações de disparo ─────────────────────────────────────────────────────────
  async function handleStartSend() {
    setRotationAlert(null);
    // Envia configuração atual para o servidor
    await apiFetch('/api/whatsapp/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contacts: contacts.map(c => ({ ...c, status: 'pending', error: undefined, sentAt: undefined })) }),
    });
    await apiFetch('/api/whatsapp/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    await apiFetch('/api/whatsapp/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...config,
        activeSessionIds: selectedSessionIds,
        rotationMode: rotationMode,
        rotationBatchSize: rotationBatchSize,
      }),
    });
    await apiFetch('/api/whatsapp/send', { method: 'POST' });
    setActiveSection('send');
  }

  async function handlePause() {
    await apiFetch('/api/whatsapp/pause', { method: 'POST' });
  }

  async function handleResume() {
    await apiFetch('/api/whatsapp/resume', { method: 'POST' });
  }

  async function handleStop() {
    await apiFetch('/api/whatsapp/stop', { method: 'POST' });
  }

  // ── Helpers de UI ────────────────────────────────────────────────────────────
  const sessionStatusConfig = {
    idle: { label: 'Desconectado', color: 'text-slate-500', bg: 'bg-slate-100', dot: 'bg-slate-400', Icon: WifiOff },
    starting: { label: 'Iniciando...', color: 'text-blue-600', bg: 'bg-blue-50', dot: 'bg-blue-400 animate-pulse', Icon: Loader2 },
    qr_waiting: { label: 'Aguardando QR', color: 'text-amber-600', bg: 'bg-amber-50', dot: 'bg-amber-400 animate-pulse', Icon: QrCode },
    authenticated: { label: 'Conectado', color: 'text-emerald-600', bg: 'bg-emerald-50', dot: 'bg-emerald-500', Icon: Wifi },
    disconnected: { label: 'Desconectado', color: 'text-slate-500', bg: 'bg-slate-100', dot: 'bg-slate-400', Icon: WifiOff },
    error: { label: 'Erro', color: 'text-red-600', bg: 'bg-red-50', dot: 'bg-red-500', Icon: XCircle },
  };

  const sc = sessionStatusConfig[sessionStatus] || sessionStatusConfig.idle;
  const safeStatsTotal = Number(stats?.total ?? 0);
  const safeStatsSent = Number(stats?.sent ?? 0);
  const safeStatsFailed = Number(stats?.failed ?? 0);
  const progressPct = safeStatsTotal > 0 ? Math.round(((safeStatsSent + safeStatsFailed) / safeStatsTotal) * 100) : 0;

  const previewMessage = message
    .replace(/\{nome\}/gi, 'João Silva')
    .replace(/\{empresa\}/gi, 'Empresa Exemplo')
    .replace(/\{telefone\}/gi, '(11) 99999-9999');

  // Se não houver sessões cadastradas
  if (sessions.length === 0) {
    return (
      <div className="space-y-5">
        {/* Header do módulo */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-emerald-500 rounded-xl">
              <Smartphone className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-slate-800">Disparo WhatsApp</h2>
              <p className="text-xs text-slate-500">Envio automatizado com simulação humana</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-8 text-center space-y-4">
          <Smartphone className="w-12 h-12 mx-auto text-slate-400" />
          <div className="space-y-1">
            <h3 className="font-bold text-slate-800 text-sm">Nenhuma conta cadastrada</h3>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              Adicione uma conta de WhatsApp no campo abaixo para começar a escanear o QR Code e enviar mensagens.
            </p>
          </div>
          
          <div className="flex justify-center max-w-xs mx-auto pt-2">
            <div className="flex gap-2 w-full">
              <input
                type="text"
                placeholder="Nome da conta (ex: Suporte)..."
                value={newSessionName}
                onChange={e => setNewSessionName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreateSession()}
                className="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-xs outline-none focus:ring-2 focus:ring-emerald-500 font-sans"
              />
              <button
                onClick={handleCreateSession}
                disabled={!newSessionName.trim()}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-lg text-xs font-semibold transition-colors"
              >
                Adicionar
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-5">

      {/* Header do módulo */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-emerald-500 rounded-xl">
            <Smartphone className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-slate-800">Disparo WhatsApp</h2>
            <p className="text-xs text-slate-500">Envio automatizado com simulação humana</p>
          </div>
        </div>

        {/* Badge de status + botões de desconectar/desvincular */}
        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${sc.bg} ${sc.color}`}>
            <span className={`w-2 h-2 rounded-full ${sc.dot}`} />
            {sc.label}
          </div>
          {(sessionStatus !== 'idle' && sessionStatus !== 'disconnected' && sessionStatus !== 'error') && (
            <div className="flex gap-1.5">
              <button
                onClick={() => handleDisconnect(activeSessionId)}
                title="Parar navegador (fecha a janela em background)"
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 hover:bg-slate-200 border border-slate-300 transition-colors"
              >
                <WifiOff className="w-3 h-3" />
                Parar Navegador
              </button>
              <button
                onClick={() => handleLogout(activeSessionId)}
                title="Desvincular conta (fazer logout e limpar QR Code)"
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium bg-red-50 text-red-600 hover:bg-red-100 border border-red-200 transition-colors"
              >
                <LogOut className="w-3 h-3" />
                Desvincular
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Navegação em abas */}
      <div className="flex gap-1 bg-slate-100 p-1 rounded-xl">
        {([
          { id: 'auth', label: '1. Autenticação', Icon: QrCode },
          { id: 'campaign', label: '2. Campanha', Icon: MessageSquare },
          { id: 'validate', label: '3. Validação', Icon: CheckCircle },
          { id: 'send', label: '4. Disparo', Icon: Send },
        ] as const).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveSection(tab.id)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg text-sm font-medium transition-all ${
              activeSection === tab.id
                ? 'bg-white text-slate-800 shadow-sm'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <tab.Icon className="w-3.5 h-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── SEÇÃO 1: AUTENTICAÇÃO ── */}
      {activeSection === 'auth' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">

          {/* Gerenciamento de Contas */}
          <div className="lg:col-span-4 bg-white rounded-xl border border-slate-200 shadow-sm p-4 space-y-4 flex flex-col">
            <h3 className="font-semibold text-slate-800 flex items-center gap-2 text-sm">
              <Smartphone className="w-4 h-4 text-emerald-600" />
              Contas do WhatsApp
            </h3>

            {/* Criar Conta */}
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Nome da conta (ex: Suporte)..."
                value={newSessionName}
                disabled={senderRunning}
                onChange={e => setNewSessionName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleCreateSession()}
                className="flex-1 px-3 py-1.5 border border-slate-300 rounded-lg text-xs outline-none focus:ring-2 focus:ring-emerald-500 font-sans"
              />
              <button
                onClick={handleCreateSession}
                disabled={!newSessionName.trim() || senderRunning}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 text-white rounded-lg text-xs font-semibold transition-colors"
              >
                Adicionar
              </button>
            </div>

            {/* Lista */}
            <div className="space-y-2 overflow-y-auto flex-1 max-h-[320px]">
              {sessions.map(s => {
                const isSelected = activeSessionId === s.id;
                const statusInfo = sessionStatusConfig[s.status] || sessionStatusConfig.idle;
                return (
                  <div
                    key={s.id}
                    onClick={() => setActiveSessionId(s.id)}
                    className={`p-3 rounded-lg border cursor-pointer transition-all flex flex-col gap-1.5 ${
                      isSelected
                        ? 'border-emerald-500 bg-emerald-50/40 shadow-sm'
                        : 'border-slate-200 bg-slate-50 hover:bg-slate-100/70'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-xs text-slate-800 truncate max-w-[120px]">{s.name}</span>
                      <div className="flex items-center gap-1">
                        {/* Botão de desvincular conta (logout) */}
                        {((s.status !== 'idle' && s.status !== 'disconnected' && s.status !== 'error') || s.phone) && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleLogout(s.id);
                            }}
                            disabled={senderRunning}
                            className="text-slate-400 hover:text-amber-500 transition-colors p-1 rounded disabled:opacity-30"
                            title="Desvincular / Logout (Limpar Login)"
                          >
                            <LogOut className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {/* Botão de excluir conta do sistema */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteSession(s.id);
                          }}
                          disabled={senderRunning}
                          className="text-slate-400 hover:text-red-500 transition-colors p-1 rounded disabled:opacity-30"
                          title="Excluir conta do sistema"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-slate-500">
                      <span>{s.phone ? `📞 ${s.phone}` : 'Sem número'}</span>
                      <span className={`inline-flex items-center gap-1 font-semibold ${statusInfo.color}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${statusInfo.dot}`} />
                        {statusInfo.label}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* QR / Status */}
          <div className="lg:col-span-5 bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-semibold text-slate-800 flex items-center gap-2 text-sm truncate">
                <QrCode className="w-4 h-4 text-emerald-600" />
                Conectar: {sessions.find(s => s.id === activeSessionId)?.name || 'Carregando...'}
              </h3>
              {sessionStatus === 'authenticated' && (
                <span className="text-xs text-emerald-600 font-semibold bg-emerald-50 px-2 py-0.5 rounded-full">✓ Ativo</span>
              )}
            </div>

            <div className="p-4 flex-1 flex flex-col justify-between gap-4">
              {/* Visualização da tela / QR */}
              <div className="relative w-full aspect-video bg-slate-900 rounded-lg overflow-hidden flex items-center justify-center">
                {screenshot ? (
                  <img
                    src={`data:image/png;base64,${screenshot}`}
                    alt="WhatsApp Web"
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <div className="text-center text-slate-500 space-y-2 p-6">
                    <Smartphone className="w-10 h-10 mx-auto text-slate-600" />
                    <p className="text-xs leading-normal">
                      {sessionStatus === 'idle' || sessionStatus === 'disconnected'
                        ? 'Clique em "Iniciar Navegador" para gerar o QR Code'
                        : sessionStatus === 'starting'
                        ? 'Carregando o navegador do WhatsApp...'
                        : 'Carregando...'}
                    </p>
                  </div>
                )}
                {(sessionStatus === 'starting') && (
                  <div className="absolute inset-0 bg-slate-900/60 flex items-center justify-center">
                    <Loader2 className="w-8 h-8 text-white animate-spin" />
                  </div>
                )}
              </div>

              {/* Instruções */}
              {sessionStatus === 'qr_waiting' && (
                <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-[10px] text-amber-700 leading-normal font-sans">
                  <p className="font-bold mb-1">📱 Como escanear o QR Code:</p>
                  <ol className="list-decimal list-inside space-y-0.5">
                    <li>Abra o WhatsApp no celular</li>
                    <li>Vá em Dispositivos Conectados</li>
                    <li>Toque em "Conectar Dispositivo" e aponte para a imagem acima</li>
                  </ol>
                </div>
              )}

              {sessionStatus === 'authenticated' && (
                <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-[10px] text-emerald-700 font-semibold text-center font-sans">
                  ✅ Conta conectada! Se for usar no envio, selecione-a na aba "Disparo".
                </div>
              )}

              {/* Botões */}
              <div className="flex gap-2 mt-2 flex-wrap">
                {(sessionStatus === 'idle' || sessionStatus === 'disconnected' || sessionStatus === 'error') ? (
                  <>
                    <button
                      onClick={() => handleStartSession(activeSessionId)}
                      disabled={senderRunning}
                      className="flex-1 flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold py-2 px-4 rounded-lg transition-colors text-xs min-w-[150px]"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      Iniciar Navegador
                    </button>
                    {sessions.find(s => s.id === activeSessionId)?.phone && (
                      <button
                        onClick={() => handleLogout(activeSessionId)}
                        disabled={senderRunning}
                        className="flex items-center justify-center gap-2 bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 font-semibold py-2 px-4 rounded-lg transition-colors text-xs shadow-sm shadow-red-100"
                        title="Desvincular conta (fazer logout e limpar QR Code)"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        Desvincular
                      </button>
                    )}
                  </>
                ) : (
                  <>
                    {sessionStatus === 'authenticated' && (
                      <button
                        onClick={() => setActiveSection('campaign')}
                        className="flex-1 flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2 px-4 rounded-lg transition-colors text-xs min-w-[150px]"
                      >
                        <MessageSquare className="w-3.5 h-3.5" />
                        Configurar Campanha
                      </button>
                    )}
                    <button
                      onClick={() => handleDisconnect(activeSessionId)}
                      disabled={senderRunning}
                      className="flex-1 flex items-center justify-center gap-2 border border-slate-300 text-slate-600 hover:border-slate-400 font-semibold py-2 px-3 rounded-lg transition-colors text-xs min-w-[120px]"
                      title="Parar Navegador (fecha a janela do Chrome em background)"
                    >
                      <WifiOff className="w-3.5 h-3.5" />
                      Parar Navegador
                    </button>
                    <button
                      onClick={() => handleLogout(activeSessionId)}
                      disabled={senderRunning}
                      className="flex-1 flex items-center justify-center gap-2 bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 font-semibold py-2 px-3 rounded-lg transition-colors text-xs min-w-[120px]"
                      title="Desvincular conta (fazer logout e limpar QR Code)"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                      Desvincular
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Log da sessão */}
          <div className="lg:col-span-3 bg-slate-900 rounded-xl border border-slate-800 flex flex-col overflow-hidden">
            <div className="bg-slate-800 px-4 py-3 border-b border-slate-700 flex items-center justify-between">
              <span className="text-xs font-mono text-slate-300">browser.log</span>
              {sessionStatus === 'qr_waiting' && (
                <span className="flex items-center gap-1.5 text-[10px] text-amber-400 font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                  QR pendente
                </span>
              )}
              {sessionStatus === 'authenticated' && (
                <span className="flex items-center gap-1.5 text-[10px] text-emerald-400 font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  Conectado
                </span>
              )}
            </div>
            <div className="p-3 overflow-y-auto flex-1 font-mono text-[10px] leading-relaxed space-y-1 min-h-[220px] max-h-[360px]">
              {sessionLogs.length === 0 ? (
                <p className="text-slate-600 italic">Aguardando início...</p>
              ) : (
                sessionLogs.map((log, i) => (
                  <div key={i} className={`${
                    log.includes('❌') ? 'text-red-400' :
                    log.includes('✅') ? 'text-emerald-400' :
                    log.includes('🚀') || log.includes('🌐') ? 'text-blue-400' :
                    log.includes('📱') ? 'text-amber-400' : 'text-slate-300'
                  }`}>{log}</div>
                ))
              )}
              <div ref={sessionLogEndRef} />
            </div>
          </div>
        </div>
      )}

      {/* ── SEÇÃO 2: CAMPANHA ── */}
      {activeSection === 'campaign' && (
        <div className="space-y-5">

          {sessionStatus !== 'authenticated' && (
            <div className="flex items-center gap-3 p-4 bg-amber-50 border border-amber-200 rounded-xl text-amber-700 text-sm">
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              <span>WhatsApp não está autenticado. <button onClick={() => setActiveSection('auth')} className="underline font-medium">Faça login primeiro</button>.</span>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

            {/* Mensagem */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
              <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-emerald-600" />
                Mensagem
              </h3>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">
                  Template da mensagem
                  <span className="ml-2 font-normal text-slate-400">Use: {'{nome}'} {'{empresa}'} {'{telefone}'}</span>
                </label>
                <textarea
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  rows={6}
                  className="w-full px-3 py-2.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 outline-none resize-none font-mono"
                  placeholder="Olá {nome}! Gostaria de apresentar nossa solução para a {empresa}..."
                />
              </div>

              {/* Preview */}
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Preview (com exemplo)</label>
                <div className="bg-[#ECE5DD] rounded-xl p-3 min-h-[80px]">
                  <div className="bg-white rounded-lg rounded-tl-none p-3 shadow-sm max-w-xs text-sm text-slate-800 whitespace-pre-wrap leading-relaxed">
                    {previewMessage}
                  </div>
                </div>
              </div>
            </div>

            {/* Adicionar contato manual */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                  <Users className="w-4 h-4 text-emerald-600" />
                  Contatos
                  <span className="text-xs text-slate-400 font-normal">{contacts.length} cadastrados</span>
                </h3>
                <div className="flex items-center gap-1.5 flex-wrap justify-end">
                  {/* Baixar modelo CSV */}
                  <button
                    onClick={downloadCSVTemplate}
                    title="Baixar modelo CSV"
                    className="flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-800 bg-slate-50 hover:bg-slate-100 border border-slate-200 px-2.5 py-1.5 rounded-lg transition-colors"
                  >
                    <Download className="w-3.5 h-3.5" />
                    Modelo
                  </button>

                  {/* Upload CSV */}
                  <button
                    onClick={() => csvInputRef.current?.click()}
                    title="Importar contatos via CSV"
                    className="flex items-center gap-1.5 text-xs font-medium text-violet-600 hover:text-violet-700 bg-violet-50 hover:bg-violet-100 border border-violet-200 px-2.5 py-1.5 rounded-lg transition-colors"
                  >
                    <FileText className="w-3.5 h-3.5" />
                    CSV
                  </button>
                  <input
                    ref={csvInputRef}
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={e => {
                      const f = e.target.files?.[0];
                      if (f) handleCSVUpload(f);
                      e.target.value = '';
                    }}
                  />

                  {/* Importar leads extraídos */}
                  {extractedLeads.filter(l => l.Telefone).length > 0 && (
                    <button
                      onClick={importLeads}
                      className="flex items-center gap-1.5 text-xs font-medium text-indigo-600 hover:text-indigo-700 bg-indigo-50 hover:bg-indigo-100 px-2.5 py-1.5 rounded-lg transition-colors"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      Leads ({extractedLeads.filter(l => l.Telefone).length})
                    </button>
                  )}
                </div>
              </div>

              {/* Feedback do CSV */}
              {csvError && (
                <div className={`text-xs px-3 py-2 rounded-lg border ${
                  csvError.startsWith('✅')
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                    : 'bg-red-50 border-red-200 text-red-700'
                }`}>
                  {csvError}
                </div>
              )}

              {/* Form de novo contato */}
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="Telefone *"
                    value={newPhone}
                    onChange={e => setNewPhone(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addContact()}
                    className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 outline-none"
                  />
                  <input
                    type="text"
                    placeholder="Nome"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addContact()}
                    className="px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 outline-none"
                  />
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="Empresa"
                    value={newCompany}
                    onChange={e => setNewCompany(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addContact()}
                    className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-emerald-500 outline-none"
                  />
                  <button
                    onClick={addContact}
                    disabled={!newPhone.trim()}
                    className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-medium py-2 px-3 rounded-lg transition-colors text-sm"
                  >
                    <Plus className="w-4 h-4" />
                    Add
                  </button>
                </div>
              </div>

              {/* Lista de contatos */}
              <div className="max-h-[200px] overflow-y-auto space-y-1.5">
                {contacts.length === 0 ? (
                  <p className="text-center text-xs text-slate-400 py-6">Nenhum contato cadastrado ainda.</p>
                ) : (
                  contacts.map(c => (
                    <div key={c.id} className="flex items-center justify-between gap-2 p-2 bg-slate-50 rounded-lg border border-slate-100">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-slate-800 truncate">{c.name || '(sem nome)'}</p>
                        <p className="text-[10px] text-slate-500 font-mono">{c.phone}</p>
                      </div>
                      <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${statusColors[c.status]}`}>
                        {statusIcons[c.status]}
                        {statusLabels[c.status]}
                      </span>
                      <button
                        onClick={() => removeContact(c.id)}
                        disabled={senderRunning}
                        className="text-slate-400 hover:text-red-500 transition-colors disabled:opacity-30"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Botão para próxima etapa */}
          <button
            onClick={() => setActiveSection('send')}
            disabled={contacts.length === 0 || !message.trim()}
            className="w-full flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:text-slate-500 text-white font-medium py-3 px-4 rounded-xl transition-colors"
          >
            <Settings className="w-4 h-4" />
            Configurar Disparo ({contacts.filter(c => c.status === 'pending').length} pendentes)
          </button>
        </div>
      )}

      {/* ── SEÇÃO 3: VALIDAÇÃO ── */}
      {activeSection === 'validate' && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* Card 1: Configuração da Validação */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
              <h3 className="font-semibold text-slate-800 flex items-center gap-2 text-sm">
                <Settings className="w-4 h-4 text-emerald-600" />
                Configurar Validação
              </h3>
              
              <div className="space-y-3 font-sans">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1.5">Conta para verificação:</label>
                  <select
                    disabled={validatorRunning}
                    value={validateActiveSessionId}
                    onChange={e => setValidateActiveSessionId(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium outline-none focus:ring-2 focus:ring-emerald-500 bg-white"
                  >
                    <option value="">Selecione uma conta...</option>
                    {sessions.map(s => (
                      <option key={s.id} value={s.id} disabled={s.status !== 'authenticated'}>
                        {s.name} ({s.status === 'authenticated' ? 'Conectada' : 'Desconectada'})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <div className="flex justify-between mb-1">
                    <label className="text-xs font-medium text-slate-600">Delay entre verificações</label>
                    <span className="text-xs font-bold text-emerald-600">{validateDelayMs / 1000}s</span>
                  </div>
                  <input
                    type="range"
                    min={2000}
                    max={10000}
                    step={500}
                    disabled={validatorRunning}
                    value={validateDelayMs}
                    onChange={e => setValidateDelayMs(+e.target.value)}
                    className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                  <p className="text-[10px] text-slate-400 mt-1 leading-normal">
                    Recomendado: 3s ou mais para evitar bloqueios ou detecção como automação pelo WhatsApp.
                  </p>
                </div>
              </div>

              <div className="pt-2 space-y-2">
                {!validatorRunning ? (
                  <button
                    onClick={handleStartValidate}
                    disabled={!validateActiveSessionId || sessions.find(s => s.id === validateActiveSessionId)?.status !== 'authenticated' || contacts.length === 0}
                    className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 text-white font-semibold py-2.5 px-4 rounded-xl transition-colors text-xs"
                  >
                    <Play className="w-3.5 h-3.5 fill-current" />
                    Iniciar Validação
                  </button>
                ) : (
                  <button
                    onClick={handleStopValidate}
                    className="w-full flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 text-white font-semibold py-2.5 px-4 rounded-xl transition-colors text-xs"
                  >
                    <Square className="w-3.5 h-3.5 fill-current" />
                    Parar Validação
                  </button>
                )}
                
                <div className="flex gap-2">
                  <button
                    onClick={downloadValidationReport}
                    disabled={validatorResults.length === 0}
                    className="flex-1 flex items-center justify-center gap-1.5 bg-slate-100 hover:bg-slate-200 disabled:bg-slate-50 disabled:text-slate-300 border border-slate-200 text-slate-700 font-semibold py-2 px-3 rounded-lg text-xs transition-colors"
                    title="Exportar CSV do relatório de validação"
                  >
                    <Download className="w-3 h-3" />
                    Exportar
                  </button>

                  <button
                    onClick={handleRemoveInvalidContacts}
                    disabled={validatorResults.filter(r => r && r.status === 'invalid').length === 0}
                    className="flex-1 flex items-center justify-center gap-1.5 bg-red-50 hover:bg-red-100 disabled:bg-slate-50 disabled:text-slate-300 border border-red-100 text-red-700 font-semibold py-2 px-3 rounded-lg text-xs transition-colors"
                    title="Remover os contatos inválidos da lista de disparo"
                  >
                    <Trash2 className="w-3 h-3" />
                    Limpar Lista
                  </button>
                </div>
              </div>
            </div>

            {/* Card 2: Estatísticas */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
              <h3 className="font-semibold text-slate-800 flex items-center gap-2 text-sm">
                <CheckCircle className="w-4 h-4 text-emerald-600" />
                Resumo da Validação
              </h3>

              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'Total', value: validatorStats?.total ?? 0, color: 'text-slate-700', bg: 'bg-slate-50 border-slate-200' },
                  { label: 'Válidos', value: validatorStats?.valid ?? 0, color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' },
                  { label: 'Inválidos', value: validatorStats?.invalid ?? 0, color: 'text-red-700', bg: 'bg-red-50 border-red-200' },
                  { label: 'Pendentes', value: validatorStats?.pending ?? 0, color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200' },
                ].map(s => (
                  <div key={s.label} className={`${s.bg} border rounded-lg p-2.5 text-center`}>
                    <div className={`text-xl font-bold ${s.color}`}>{s.value}</div>
                    <div className="text-[11px] text-slate-500 mt-0.5">{s.label}</div>
                  </div>
                ))}
              </div>

              {(validatorStats?.total ?? 0) > 0 && (
                <div className="space-y-1 pt-1">
                  <div className="flex justify-between text-[11px] text-slate-500">
                    <span>
                      {(validatorStats?.total ?? 0) - (validatorStats?.pending ?? 0)} de {validatorStats?.total ?? 0} verificados
                    </span>
                    <span>
                      {Math.round((((validatorStats?.total ?? 0) - (validatorStats?.pending ?? 0)) / Math.max(1, validatorStats?.total ?? 1)) * 100)}%
                    </span>
                  </div>
                  <div className="w-full bg-slate-200 rounded-full h-2.5 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600 transition-all duration-500"
                      style={{ width: `${Math.round((((validatorStats?.total ?? 0) - (validatorStats?.pending ?? 0)) / Math.max(1, validatorStats?.total ?? 1)) * 100)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Card 3: Terminal de Logs */}
            <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden flex flex-col h-full min-h-[220px]">
              <div className="bg-slate-800 px-4 py-2 border-b border-slate-700 flex items-center justify-between flex-shrink-0">
                <span className="text-xs font-mono text-slate-300">validacao.log</span>
                {validatorRunning && (
                  <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                    Validando
                  </span>
                )}
              </div>
              <div className="p-3 overflow-y-auto font-mono text-xs leading-relaxed space-y-1 flex-1 max-h-[180px]">
                {validateLogs.length === 0 ? (
                  <p className="text-slate-600 italic">Aguardando início da validação...</p>
                ) : (
                  validateLogs.map((log, i) => (
                    <div key={i} className={`${
                      log.includes('❌') ? 'text-red-400' :
                      log.includes('✅') ? 'text-emerald-400' :
                      log.includes('🔎') ? 'text-blue-400' :
                      log.includes('🏁') ? 'text-purple-400' :
                      log.includes('🛑') ? 'text-red-400' :
                      log.includes('⚠️') ? 'text-amber-300 font-semibold' : 'text-slate-300'
                    }`}>{log}</div>
                  ))
                )}
                <div ref={validatorLogEndRef} />
              </div>
            </div>
          </div>

          {/* Tabela de Resultados da Validação */}
          {contacts.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                <h3 className="font-semibold text-slate-800 text-sm">Status da Validação dos Contatos</h3>
                <div className="flex items-center gap-3 text-xs text-slate-500">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400" /> Válidos: {validatorStats.valid}</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400" /> Inválidos: {validatorStats.invalid}</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-300" /> Pendentes: {validatorStats.pending}</span>
                </div>
              </div>
              <div className="overflow-x-auto max-h-[350px] overflow-y-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50/80 sticky top-0 text-xs text-slate-500 font-medium">
                    <tr>
                      <th className="px-4 py-2 w-12 text-center">Nº</th>
                      <th className="px-4 py-2">Nome</th>
                      <th className="px-4 py-2">Telefone</th>
                      <th className="px-4 py-2">Empresa</th>
                      <th className="px-4 py-2">Status</th>
                      <th className="px-4 py-2">Telefone Formatado</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {contacts.map((c, index) => {
                      const result = validatorResults[index] || { status: 'pending' };
                      
                      const validationColors = {
                        pending: 'bg-slate-100 text-slate-600',
                        checking: 'bg-blue-100 text-blue-700',
                        valid: 'bg-emerald-100 text-emerald-700',
                        invalid: 'bg-red-100 text-red-700',
                        unknown: 'bg-amber-100 text-amber-700',
                      };

                      const validationLabels = {
                        pending: 'Pendente',
                        checking: 'Verificando…',
                        valid: 'No WhatsApp',
                        invalid: 'Fora do WhatsApp',
                        unknown: 'Erro',
                      };

                      const validationIcons = {
                        pending: <Clock className="w-3 h-3" />,
                        checking: <Loader2 className="w-3 h-3 animate-spin" />,
                        valid: <CheckCircle className="w-3 h-3" />,
                        invalid: <XCircle className="w-3 h-3" />,
                        unknown: <AlertTriangle className="w-3 h-3" />,
                      };

                      return (
                        <tr key={c.id} className="hover:bg-slate-50/50">
                          <td className="px-4 py-2 text-center font-mono text-xs text-slate-400">{index + 1}</td>
                          <td className="px-4 py-2 font-medium text-slate-800">{c.name || '-'}</td>
                          <td className="px-4 py-2 text-slate-600 font-mono text-xs">{c.phone}</td>
                          <td className="px-4 py-2 text-slate-500 text-xs truncate max-w-[140px]">{c.company || '-'}</td>
                          <td className="px-4 py-2">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${validationColors[result.status as keyof typeof validationColors] || validationColors.pending}`}>
                              {validationIcons[result.status as keyof typeof validationIcons] || validationIcons.pending}
                              {validationLabels[result.status as keyof typeof validationLabels] || validationLabels.pending}
                            </span>
                          </td>
                          <td className="px-4 py-2 text-xs text-slate-500 font-mono">
                            {result.usedPhone || '-'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── SEÇÃO 4: DISPARO ── */}
      {activeSection === 'send' && (
        <div className="space-y-5">

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

            {/* Configuração de ritmo */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-5">
              <h3 className="font-semibold text-slate-800 flex items-center gap-2">
                <Settings className="w-4 h-4 text-emerald-600" />
                Controle de Ritmo
              </h3>

              <div className="space-y-4">
                {/* Delay mínimo */}
                <div>
                  <div className="flex justify-between mb-1">
                    <label className="text-xs font-medium text-slate-600">Intervalo mínimo</label>
                    <span className="text-xs font-bold text-emerald-600">{config.delayMinSec}s</span>
                  </div>
                  <input type="range" min={5} max={120} value={config.delayMinSec}
                    onChange={e => setConfig(p => ({ ...p, delayMinSec: +e.target.value }))}
                    className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                {/* Delay máximo */}
                <div>
                  <div className="flex justify-between mb-1">
                    <label className="text-xs font-medium text-slate-600">Intervalo máximo</label>
                    <span className="text-xs font-bold text-emerald-600">{config.delayMaxSec}s</span>
                  </div>
                  <input type="range" min={config.delayMinSec + 5} max={300} value={config.delayMaxSec}
                    onChange={e => setConfig(p => ({ ...p, delayMaxSec: +e.target.value }))}
                    className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                {/* Limite por hora */}
                <div>
                  <div className="flex justify-between mb-1">
                    <label className="text-xs font-medium text-slate-600">Limite por hora</label>
                    <span className="text-xs font-bold text-emerald-600">{config.limitPerHour} msgs</span>
                  </div>
                  <input type="range" min={5} max={50} value={config.limitPerHour}
                    onChange={e => setConfig(p => ({ ...p, limitPerHour: +e.target.value }))}
                    className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                {/* Pausa após N */}
                <div>
                  <div className="flex justify-between mb-1">
                    <label className="text-xs font-medium text-slate-600">Pausa após</label>
                    <span className="text-xs font-bold text-emerald-600">{config.pauseAfterN} envios</span>
                  </div>
                  <input type="range" min={3} max={30} value={config.pauseAfterN}
                    onChange={e => setConfig(p => ({ ...p, pauseAfterN: +e.target.value }))}
                    className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>

                {/* Duração da pausa */}
                <div>
                  <div className="flex justify-between mb-1">
                    <label className="text-xs font-medium text-slate-600">Duração da pausa</label>
                    <span className="text-xs font-bold text-emerald-600">{config.pauseDurationMin} min</span>
                  </div>
                  <input type="range" min={1} max={30} value={config.pauseDurationMin}
                    onChange={e => setConfig(p => ({ ...p, pauseDurationMin: +e.target.value }))}
                    className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              </div>

              {/* Resumo de segurança */}
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-700">
                <p className="font-medium mb-1">🛡️ Proteção Anti-Bloqueio</p>
                <p>Delays aleatórios de {config.delayMinSec}–{config.delayMaxSec}s entre mensagens, pausa de {config.pauseDurationMin}min a cada {config.pauseAfterN} envios e limite de {config.limitPerHour}/hora.</p>
              </div>
            </div>

            {/* Canais de Envio e Rotação */}
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
              <h3 className="font-semibold text-slate-800 flex items-center gap-2 text-sm">
                <Users className="w-4 h-4 text-emerald-600" />
                Canais de Envio (Rotação)
              </h3>

              <div className="space-y-3 font-sans">
                {/* Seleção de contas */}
                <div>
                  <label className="block text-[11px] font-medium text-slate-600 mb-1.5">Escolha as contas ativas no disparo:</label>
                  <div className="space-y-1.5 max-h-[140px] overflow-y-auto">
                    {sessions.map(s => {
                      const isConnected = s.status === 'authenticated';
                      const isChecked = selectedSessionIds.includes(s.id);
                      return (
                        <label
                          key={s.id}
                          className={`flex items-center justify-between p-2 rounded-lg border text-xs cursor-pointer transition-colors ${
                            isChecked
                              ? 'border-emerald-300 bg-emerald-50/20'
                              : 'border-slate-200 hover:bg-slate-50'
                          } ${!isConnected ? 'opacity-50 cursor-not-allowed' : ''}`}
                        >
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              disabled={!isConnected || senderRunning}
                              checked={isChecked}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedSessionIds(prev => [...prev, s.id]);
                                } else {
                                  if (selectedSessionIds.length > 1) {
                                    setSelectedSessionIds(prev => prev.filter(id => id !== s.id));
                                  }
                                }
                              }}
                              className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 w-3.5 h-3.5"
                            />
                            <span className="font-semibold text-slate-700">{s.name}</span>
                          </div>
                          <span className={`text-[9px] font-semibold ${isConnected ? 'text-emerald-600' : 'text-slate-400'}`}>
                            {isConnected ? 'Disponível' : 'Offline'}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {/* Modo de Rotação */}
                {selectedSessionIds.length > 1 && (
                  <div className="space-y-3 pt-3 border-t border-slate-100">
                    <div>
                      <label className="block text-[11px] font-medium text-slate-600 mb-1.5">Modo de Rotação</label>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={senderRunning}
                          onClick={() => setRotationMode('message')}
                          className={`flex-1 py-1.5 px-2 rounded-lg text-xs font-semibold border transition-all ${
                            rotationMode === 'message'
                              ? 'bg-emerald-600 border-emerald-600 text-white shadow-sm'
                              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          Por mensagem
                        </button>
                        <button
                          type="button"
                          disabled={senderRunning}
                          onClick={() => setRotationMode('batch')}
                          className={`flex-1 py-1.5 px-2 rounded-lg text-xs font-semibold border transition-all ${
                            rotationMode === 'batch'
                              ? 'bg-emerald-600 border-emerald-600 text-white shadow-sm'
                              : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                          }`}
                        >
                          Por lote
                        </button>
                      </div>
                    </div>

                    {rotationMode === 'batch' && (
                      <div className="flex items-center justify-between bg-slate-50 p-2 rounded-lg border border-slate-100">
                        <label className="text-xs font-medium text-slate-600">Tamanho do lote:</label>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            min={2}
                            max={100}
                            disabled={senderRunning}
                            value={rotationBatchSize}
                            onChange={e => setRotationBatchSize(Math.max(2, +e.target.value))}
                            className="w-14 px-2 py-1 text-xs border border-slate-300 rounded-lg text-center font-bold focus:ring-1 focus:ring-emerald-500 outline-none"
                          />
                          <span className="text-[10px] text-slate-500 font-semibold">msgs</span>
                        </div>
                      </div>
                    )}

                    {/* Proteção de Rotação Inteligente */}
                    <div className="space-y-2 pt-2 border-t border-slate-100">
                      <label className="block text-[11px] font-medium text-slate-600">🛡️ Proteção de Rotação</label>

                      {/* Falhas antes de remover conta */}
                      <div className="flex items-center justify-between bg-slate-50 p-2 rounded-lg border border-slate-100">
                        <div>
                          <p className="text-[11px] font-medium text-slate-700">Falhas para remover conta</p>
                          <p className="text-[10px] text-slate-400">Nº de erros seguidos antes de degradar</p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            min={1}
                            max={10}
                            disabled={senderRunning}
                            value={config.maxConsecutiveFailsPerSession}
                            onChange={e => setConfig(p => ({ ...p, maxConsecutiveFailsPerSession: Math.max(1, +e.target.value) }))}
                            className="w-12 px-2 py-1 text-xs border border-slate-300 rounded-lg text-center font-bold focus:ring-1 focus:ring-emerald-500 outline-none"
                          />
                          <span className="text-[10px] text-slate-500 font-semibold">erros</span>
                        </div>
                      </div>

                      {/* Parar se rotação quebrar */}
                      <label className={`flex items-center justify-between p-2 rounded-lg border cursor-pointer transition-colors ${
                        config.stopIfRotationBroken
                          ? 'border-red-200 bg-red-50/40'
                          : 'border-slate-200 bg-slate-50 hover:bg-slate-100'
                      }`}>
                        <div>
                          <p className="text-[11px] font-medium text-slate-700">Parar se uma conta cair</p>
                          <p className="text-[10px] text-slate-400">Interrompe o disparo se o pool de rotação ficar incompleto</p>
                        </div>
                        <input
                          type="checkbox"
                          disabled={senderRunning}
                          checked={config.stopIfRotationBroken}
                          onChange={e => setConfig(p => ({ ...p, stopIfRotationBroken: e.target.checked }))}
                          className="rounded border-slate-300 text-red-500 focus:ring-red-400 w-3.5 h-3.5"
                        />
                      </label>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Progresso e controles */}
            <div className="lg:col-span-2 space-y-4">

              {/* Estatísticas */}
              <div className="grid grid-cols-4 gap-3">
                {[
                  { label: 'Total', value: stats?.total ?? 0, color: 'text-slate-700', bg: 'bg-slate-50 border-slate-200' },
                  { label: 'Enviados', value: stats?.sent ?? 0, color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200' },
                  { label: 'Falhas', value: stats?.failed ?? 0, color: 'text-red-700', bg: 'bg-red-50 border-red-200' },
                  { label: 'Pendentes', value: stats?.pending ?? 0, color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200' },
                ].map(s => (
                  <div key={s.label} className={`${s.bg} border rounded-xl p-3 text-center`}>
                    <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
                    <div className="text-xs text-slate-500 mt-0.5">{s.label}</div>
                  </div>
                ))}
              </div>

              {/* Barra de progresso */}
              {(stats?.total ?? 0) > 0 && (
                <div>
                  <div className="flex justify-between text-xs text-slate-500 mb-1">
                    <span>{(stats?.sent ?? 0) + (stats?.failed ?? 0)} de {stats?.total ?? 0}</span>
                    <span>{progressPct}%</span>
                  </div>
                  <div className="w-full bg-slate-200 rounded-full h-3 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600 transition-all duration-500"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                </div>
              )}

              {/* Banner de alerta: rotação comprometida */}
              {rotationAlert && (
                <div className="p-4 bg-red-50 border border-red-300 rounded-xl space-y-3">
                  <div className="flex items-start gap-3">
                    <div className="p-1.5 bg-red-100 rounded-lg flex-shrink-0">
                      <AlertTriangle className="w-4 h-4 text-red-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-red-800">🚨 Disparo Interrompido — Rotação Comprometida</p>
                      <p className="text-xs text-red-700 mt-0.5 leading-relaxed">
                        A conta <span className="font-bold">[{rotationAlert.degradedSession}]</span> foi removida do pool após {config.maxConsecutiveFailsPerSession} falhas consecutivas.
                        {rotationAlert.remainingCount > 0
                          ? ` Restam ${rotationAlert.remainingCount} de ${rotationAlert.minRequired} conta(s) ativas.`
                          : ' Nenhuma conta disponível no pool.'}
                      </p>
                      <p className="text-[11px] text-red-600 mt-1">Verifique a conta na aba <strong>Autenticação</strong> antes de retomar.</p>
                    </div>
                    <button
                      onClick={() => setRotationAlert(null)}
                      className="text-red-400 hover:text-red-600 p-1 flex-shrink-0"
                      title="Fechar alerta"
                    >
                      <XCircle className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setActiveSection('auth')}
                      className="flex-1 py-2 px-3 bg-white border border-red-300 text-red-700 hover:bg-red-50 font-semibold rounded-lg text-xs transition-colors"
                    >
                      Ir para Autenticação
                    </button>
                    {rotationAlert.remainingCount > 0 && (
                      <button
                        onClick={() => {
                          setRotationAlert(null);
                          handleStartSend();
                        }}
                        className="flex-1 py-2 px-3 bg-amber-500 hover:bg-amber-600 text-white font-semibold rounded-lg text-xs transition-colors"
                        title="Retoma o disparo usando apenas as contas ainda ativas (risco de bloqueio aumentado)"
                      >
                        ⚠️ Retomar com {rotationAlert.remainingCount} conta(s)
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Botões de controle */}
              <div className="flex gap-2">
                {!senderRunning && (
                  <button
                    onClick={handleStartSend}
                    disabled={sessionStatus !== 'authenticated' || contacts.filter(c => c.status === 'pending').length === 0}
                    className="flex-1 flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 disabled:text-slate-500 text-white font-medium py-3 px-4 rounded-xl transition-colors"
                  >
                    <Send className="w-4 h-4" />
                    Iniciar Disparo
                  </button>
                )}
                {senderRunning && !senderPaused && (
                  <button
                    onClick={handlePause}
                    className="flex-1 flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-600 text-white font-medium py-3 px-4 rounded-xl transition-colors"
                  >
                    <Pause className="w-4 h-4" />
                    Pausar
                  </button>
                )}
                {senderRunning && senderPaused && (
                  <button
                    onClick={handleResume}
                    className="flex-1 flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 px-4 rounded-xl transition-colors"
                  >
                    <Play className="w-4 h-4 fill-current" />
                    Retomar
                  </button>
                )}
                {senderRunning && (
                  <button
                    onClick={handleStop}
                    className="flex items-center justify-center gap-2 bg-red-600 hover:bg-red-700 text-white font-medium py-3 px-4 rounded-xl transition-colors"
                  >
                    <Square className="w-4 h-4 fill-current" />
                    Parar
                  </button>
                )}
              </div>

              {/* Terminal de envio */}
              <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
                <div className="bg-slate-800 px-4 py-2 border-b border-slate-700 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono text-slate-300">disparo.log</span>
                    {sendLogs.length > 0 && (
                      <button
                        onClick={downloadSendLogs}
                        title="Exportar logs de envio"
                        className="text-slate-400 hover:text-white transition-colors p-0.5 rounded hover:bg-slate-700"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  {senderRunning && (
                    <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                      Enviando
                    </span>
                  )}
                </div>
                <div className="p-3 overflow-y-auto font-mono text-xs leading-relaxed space-y-1 max-h-[200px]">
                  {sendLogs.length === 0 ? (
                    <p className="text-slate-600 italic">Aguardando início do disparo...</p>
                  ) : (
                    sendLogs.map((log, i) => (
                      <div key={i} className={`${
                        log.includes('❌') ? 'text-red-400' :
                        log.includes('✅') ? 'text-emerald-400' :
                        log.includes('📤') ? 'text-blue-400' :
                        log.includes('⏸') || log.includes('☕') ? 'text-amber-400' :
                        log.includes('🏁') ? 'text-purple-400' :
                        log.includes('🛑') ? 'text-red-400' :
                        log.includes('🚨') ? 'text-red-300 font-bold' :
                        log.includes('⚠️') ? 'text-amber-300 font-semibold' : 'text-slate-300'
                      }`}>{log}</div>
                    ))
                  )}
                  <div ref={sendLogEndRef} />
                </div>
              </div>
            </div>
          </div>

          {/* Tabela de contatos com status de envio */}
          {contacts.length > 0 && (
            <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
                <h3 className="font-semibold text-slate-800 text-sm">Status dos Contatos</h3>
                <div className="flex items-center gap-3 text-xs text-slate-500">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400" /> Enviados: {stats.sent}</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-400" /> Falhas: {stats.failed}</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-slate-300" /> Pendentes: {stats.pending}</span>
                </div>
              </div>
              <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50/80 sticky top-0 text-xs text-slate-500 font-medium">
                    <tr>
                      <th className="px-4 py-2 w-12 text-center">Nº</th>
                      <th className="px-4 py-2">Nome</th>
                      <th className="px-4 py-2">Telefone</th>
                      <th className="px-4 py-2">Empresa</th>
                      <th className="px-4 py-2">Status</th>
                      <th className="px-4 py-2">Enviado em</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {contacts.map((c, index) => (
                      <tr key={c.id} className="hover:bg-slate-50/50">
                        <td className="px-4 py-2 text-center font-mono text-xs text-slate-400">{index + 1}</td>
                        <td className="px-4 py-2 font-medium text-slate-800">{c.name || '-'}</td>
                        <td className="px-4 py-2 text-slate-600 font-mono text-xs">{c.phone}</td>
                        <td className="px-4 py-2 text-slate-500 text-xs truncate max-w-[140px]">{c.company || '-'}</td>
                        <td className="px-4 py-2">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[c.status]}`}>
                            {statusIcons[c.status]}
                            {statusLabels[c.status]}
                          </span>
                          {c.error && <p className="text-[10px] text-red-500 mt-0.5 truncate max-w-[120px]" title={c.error}>{c.error}</p>}
                        </td>
                        <td className="px-4 py-2 text-xs text-slate-400">
                          {c.sentAt ? new Date(c.sentAt).toLocaleTimeString('pt-BR') : '-'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modal de Confirmação de Exclusão Customizado */}
      {sessionToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-sm w-full p-6 space-y-4 mx-4">
            <div className="flex items-center gap-3 text-red-600">
              <div className="p-2 bg-red-50 rounded-xl">
                <Trash2 className="w-5 h-5" />
              </div>
              <h4 className="font-bold text-slate-800">Excluir Conta</h4>
            </div>
            
            <p className="text-sm text-slate-600 leading-relaxed font-sans">
              Tem certeza que deseja excluir a conta <span className="font-bold text-slate-800">"{sessions.find(s => s.id === sessionToDelete)?.name}"</span>? 
              Todos os dados de login e cookies salvos para ela serão permanentemente apagados do servidor.
            </p>
            
            <div className="flex gap-3 justify-end pt-2">
              <button
                onClick={() => setSessionToDelete(null)}
                className="px-4 py-2 text-slate-600 hover:text-slate-800 bg-slate-100 hover:bg-slate-200 font-semibold rounded-lg transition-colors text-xs"
              >
                Cancelar
              </button>
              <button
                onClick={() => {
                  confirmDeleteSession(sessionToDelete);
                  setSessionToDelete(null);
                }}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-lg transition-colors text-xs shadow-sm shadow-red-100"
              >
                Confirmar Exclusão
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Confirmação de Logout Customizado */}
      {sessionToLogout && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-sm w-full p-6 space-y-4 mx-4">
            <div className="flex items-center gap-3 text-amber-600">
              <div className="p-2 bg-amber-50 rounded-xl">
                <LogOut className="w-5 h-5" />
              </div>
              <h4 className="font-bold text-slate-800">Desvincular Conta</h4>
            </div>
            
            <p className="text-sm text-slate-600 leading-relaxed font-sans">
              Tem certeza que deseja desvincular a conta <span className="font-bold text-slate-800">"{sessions.find(s => s.id === sessionToLogout)?.name}"</span>? 
              Todos os cookies de login serão apagados do servidor e você precisará ler o QR Code novamente para se reconectar.
            </p>
            
            <div className="flex gap-3 justify-end pt-2">
              <button
                onClick={() => setSessionToLogout(null)}
                className="px-4 py-2 text-slate-600 hover:text-slate-800 bg-slate-100 hover:bg-slate-200 font-semibold rounded-lg transition-colors text-xs"
              >
                Cancelar
              </button>
              <button
                onClick={() => {
                  confirmLogoutSession(sessionToLogout);
                  setSessionToLogout(null);
                }}
                className="px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white font-semibold rounded-lg transition-colors text-xs shadow-sm shadow-amber-100"
              >
                Confirmar Desvinculação
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
