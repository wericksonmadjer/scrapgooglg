import React, { useState, useEffect, useRef } from 'react';
import { Terminal, Download, Play, ShieldCheck, Activity, Users, Mail, AlertTriangle, Square } from 'lucide-react';

export default function App() {
  const [nicho, setNicho] = useState('Dentistas');
  const [local, setLocal] = useState('São Paulo');
  const [isScraping, setIsScraping] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [leads, setLeads] = useState<any[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  const handleStartScraping = () => {
    if (isScraping) return;
    
    setIsScraping(true);
    setLogs([]);
    setLeads([]);

    const eventSource = new EventSource(`/api/scrape?nicho=${encodeURIComponent(nicho)}&local=${encodeURIComponent(local)}`);

    eventSource.addEventListener('log', (e) => {
      const message = JSON.parse(e.data);
      setLogs((prev) => [...prev, message]);
    });

    eventSource.addEventListener('lead', (e) => {
      const lead = JSON.parse(e.data);
      setLeads((prev) => [...prev, lead]);
    });

    eventSource.addEventListener('done', (e) => {
      setLogs((prev) => [...prev, '[Sistema] Processo finalizado com sucesso.']);
      setIsScraping(false);
      eventSource.close();
    });

    eventSource.onerror = (err) => {
      console.error('EventSource error:', err);
      setLogs((prev) => [...prev, '[Erro] Falha na conexão com o servidor. Verifique a rede.']);
      setIsScraping(false);
      eventSource.close();
    };
  };

  const handleDownloadCSV = () => {
    if (leads.length === 0) return;

    const headers = ['Nome', 'Telefone', 'Website', 'E-mails'];
    const csvContent = [
      headers.join(','),
      ...leads.map(lead => [
        `"${lead.Nome || ''}"`,
        `"${lead.Telefone || ''}"`,
        `"${lead.Website || ''}"`,
        `"${lead['E-mails'] || ''}"`
      ].join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `leads_${nicho.toLowerCase().replace(/\s/g, '_')}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const emailsCount = leads.filter(l => l['E-mails']).length;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        
        {/* Header */}
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 flex items-center gap-3">
            <Activity className="text-indigo-600 h-8 w-8" />
            Lead Extractor Dashboard
            <span className="bg-indigo-100 text-indigo-800 text-xs px-2.5 py-0.5 rounded-full font-medium ml-2">Test Version</span>
          </h1>
          <p className="text-slate-500 mt-2">Plataforma Server-Side de extração com proteção de IP integrada.</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* Controls & Stats (Left Column) */}
          <div className="lg:col-span-4 space-y-6">
            
            {/* Control Panel */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
              <h2 className="text-lg font-semibold mb-4 text-slate-800">1. Configuração</h2>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Nicho (Alvo)</label>
                  <input 
                    type="text" 
                    value={nicho}
                    onChange={(e) => setNicho(e.target.value)}
                    disabled={isScraping}
                    className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none disabled:opacity-50"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Localização</label>
                  <input 
                    type="text" 
                    value={local}
                    onChange={(e) => setLocal(e.target.value)}
                    disabled={isScraping}
                    className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none disabled:opacity-50"
                  />
                </div>
                
                <button
                  onClick={handleStartScraping}
                  disabled={isScraping || !nicho || !local}
                  className="w-full mt-4 flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium py-3 px-4 rounded-lg transition-colors"
                >
                  {isScraping ? <Square className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current" />}
                  {isScraping ? 'Extração em Andamento...' : 'Iniciar Extração Segura'}
                </button>
              </div>
            </div>

            {/* Stats Panel */}
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
                <div className="flex items-center gap-2 text-slate-500 mb-2">
                  <Users className="w-4 h-4" />
                  <span className="text-sm font-medium">Leads</span>
                </div>
                <div className="text-3xl font-bold text-slate-800">{leads.length}</div>
              </div>
              <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-5">
                <div className="flex items-center gap-2 text-slate-500 mb-2">
                  <Mail className="w-4 h-4" />
                  <span className="text-sm font-medium">E-mails</span>
                </div>
                <div className="text-3xl font-bold text-slate-800">{emailsCount}</div>
              </div>
            </div>

            {/* Security Indicator */}
            <div className={`p-4 rounded-xl border flex items-start gap-3 transition-colors ${
              isScraping ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-slate-100 border-slate-200 text-slate-600'
            }`}>
              {isScraping ? (
                <ShieldCheck className="w-6 h-6 flex-shrink-0 text-emerald-600 animate-pulse" />
              ) : (
                <ShieldCheck className="w-6 h-6 flex-shrink-0 text-slate-400" />
              )}
              <div>
                <h3 className="font-semibold text-sm">Escudo de IP (Proxy Web)</h3>
                <p className="text-xs mt-1 opacity-90">
                  {isScraping 
                    ? "Proteção ativa. Rotacionando endereço de IP para evitar rate-limit e bloqueio."
                    : "Em modo de espera. Será ativado automaticamente durante a extração."}
                </p>
              </div>
            </div>

          </div>

          {/* Activity Terminal & Data Table (Right Column) */}
          <div className="lg:col-span-8 flex flex-col gap-6">
            
            {/* Live Terminal */}
            <div className="bg-slate-900 rounded-xl shadow-lg border border-slate-800 flex flex-col h-64 overflow-hidden">
              <div className="bg-slate-800 px-4 py-3 border-b border-slate-700 flex justify-between items-center">
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-slate-400" />
                  <span className="text-xs font-mono text-slate-300">server_logs.sh</span>
                </div>
                {isScraping && (
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                  </span>
                )}
              </div>
              <div className="p-4 overflow-y-auto flex-1 font-mono text-xs leading-relaxed space-y-1">
                {logs.length === 0 ? (
                  <p className="text-slate-500 italic">Aguardando início do processo...</p>
                ) : (
                  logs.map((log, i) => (
                    <div key={i} className={`${
                      log.includes('[Proxy]') ? 'text-blue-400' : 
                      log.includes('[Erro]') ? 'text-red-400' : 
                      log.includes('[Scraper]') ? 'text-emerald-400' : 'text-slate-300'
                    }`}>
                      <span className="text-slate-600 mr-2">{new Date().toLocaleTimeString()}</span>
                      {log}
                    </div>
                  ))
                )}
                <div ref={logsEndRef} />
              </div>
            </div>

            {/* Data Table */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden flex-1 flex flex-col">
              <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50">
                <h2 className="text-sm font-semibold text-slate-800">Resultados da Extração</h2>
                <button
                  onClick={handleDownloadCSV}
                  disabled={leads.length === 0}
                  className="flex items-center gap-2 px-3 py-1.5 bg-white border border-slate-300 text-slate-700 rounded-md hover:bg-slate-50 disabled:opacity-50 disabled:hover:bg-white text-sm font-medium transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Exportar CSV
                </button>
              </div>
              <div className="overflow-x-auto flex-1">
                {leads.length === 0 ? (
                  <div className="flex flex-col items-center justify-center p-12 text-slate-400 h-full">
                    <AlertTriangle className="w-12 h-12 mb-3 text-slate-300" />
                    <p className="font-medium">Nenhum lead extraído ainda</p>
                    <p className="text-sm mt-1 text-slate-500">Inicie a extração para ver os resultados aqui.</p>
                  </div>
                ) : (
                  <table className="w-full text-left text-sm whitespace-nowrap">
                    <thead className="bg-slate-50/50 text-slate-500 sticky top-0">
                      <tr>
                        <th className="px-5 py-3 font-medium">Nome da Empresa</th>
                        <th className="px-5 py-3 font-medium">Telefone</th>
                        <th className="px-5 py-3 font-medium">Website</th>
                        <th className="px-5 py-3 font-medium">E-mail(s)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {leads.map((lead, i) => (
                        <tr key={i} className="hover:bg-slate-50/50 transition-colors">
                          <td className="px-5 py-3 font-medium text-slate-900">{lead.Nome}</td>
                          <td className="px-5 py-3 text-slate-600">{lead.Telefone || '-'}</td>
                          <td className="px-5 py-3">
                            {lead.Website ? (
                              <a href={lead.Website} target="_blank" rel="noreferrer" className="text-indigo-600 hover:text-indigo-800 hover:underline">
                                Acessar Site
                              </a>
                            ) : (
                              <span className="text-slate-400">-</span>
                            )}
                          </td>
                          <td className="px-5 py-3 text-slate-600">
                            {lead['E-mails'] ? (
                              <span className="px-2 py-1 bg-green-50 text-green-700 rounded text-xs font-medium border border-green-200">
                                {lead['E-mails']}
                              </span>
                            ) : (
                              <span className="text-slate-400">-</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}

