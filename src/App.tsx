import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal, Download, Play, ShieldCheck, Activity, Users, Mail, AlertTriangle, Square, MapPin, X, Smartphone } from 'lucide-react';
import WhatsAppPanel from './WhatsAppPanel';
import { sseUrl } from './apiClient';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix do ícone padrão do Leaflet (webpack/vite quebra os caminhos)
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// ── Componente do mapa ───────────────────────────────────────────────────────
interface MapPickerProps {
  onPinChange: (lat: number, lng: number) => void;
  onRadiusChange: (km: number) => void;
  radius: number;
  pin: { lat: number; lng: number } | null;
}

function MapPicker({ onPinChange, onRadiusChange, radius, pin }: MapPickerProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const circleRef = useRef<L.Circle | null>(null);

  // Inicializa o mapa apenas uma vez
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [-14.235, -51.9253], // Centro do Brasil
      zoom: 4,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    map.on('click', (e: L.LeafletMouseEvent) => {
      const { lat, lng } = e.latlng;
      onPinChange(lat, lng);
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Atualiza marcador e círculo quando pin ou raio mudam
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Remove elementos anteriores
    if (markerRef.current) { markerRef.current.remove(); markerRef.current = null; }
    if (circleRef.current)  { circleRef.current.remove();  circleRef.current = null;  }

    if (!pin) return;

    const marker = L.marker([pin.lat, pin.lng], { draggable: true }).addTo(map);
    marker.on('dragend', () => {
      const pos = marker.getLatLng();
      onPinChange(pos.lat, pos.lng);
    });
    markerRef.current = marker;

    const circle = L.circle([pin.lat, pin.lng], {
      radius: radius * 1000, // Leaflet usa metros
      color: '#6366f1',
      fillColor: '#6366f1',
      fillOpacity: 0.12,
      weight: 2,
    }).addTo(map);
    circleRef.current = circle;

    map.setView([pin.lat, pin.lng], Math.max(map.getZoom(), 12));
  }, [pin, radius]);

  return (
    <div className="space-y-3">
      {/* Mapa */}
      <div
        ref={mapContainerRef}
        className="w-full h-52 rounded-lg border border-slate-200 overflow-hidden cursor-crosshair"
        style={{ zIndex: 0 }}
      />

      {/* Instrução */}
      {!pin && (
        <p className="text-xs text-slate-400 text-center flex items-center justify-center gap-1">
          <MapPin className="w-3 h-3" /> Clique no mapa para posicionar o ponto central
        </p>
      )}

      {/* Coordenadas + botão limpar */}
      {pin && (
        <div className="flex items-center justify-between text-xs text-slate-500 bg-slate-50 px-3 py-1.5 rounded-md border border-slate-200">
          <span>
            📍 <span className="font-mono">{pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}</span>
          </span>
          <button
            onClick={() => onPinChange(0, 0)}
            className="text-slate-400 hover:text-red-500 transition-colors"
            title="Remover pin"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Slider de raio */}
      <div>
        <div className="flex justify-between items-center mb-1">
          <label className="text-xs font-medium text-slate-600">Raio de busca</label>
          <span className="text-xs font-bold text-indigo-600">{radius} km</span>
        </div>
        <input
          type="range"
          min={1}
          max={50}
          value={radius}
          onChange={(e) => onRadiusChange(Number(e.target.value))}
          className="w-full h-2 rounded-lg appearance-none cursor-pointer accent-indigo-600"
        />
        <div className="flex justify-between text-[10px] text-slate-400 mt-0.5">
          <span>1 km</span>
          <span>25 km</span>
          <span>50 km</span>
        </div>
      </div>
    </div>
  );
}

// ── App principal ─────────────────────────────────────────────────────────────────────────
export default function App() {
  const [activeTab, setActiveTab] = useState<'extraction' | 'whatsapp'>(() => {
    // Prioridade: URL atual > sessionStorage > padrão
    if (typeof window !== 'undefined') {
      if (window.location.pathname.includes('whatsapp')) return 'whatsapp';
      try {
        const saved = sessionStorage.getItem('ag_active_tab');
        if (saved === 'whatsapp' || saved === 'extraction') return saved;
      } catch {}
    }
    return 'extraction';
  });
  const [nicho, setNicho] = useState('Dentistas');
  const [local, setLocal] = useState('São Paulo');
  const [isScraping, setIsScraping] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [leads, setLeads] = useState<any[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const maxLeadsRef = useRef<HTMLInputElement>(null);

  // Estado do mapa
  const [mapOpen, setMapOpen] = useState(false);
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [radius, setRadius] = useState(5);

  // Volta ao topo na carga inicial da página
  useEffect(() => { window.scrollTo(0, 0); }, []);

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  const handlePinChange = useCallback((lat: number, lng: number) => {
    if (lat === 0 && lng === 0) {
      setPin(null);
    } else {
      setPin({ lat, lng });
    }
  }, []);

  const handleStartScraping = () => {
    if (isScraping) return;

    setIsScraping(true);
    setLogs([]);
    setLeads([]);

    const maxLeads = Math.max(5, Math.min(120, Number(maxLeadsRef.current?.value ?? 60)));

    // Monta a URL com coordenadas (modo mapa) ou texto (modo padrão)
    let apiUrl: string;
    if (mapOpen && pin) {
      apiUrl = `/api/scrape?nicho=${encodeURIComponent(nicho)}&lat=${pin.lat}&lng=${pin.lng}&radius=${radius}&maxLeads=${maxLeads}`;
    } else {
      apiUrl = `/api/scrape?nicho=${encodeURIComponent(nicho)}&local=${encodeURIComponent(local)}&maxLeads=${maxLeads}`;
    }

    const eventSource = new EventSource(sseUrl(apiUrl));

    eventSource.addEventListener('log', (e) => {
      const message = JSON.parse(e.data);
      setLogs((prev) => [...prev, message]);
    });

    eventSource.addEventListener('lead', (e) => {
      const lead = JSON.parse(e.data);
      setLeads((prev) => [...prev, lead]);
    });

    eventSource.addEventListener('done', () => {
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

    // Cria um formulário temporário para fazer o POST e acionar o download nativo do navegador
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/api/download-csv';
    form.style.display = 'none';

    // Campo nicho
    const nichoInput = document.createElement('input');
    nichoInput.type = 'hidden';
    nichoInput.name = 'nicho';
    nichoInput.value = nicho;
    form.appendChild(nichoInput);

    // Campo leads
    const leadsInput = document.createElement('input');
    leadsInput.type = 'hidden';
    leadsInput.name = 'leads';
    leadsInput.value = JSON.stringify(leads);
    form.appendChild(leadsInput);

    // Campo _token (autenticação via query param)
    const tokenInput = document.createElement('input');
    tokenInput.type = 'hidden';
    tokenInput.name = '_token';
    tokenInput.value = process.env.APP_SECRET || '';
    form.appendChild(tokenInput);

    document.body.appendChild(form);
    form.submit();
    document.body.removeChild(form);
  };

  const emailsCount = leads.filter(l => l['E-mails']).length;
  const canStart = !isScraping && !!nicho && (mapOpen ? !!pin : !!local);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans p-4 md:p-8">
      <div className="max-w-7xl mx-auto space-y-6">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900 flex items-center gap-3">
              <Activity className="text-indigo-600 h-8 w-8" />
              Lead Extractor Dashboard
              <span className="bg-indigo-100 text-indigo-800 text-xs px-2.5 py-0.5 rounded-full font-medium ml-2">Beta</span>
            </h1>
            <p className="text-slate-500 mt-2">Plataforma Server-Side de extração com proteção de IP integrada.</p>
          </div>

          {/* Tabs de módulos */}
          <div className="flex items-center bg-white border border-slate-200 rounded-xl p-1 shadow-sm">
            <button
              onClick={() => {
                setActiveTab('extraction');
                window.scrollTo({ top: 0, behavior: 'smooth' });
                window.history.replaceState({}, '', '/');
                try { sessionStorage.setItem('ag_active_tab', 'extraction'); } catch {}
              }}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
                activeTab === 'extraction'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Activity className="w-4 h-4" />
              Extração
            </button>
            <button
              onClick={() => {
                setActiveTab('whatsapp');
                window.scrollTo({ top: 0, behavior: 'smooth' });
                window.history.replaceState({}, '', '/whatsapp');
                try { sessionStorage.setItem('ag_active_tab', 'whatsapp'); } catch {}
              }}
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
                activeTab === 'whatsapp'
                  ? 'bg-emerald-600 text-white shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Smartphone className="w-4 h-4" />
              WhatsApp
              {leads.length > 0 && (
                <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                  activeTab === 'whatsapp' ? 'bg-emerald-500 text-white' : 'bg-emerald-100 text-emerald-700'
                }`}>
                  {leads.filter((l: any) => l.Telefone).length}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* WhatsApp Panel — sempre montado, visibilidade via CSS para não perder estado */}
        <div className={activeTab === 'whatsapp' ? 'block' : 'hidden'}>
          <WhatsAppPanel extractedLeads={leads} />
        </div>

        {/* Aba Extração */}
        {activeTab === 'extraction' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">

          {/* Controls & Stats (Left Column) */}
          <div className="lg:col-span-4 space-y-6">

            {/* Control Panel */}
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
              <h2 className="text-lg font-semibold mb-4 text-slate-800">1. Configuração</h2>

              <div className="space-y-4">
                {/* Nicho */}
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Nicho (Alvo)</label>
                  <input
                    type="text"
                    value={nicho}
                    onChange={(e) => setNicho(e.target.value)}
                    disabled={isScraping}
                    placeholder="Ex: Dentistas, Advogados, Padarias..."
                    className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none disabled:opacity-50"
                  />
                </div>

                {/* Localização — campo texto */}
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Localização</label>
                  <input
                    type="text"
                    value={local}
                    onChange={(e) => setLocal(e.target.value)}
                    disabled={isScraping || mapOpen}
                    placeholder="Ex: São Paulo, Curitiba-PR..."
                    className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none disabled:opacity-50"
                  />
                </div>

                {/* Botão Usar Mapa */}
                <button
                  onClick={() => setMapOpen(prev => !prev)}
                  disabled={isScraping}
                  className={`w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg border text-sm font-medium transition-all ${
                    mapOpen
                      ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm'
                      : 'bg-white border-slate-300 text-slate-600 hover:border-indigo-400 hover:text-indigo-600'
                  } disabled:opacity-50`}
                >
                  <MapPin className="w-4 h-4" />
                  {mapOpen ? 'Esconder mapa' : 'Usar mapa — pin + raio'}
                </button>

                {/* Mapa expansível */}
                {mapOpen && (
                  <div className="pt-1">
                    <MapPicker
                      pin={pin}
                      radius={radius}
                      onPinChange={handlePinChange}
                      onRadiusChange={setRadius}
                    />
                    {mapOpen && pin && (
                      <p className="text-xs text-indigo-600 mt-2 font-medium text-center">
                        ✓ Modo mapa ativo — campo "Localização" ignorado
                      </p>
                    )}
                    {mapOpen && !pin && (
                      <p className="text-xs text-amber-600 mt-2 font-medium text-center">
                        ⚠ Coloque um pin no mapa para usar o modo coordenadas
                      </p>
                    )}
                  </div>
                )}

                {/* Máx. Leads */}
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Máx. Leads
                    <span className="ml-2 text-slate-400 font-normal text-xs">(Google Maps retorna até ~120)</span>
                  </label>
                  <input
                    ref={maxLeadsRef}
                    type="number"
                    min={5}
                    max={120}
                    step={5}
                    defaultValue={60}
                    disabled={isScraping}
                    className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none disabled:opacity-50"
                  />
                </div>

                <button
                  onClick={handleStartScraping}
                  disabled={!canStart}
                  className="w-full mt-2 flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-medium py-3 px-4 rounded-lg transition-colors"
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
              <ShieldCheck className={`w-6 h-6 flex-shrink-0 ${isScraping ? 'text-emerald-600 animate-pulse' : 'text-slate-400'}`} />
              <div>
                <h3 className="font-semibold text-sm">Escudo de IP (Proxy Web)</h3>
                <p className="text-xs mt-1 opacity-90">
                  {isScraping
                    ? 'Proteção ativa. Rotacionando endereço de IP para evitar rate-limit e bloqueio.'
                    : 'Em modo de espera. Será ativado automaticamente durante a extração.'}
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
                      log.includes('[Erro]') ? 'text-red-400' :
                      log.includes('[✓]') ? 'text-emerald-400' :
                      log.includes('[Sistema]') ? 'text-indigo-400' : 'text-slate-300'
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
                <h2 className="text-sm font-semibold text-slate-800">
                  Resultados da Extração
                  {leads.length > 0 && (
                    <span className="ml-2 text-slate-400 font-normal">{leads.length} leads</span>
                  )}
                </h2>
                <button
                  onClick={handleDownloadCSV}
                  disabled={leads.length === 0}
                  className="flex items-center gap-2 px-3 py-1.5 bg-white border border-slate-300 text-slate-700 rounded-md hover:bg-slate-50 disabled:opacity-50 text-sm font-medium transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Exportar CSV
                </button>
              </div>

              {leads.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-12 text-slate-400 h-full">
                  <AlertTriangle className="w-12 h-12 mb-3 text-slate-300" />
                  <p className="font-medium">Nenhum lead extraído ainda</p>
                  <p className="text-sm mt-1 text-slate-500">Inicie a extração para ver os resultados aqui.</p>
                </div>
              ) : (
                <div className="overflow-x-auto flex-1">
                  <table className="w-full text-left text-sm table-fixed">
                    <colgroup>
                      <col className="w-[28%]" />
                      <col className="w-[16%]" />
                      <col className="w-[24%]" />
                      <col className="w-[12%]" />
                      <col className="w-[20%]" />
                    </colgroup>
                    <thead className="bg-slate-50/50 text-slate-500 sticky top-0">
                      <tr>
                        <th className="px-4 py-3 font-medium">Nome da Empresa</th>
                        <th className="px-4 py-3 font-medium">Telefone</th>
                        <th className="px-4 py-3 font-medium">Endereço</th>
                        <th className="px-4 py-3 font-medium">Website</th>
                        <th className="px-4 py-3 font-medium">E-mail(s)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {leads.map((lead, i) => (
                        <tr key={i} className="hover:bg-slate-50/50 transition-colors">
                          <td className="px-4 py-3 font-medium text-slate-900">
                            <span className="block truncate" title={lead.Nome}>{lead.Nome}</span>
                          </td>
                          <td className="px-4 py-3 text-slate-600 text-xs">{lead.Telefone || '-'}</td>
                          <td className="px-4 py-3 text-slate-500 text-xs">
                            <span className="block truncate" title={lead['Endereço']}>{lead['Endereço'] || '-'}</span>
                          </td>
                          <td className="px-4 py-3">
                            {lead.Website ? (
                              <a href={lead.Website} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline text-xs">
                                Acessar Site
                              </a>
                            ) : (
                              <span className="text-slate-400 text-xs">-</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {lead['E-mails'] ? (
                              <span className="block truncate px-2 py-1 bg-green-50 text-green-700 rounded text-xs font-medium border border-green-200" title={lead['E-mails']}>
                                {lead['E-mails']}
                              </span>
                            ) : (
                              <span className="text-slate-400 text-xs">-</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

          </div>
        </div>
        )}
      </div>
    </div>
  );
}
