import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { spawn } from 'child_process';

async function startServer() {
  const app = express();
  const PORT = 3000;

  // SSE endpoint to simulate scraping
  app.get('/api/scrape', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const nicho = req.query.nicho as string || 'Dentistas';
    const local = req.query.local as string || 'São Paulo';
    
    function sendEvent(type: string, data: any) {
      if (!res.writableEnded) {
        res.write(`event: ${type}\ndata: ${typeof data === 'string' ? JSON.stringify(data) : JSON.stringify(data)}\n\n`);
      }
    }

    sendEvent('log', `[Init] Iniciando script Python em background para "${nicho}" em "${local}"...`);
    
    const pyProcess = spawn('python3', ['scraper.py', nicho, local]);

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
            console.error('Failed to parse lead json:', e);
          }
        } else if (line.startsWith('EVENT:done: ')) {
          try {
            const result = JSON.parse(line.replace('EVENT:done: ', ''));
            sendEvent('done', result);
          } catch (e) {
            sendEvent('done', { total: 0 });
          }
        } else if (line.startsWith('EVENT:error: ')) {
          sendEvent('log', line.replace('EVENT:error: ', ''));
        } else {
          // send general stdout as log
          sendEvent('log', line);
        }
      }
    });

    pyProcess.stderr.on('data', (data) => {
      sendEvent('log', `[Stderr] ${data.toString()}`);
    });

    pyProcess.on('close', (code) => {
      if (code !== 0) {
        sendEvent('log', `[Aviso] Script finalizado com código ${code}. Verifique avisos anteriores.`);
        // Fallback simulate to show something to the user if exact deps failed
        sendEvent('log', `[Fallback] Como o container não suporta DrissionPage/Chrome, listando formato da API:`);
        sendEvent('lead', { 
          Nome: `[Demo] ${nicho} Exemplo`, 
          Telefone: '(11) 9999-9999', 
          Website: `https://mock.com`, 
          'E-mails': `contato@mock.com` 
        });
      }
      sendEvent('done', { total: -1 });
      if (!res.writableEnded) res.end();
    });

    req.on('close', () => {
      pyProcess.kill();
    });
  });

  // Vite middleware
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
