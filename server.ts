import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import dotenv from 'dotenv';
import { whatsappSession } from './whatsapp-session.js';
import { whatsappSender, defaultSendConfig, type SendConfig } from './whatsapp-sender.js';
import { sessionManager } from './whatsapp-session-manager.js';
import { whatsappValidator } from './whatsapp-validator.js';

dotenv.config({ path: '.env.local' });

// ── Helpers de segurança ─────────────────────────────────────────────────────

/**
 * Valida que um ID de sessão só contém caracteres seguros para uso em caminhos de arquivo.
 * Previne ataques de Path Traversal (ex: id = "../../etc/passwd").
 */
function validateSessionId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

/**
 * Sanitiza uma string de texto livre (nicho, local) para uso como argumento de processo.
 * Remove caracteres que poderiam ser usados em command injection.
 * Permite letras (inclusive acentuadas), números, espaços, vírgulas, pontos e hífens.
 */
function sanitizeTextParam(value: string, maxLength = 100): string {
  return value
    .replace(/[^\p{L}\p{N}\s,.'\-]/gu, '') // mantém letras unicode, números, espaços e pontuação básica
    .trim()
    .slice(0, maxLength);
}

/**
 * Valida que um valor é um número de ponto flutuante dentro de um range.
 */
function validateFloat(value: string, min: number, max: number): number | null {
  const n = parseFloat(value);
  if (isNaN(n) || n < min || n > max) return null;
  return n;
}

/**
 * Valida que um valor é um inteiro dentro de um range.
 */
function validateInt(value: string, min: number, max: number): number | null {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < min || n > max) return null;
  return n;
}

// ── Middleware de autenticação ────────────────────────────────────────────────

const APP_SECRET = process.env.APP_SECRET;

/**
 * Middleware que exige o APP_SECRET como Bearer token no header Authorization.
 * Em desenvolvimento (sem APP_SECRET definida), loga um aviso mas NÃO bloqueia.
 * Em produção (NODE_ENV=production), a ausência de APP_SECRET causa falha fatal ao iniciar.
 */
function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Se não há secret configurada, a API fica aberta (útil em dev local)
  if (!APP_SECRET) {
    return next();
  }

  // Aceita token em 3 formas:
  // 1. Header Authorization: Bearer <token>  (fetch normal: JSON/REST)
  // 2. Query param ?_token=<token>            (EventSource SSE — não suporta headers)
  // 3. Body field _token=<token>             (form POST urlencoded — download CSV)
  const authHeader = req.headers['authorization'];
  const tokenFromHeader = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const tokenFromQuery = typeof req.query._token === 'string' ? req.query._token : null;
  const tokenFromBody = typeof req.body?._token === 'string' ? req.body._token : null;
  const token = tokenFromHeader ?? tokenFromQuery ?? tokenFromBody;

  if (!token || token !== APP_SECRET) {
    res.status(401).json({ error: 'Não autorizado. Token inválido ou ausente.' });
    return;
  }

  next();
}

// ── CORS & Origens Permitidas ──────────────────────────────────────────────────

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;

/**
 * Middleware de CORS restrito e seguro.
 * - Se ALLOWED_ORIGIN estiver configurada (ex: https://meudominio.com), apenas ela é aceita.
 * - Em desenvolvimento (ou chamadas locais), aceita localhost / 127.0.0.1.
 * - Em produção sem ALLOWED_ORIGIN definida, aceita apenas a mesma origem (same-origin).
 */
function corsMiddleware(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;

  if (origin) {
    if (ALLOWED_ORIGIN) {
      if (origin === ALLOWED_ORIGIN) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
    } else {
      const isDev = process.env.NODE_ENV !== 'production';
      const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
      if (isDev || isLocalhost) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      }
    }
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}

// ── Rate Limiters (Proteção contra DoS / Abuso) ──────────────────────────────

// Rate limiter geral para todas as rotas da API (/api/*)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 300, // máx 300 requisições por janela por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições enviadas à API. Tente novamente mais tarde.' },
});

// Rate limiter específico para o scraper (cada execução consome CPU, RAM e instâncias Chrome)
const scraperLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutos
  max: 10, // máx 10 tentativas de extração a cada 5 min por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de inicialização de extração. Aguarde alguns minutos.' },
});

// Rate limiter para envio e validação no WhatsApp
const whatsappActionLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 30, // máx 30 ações por minuto por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Limite de ações do WhatsApp atingido. Aguarde um minuto.' },
});

// ── Controle de concorrência do Scraper (máx. 1 processo ativo) ───────────────
let isScrapingActive = false;
let activeScraperProcess: ChildProcess | null = null;

async function startServer() {
  // Em produção, a ausência de APP_SECRET é um erro fatal.
  if (process.env.NODE_ENV === 'production' && !APP_SECRET) {
    console.error('[SEGURANÇA] ERRO FATAL: APP_SECRET não está definida. Defina-a nas variáveis de ambiente antes de iniciar em produção.');
    process.exit(1);
  }
  if (!APP_SECRET) {
    console.warn('[SEGURANÇA] ⚠️  APP_SECRET não definida — API está ABERTA. Configure .env.local com APP_SECRET para proteger os endpoints.');
  }

  const app = express();
  const PORT = parseInt(process.env.PORT || '3000', 10);

  // Confia no proxy reverso (essencial para rate-limiting correto atrás de Nginx/Railway/Render)
  app.set('trust proxy', 1);

  // Headers de segurança HTTP (Helmet)
  app.use(
    helmet({
      contentSecurityPolicy: false, // Mantém compatibilidade com Vite HMR e mapas Leaflet
      crossOriginEmbedderPolicy: false,
    })
  );

  // CORS seguro e restrito
  app.use(corsMiddleware);

  // Endpoint de Health Check (aberto, sem autenticação, para orquestradores/monitoramento)
  app.get('/health', (_req, res) => {
    const sessions = sessionManager.getSessions();
    res.json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      memory: {
        rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      },
      scraper: {
        active: isScrapingActive,
      },
      whatsapp: {
        senderRunning: whatsappSender.isRunning(),
        connectedSessions: sessions.filter(s => s.status === 'authenticated').length,
        totalSessions: sessions.length,
      },
    });
  });

  // Rate Limiting geral para /api/*
  app.use('/api', apiLimiter);

  // Middlewares de parsing de body
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(express.json({ limit: '2mb' }));

  // Endpoint para geração e download de arquivos CSV no servidor
  app.post('/api/download-csv', (req, res) => {
    try {
      const nicho = req.body.nicho || 'leads';
      const leadsRaw = req.body.leads;
      if (!leadsRaw) {
        return res.status(400).send('Nenhum dado enviado');
      }

      const leads = JSON.parse(leadsRaw);
      if (!Array.isArray(leads)) {
        return res.status(400).send('Dados inválidos');
      }

      const headers = ['Nome', 'Telefone', 'Website', 'Endereço', 'E-mails'];
      const csvContent = [
        headers.join(','),
        ...leads.map(lead => [
          `"${(lead.Nome || '').replace(/"/g, '""')}"`,
          `"${(lead.Telefone || '').replace(/"/g, '""')}"`,
          `"${(lead.Website || '').replace(/"/g, '""')}"`,
          `"${(lead['Endereço'] || '').replace(/"/g, '""')}"`,
          `"${(lead['E-mails'] || '').replace(/"/g, '""')}"`
        ].join(','))
      ].join('\n');

      const filename = `leads_${nicho.toLowerCase().replace(/\s/g, '_')}.csv`;
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      // Envia com BOM UTF-8 para garantir que acentuações abram corretamente no Excel
      res.send('\uFEFF' + csvContent);
    } catch (e) {
      console.error('Erro ao gerar CSV:', e);
      res.status(500).send('Erro interno ao gerar arquivo');
    }
  });

  // SSE endpoint — inicia o scraper Python e transmite eventos em tempo real
  app.get('/api/scrape', scraperLimiter, requireAuth, (req, res) => {
    // Limite de concorrência: máximo 1 processo simultâneo para proteger RAM e CPU do servidor
    if (isScrapingActive) {
      res.status(429).json({
        error: 'Já existe uma extração em andamento neste servidor. Aguarde a finalização antes de iniciar outra.'
      });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    function sendEvent(type: string, data: any) {
      if (!res.writableEnded) {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    }

    // ── Sanitização e validação de parâmetros (previne Command Injection) ──────
    const nichoRaw  = (req.query.nicho    as string) || 'Dentistas';
    const localRaw  = (req.query.local    as string) || '';
    const latRaw    = (req.query.lat      as string) || '';
    const lngRaw    = (req.query.lng      as string) || '';
    const radiusRaw = (req.query.radius   as string) || '5';
    const maxRaw    = (req.query.maxLeads as string) || '60';

    // Sanitiza strings de texto livre
    const nicho = sanitizeTextParam(nichoRaw) || 'Dentistas';
    const local = sanitizeTextParam(localRaw);

    // Valida coordenadas como floats dentro de ranges geográficos válidos
    let lat = '';
    let lng = '';
    if (latRaw && lngRaw) {
      const latVal = validateFloat(latRaw, -90, 90);
      const lngVal = validateFloat(lngRaw, -180, 180);
      if (latVal === null || lngVal === null) {
        res.status(400).json({ error: 'Coordenadas lat/lng inválidas.' });
        return;
      }
      lat = String(latVal);
      lng = String(lngVal);
    }

    // Valida raio como float entre 0.5 e 100 km
    const radiusVal = validateFloat(radiusRaw, 0.5, 100) ?? 5;
    const radius = String(radiusVal);

    // Valida maxLeads como inteiro entre 1 e 200
    const maxLeadsVal = validateInt(maxRaw, 1, 200) ?? 60;
    const maxLeads = String(maxLeadsVal);
    // ─────────────────────────────────────────────────────────────────────────

    const modeLabel = lat && lng ? `coordenadas (${parseFloat(lat).toFixed(4)}, ${parseFloat(lng).toFixed(4)}) raio=${radius}km` : `"${local}"`;
    sendEvent('log', `[Init] Iniciando extração: "${nicho}" em ${modeLabel} (máx. ${maxLeads} leads)...`);

    isScrapingActive = true;
    const pyProcess = spawn('python3', ['scraper.py', nicho, local, maxLeads, lat, lng, radius]);
    activeScraperProcess = pyProcess;

    // Timeout de segurança: encerra o scraper caso exceda 30 minutos
    const SCRAPER_TIMEOUT_MS = 30 * 60 * 1000;
    const timeoutId = setTimeout(() => {
      if (pyProcess && !pyProcess.killed) {
        sendEvent('log', '⏰ [Timeout] A extração atingiu o limite de 30 minutos e foi encerrada automaticamente para liberar recursos.');
        sendEvent('error', 'Tempo limite de 30 minutos excedido.');
        pyProcess.kill('SIGTERM');
        isScrapingActive = false;
        activeScraperProcess = null;
      }
    }, SCRAPER_TIMEOUT_MS);

    // Garante que o evento 'done' seja enviado apenas uma vez ao cliente
    let doneSent = false;

    pyProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;

        if (line.startsWith('EVENT:log: ')) {
          sendEvent('log', line.replace('EVENT:log: ', ''));
        } else if (line.startsWith('EVENT:lead: ')) {
          try {
            const lead = JSON.parse(line.replace('EVENT:lead: ', ''));
            sendEvent('lead', lead);
          } catch (e) {
            console.error('Falha ao parsear lead JSON:', e);
          }
        } else if (line.startsWith('EVENT:done: ')) {
          doneSent = true;
          try {
            const result = JSON.parse(line.replace('EVENT:done: ', ''));
            sendEvent('done', result);
          } catch {
            sendEvent('done', { total: 0 });
          }
        } else if (line.startsWith('EVENT:error: ')) {
          sendEvent('error', line.replace('EVENT:error: ', ''));
        } else {
          sendEvent('log', line);
        }
      }
    });

    pyProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      // Filtra avisos comuns do urllib3 que não são erros reais
      if (!msg.includes('NotOpenSSLWarning') && !msg.includes('urllib3')) {
        sendEvent('log', `[Stderr] ${msg}`);
      }
    });

    pyProcess.on('close', (code) => {
      clearTimeout(timeoutId);
      isScrapingActive = false;
      activeScraperProcess = null;
      if (code !== 0) {
        sendEvent('log', `[Erro] O script finalizou com código ${code}. Verifique os logs acima.`);
      }
      // Fallback: só envia 'done' se o script Python não tiver enviado o seu
      if (!doneSent) sendEvent('done', { total: -1 });
      if (!res.writableEnded) res.end();
    });

    pyProcess.on('error', (err) => {
      clearTimeout(timeoutId);
      isScrapingActive = false;
      activeScraperProcess = null;
      sendEvent('error', `Falha ao iniciar processo Python: ${err.message}`);
      if (!res.writableEnded) res.end();
    });

    // Encerra o processo Python se o cliente fechar a conexão
    req.on('close', () => {
      clearTimeout(timeoutId);
      if (pyProcess && !pyProcess.killed) {
        pyProcess.kill();
      }
      isScrapingActive = false;
      activeScraperProcess = null;
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // API WhatsApp
  // ─────────────────────────────────────────────────────────────────────────

  // ── Aplicar autenticação a todos os endpoints da API WhatsApp ──────────────
  // O middleware requireAuth é aplicado aqui, cobrindo todas as rotas /api/whatsapp/* abaixo.
  app.use('/api/whatsapp', requireAuth);
  app.use('/api/download-csv', requireAuth);

  // GET /api/whatsapp/status — retorna status atual da sessão
  app.get('/api/whatsapp/status', (_req, res) => {
    res.json({
      status: sessionManager.getSession('default').getStatus(),
      senderRunning: whatsappSender.isRunning(),
      senderPaused: whatsappSender.isPaused(),
      stats: whatsappSender.getStats(),
      sessions: sessionManager.getSessions(),
    });
  });

  // GET /api/whatsapp/sessions — lista as sessões do WhatsApp
  app.get('/api/whatsapp/sessions', (_req, res) => {
    res.json(sessionManager.getSessions());
  });

  // POST /api/whatsapp/sessions — cria nova sessão
  app.post('/api/whatsapp/sessions', (req, res) => {
    const { name } = req.body;
    const newSession = sessionManager.createSession(name);
    res.json(newSession);
  });

  // DELETE /api/whatsapp/sessions/:id — exclui sessão
  app.delete('/api/whatsapp/sessions/:id', async (req, res) => {
    const { id } = req.params;
    if (!validateSessionId(id)) {
      res.status(400).json({ error: 'ID de sessão inválido.' });
      return;
    }
    const success = await sessionManager.deleteSession(id);
    res.json({ ok: success });
  });

  // POST /api/whatsapp/sessions/:id/logout — desvincula/faz logout da sessão apagando cookies
  app.post('/api/whatsapp/sessions/:id/logout', async (req, res) => {
    const { id } = req.params;
    if (!validateSessionId(id)) {
      res.status(400).json({ error: 'ID de sessão inválido.' });
      return;
    }
    const success = await sessionManager.logoutSession(id);
    res.json({ ok: success });
  });

  // ── Validação de números WhatsApp ────────────────────────────────────────────────

  // POST /api/whatsapp/validate — inicia verificação de números
  app.post('/api/whatsapp/validate', whatsappActionLimiter, (req, res) => {
    const { contacts, sessionId, delayMs } = req.body;
    console.log(`[Validator API] Recebida requisição de validação para ${contacts?.length} contatos. Sessão: ${sessionId}`);
    const MAX_CONTACTS = 5000;
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ error: 'contacts inválido ou vazio' });
    }
    if (contacts.length > MAX_CONTACTS) {
      return res.status(400).json({ error: `Limite máximo de ${MAX_CONTACTS.toLocaleString('pt-BR')} contatos por validação excedido.` });
    }
    whatsappValidator.reset();
    whatsappValidator.start(contacts, sessionId || 'default', delayMs ?? 3000)
      .catch(err => console.error('[Validator] Erro ao executar validação:', err));
    res.json({ ok: true, total: contacts.length });
  });

  // POST /api/whatsapp/validate-stop — para a verificação
  app.post('/api/whatsapp/validate-stop', (_req, res) => {
    console.log('[Validator API] Recebida requisição para PARAR validação.');
    whatsappValidator.stop();
    res.json({ ok: true });
  });

  // GET /api/whatsapp/validate-results — retorna resultados atuais
  app.get('/api/whatsapp/validate-results', (_req, res) => {
    res.json(whatsappValidator.getResults());
  });

  // GET /api/whatsapp/validate-stream — SSE de progresso da verificação
  app.get('/api/whatsapp/validate-stream', (req, res) => {
    console.log('[Validator Stream] Cliente conectado ao stream de validação SSE.');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    function sendV(type: string, data: any) {
      if (!res.writableEnded) {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    }

    // Envia estado atual ao conectar (sempre envia status inicial para abrir a stream)
    const status = whatsappValidator.getStatus();
    sendV('status', { running: status.running, results: status.results });

    const vLog      = (msg: string) => sendV('log', msg);
    const vStarted  = (d: any)      => sendV('started', d);
    const vProgress = (d: any)      => sendV('progress', d);
    const vResult   = (d: any)      => sendV('result', d);
    const vDone     = (d: any)      => sendV('done', d);
    const vStopped  = (d: any)      => sendV('stopped', d);
    const vError    = (e: string)   => sendV('error', e);

    whatsappValidator.on('log', vLog);
    whatsappValidator.on('started', vStarted);
    whatsappValidator.on('progress', vProgress);
    whatsappValidator.on('result', vResult);
    whatsappValidator.on('done', vDone);
    whatsappValidator.on('stopped', vStopped);
    whatsappValidator.on('error', vError);

    req.on('close', () => {
      console.log('[Validator Stream] Cliente desconectou do stream de validação SSE.');
      whatsappValidator.off('log', vLog);
      whatsappValidator.off('started', vStarted);
      whatsappValidator.off('progress', vProgress);
      whatsappValidator.off('result', vResult);
      whatsappValidator.off('done', vDone);
      whatsappValidator.off('stopped', vStopped);
      whatsappValidator.off('error', vError);
    });
  });

  // ───────────────────────────────────────────────────────────────────────


  // POST /api/whatsapp/sessions/:id/start — inicia Puppeteer de sessão específica
  app.post('/api/whatsapp/sessions/:id/start', async (req, res) => {
    const { id } = req.params;
    if (!validateSessionId(id)) {
      res.status(400).json({ error: 'ID de sessão inválido.' });
      return;
    }
    const session = sessionManager.getSession(id);
    if (session.getStatus() === 'authenticated') {
      return res.json({ ok: true, message: 'Sessão já autenticada' });
    }
    session.start().catch(err => console.error(`[WA - ${id}] Erro ao iniciar sessão:`, err));
    res.json({ ok: true, message: 'Sessão iniciando...' });
  });

  // POST /api/whatsapp/start — inicia a sessão padrão (retrocompatibilidade)
  app.post('/api/whatsapp/start', async (_req, res) => {
    const session = sessionManager.getSession('default');
    if (session.getStatus() === 'authenticated') {
      return res.json({ ok: true, message: 'Sessão já autenticada' });
    }
    session.start().catch(err => console.error('[WA - default] Erro ao iniciar sessão:', err));
    res.json({ ok: true, message: 'Sessão iniciando...' });
  });

  // POST /api/whatsapp/sessions/:id/disconnect — desconecta sessão específica
  app.post('/api/whatsapp/sessions/:id/disconnect', async (req, res) => {
    const { id } = req.params;
    if (!validateSessionId(id)) {
      res.status(400).json({ error: 'ID de sessão inválido.' });
      return;
    }
    const session = sessionManager.getSession(id);
    await session.disconnect();
    res.json({ ok: true });
  });

  // POST /api/whatsapp/disconnect — encerra sessão padrão
  app.post('/api/whatsapp/disconnect', async (_req, res) => {
    if (whatsappSender.isRunning()) whatsappSender.stop();
    await sessionManager.getSession('default').disconnect();
    res.json({ ok: true });
  });

  // GET /api/whatsapp/sessions/:id/stream — SSE de screenshots de sessão específica
  app.get('/api/whatsapp/sessions/:id/stream', (req, res) => {
    const { id } = req.params;
    if (!validateSessionId(id)) {
      res.status(400).json({ error: 'ID de sessão inválido.' });
      return;
    }
    const session = sessionManager.getSession(id);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    function send(type: string, data: any) {
      if (!res.writableEnded) {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    }

    send('status', session.getStatus());

    if (session.getStatus() === 'qr_waiting') {
      session.getScreenshot().then(shot => {
        if (shot) send('screenshot', shot);
      }).catch(() => {});
    }

    const onStatus = (status: string) => send('status', status);
    const onScreenshot = (data: string) => send('screenshot', data);
    const onLog = (msg: string) => send('log', msg);

    session.on('status', onStatus);
    session.on('qr_screenshot', onScreenshot);
    session.on('log', onLog);

    req.on('close', () => {
      session.off('status', onStatus);
      session.off('qr_screenshot', onScreenshot);
      session.off('log', onLog);
    });
  });

  // GET /api/whatsapp/session-stream — SSE com screenshots de sessão padrão (retrocompatibilidade)
  app.get('/api/whatsapp/session-stream', (req, res) => {
    const session = sessionManager.getSession('default');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    function send(type: string, data: any) {
      if (!res.writableEnded) {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    }

    send('status', session.getStatus());

    if (session.getStatus() === 'qr_waiting') {
      session.getScreenshot().then(shot => {
        if (shot) send('screenshot', shot);
      }).catch(() => {});
    }

    const onStatus = (status: string) => send('status', status);
    const onScreenshot = (data: string) => send('screenshot', data);
    const onLog = (msg: string) => send('log', msg);

    session.on('status', onStatus);
    session.on('qr_screenshot', onScreenshot);
    session.on('log', onLog);

    req.on('close', () => {
      session.off('status', onStatus);
      session.off('qr_screenshot', onScreenshot);
      session.off('log', onLog);
    });
  });

  // POST /api/whatsapp/contacts — define lista de contatos
  app.post('/api/whatsapp/contacts', (req, res) => {
    const { contacts } = req.body;
    const MAX_CONTACTS = 5000;
    if (!Array.isArray(contacts)) return res.status(400).json({ error: 'contacts deve ser um array' });
    if (contacts.length > MAX_CONTACTS) {
      return res.status(400).json({ error: `Limite máximo de ${MAX_CONTACTS.toLocaleString('pt-BR')} contatos por lote excedido.` });
    }
    whatsappSender.setContacts(contacts);
    res.json({ ok: true, count: contacts.length });
  });

  // POST /api/whatsapp/clear-progress — limpa contatos e progresso salvo em disco
  app.post('/api/whatsapp/clear-progress', (_req, res) => {
    whatsappSender.clearProgress();
    res.json({ ok: true });
  });

  // POST /api/whatsapp/message — define a mensagem
  app.post('/api/whatsapp/message', (req, res) => {
    const { message } = req.body;
    if (typeof message !== 'string') return res.status(400).json({ error: 'message inválida' });
    whatsappSender.setMessage(message);
    res.json({ ok: true });
  });

  // POST /api/whatsapp/config — atualiza configurações de envio
  app.post('/api/whatsapp/config', (req, res) => {
    const config = req.body as Partial<SendConfig>;
    whatsappSender.setConfig(config);
    res.json({ ok: true });
  });

  // POST /api/whatsapp/send — inicia disparo
  app.post('/api/whatsapp/send', whatsappActionLimiter, (_req, res) => {
    whatsappSender.start().catch(err => console.error('[WA Sender] Erro:', err));
    res.json({ ok: true, message: 'Disparo iniciado' });
  });

  // POST /api/whatsapp/pause — pausa disparo
  app.post('/api/whatsapp/pause', (_req, res) => {
    whatsappSender.pause();
    res.json({ ok: true });
  });

  // POST /api/whatsapp/resume — retoma disparo
  app.post('/api/whatsapp/resume', (_req, res) => {
    whatsappSender.resume();
    res.json({ ok: true });
  });

  // POST /api/whatsapp/stop — para disparo
  app.post('/api/whatsapp/stop', (_req, res) => {
    whatsappSender.stop();
    res.json({ ok: true });
  });

  // GET /api/whatsapp/send-stream — SSE com progresso de envio
  app.get('/api/whatsapp/send-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    function send(type: string, data: any) {
      if (!res.writableEnded) {
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    }

    // Envia estado atual imediatamente
    send('stats', whatsappSender.getStats());
    send('contacts', whatsappSender.getContacts());

    const onLog = (msg: string) => send('log', msg);
    const onStats = (stats: any) => send('stats', stats);
    const onContactStatus = (data: any) => send('contact_status', data);
    const onStarted = () => send('started', {});
    const onFinished = (data: any) => send('finished', data);
    const onStopped = () => send('stopped', {});
    const onPaused = () => send('paused', {});
    const onResumed = () => send('resumed', {});
    const onError = (err: string) => send('error', err);
    const onSessionDegraded = (data: any) => send('session_degraded', data);
    const onRotationBroken = (data: any) => send('rotation_broken', data);

    whatsappSender.on('log', onLog);
    whatsappSender.on('stats', onStats);
    whatsappSender.on('contact_status', onContactStatus);
    whatsappSender.on('started', onStarted);
    whatsappSender.on('finished', onFinished);
    whatsappSender.on('stopped', onStopped);
    whatsappSender.on('paused', onPaused);
    whatsappSender.on('resumed', onResumed);
    whatsappSender.on('error', onError);
    whatsappSender.on('session_degraded', onSessionDegraded);
    whatsappSender.on('rotation_broken', onRotationBroken);

    req.on('close', () => {
      whatsappSender.off('log', onLog);
      whatsappSender.off('stats', onStats);
      whatsappSender.off('contact_status', onContactStatus);
      whatsappSender.off('started', onStarted);
      whatsappSender.off('finished', onFinished);
      whatsappSender.off('stopped', onStopped);
      whatsappSender.off('paused', onPaused);
      whatsappSender.off('resumed', onResumed);
      whatsappSender.off('error', onError);
      whatsappSender.off('session_degraded', onSessionDegraded);
      whatsappSender.off('rotation_broken', onRotationBroken);
    });
  });

  // Vite middleware (dev) ou arquivos estáticos (prod)
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, allowedHosts: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  // Limpeza graciosa ao encerrar o servidor
  const shutdown = async () => {
    console.log('[Server] Encerrando servidor e limpando processos...');
    if (activeScraperProcess && !activeScraperProcess.killed) {
      console.log('[Server] Encerrando processo ativo do scraper...');
      activeScraperProcess.kill('SIGTERM');
    }
    if (whatsappSender.isRunning()) whatsappSender.stop();
    await sessionManager.shutdownAll();
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startServer();
