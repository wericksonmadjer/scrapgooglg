import puppeteer, { Browser, Page } from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { EventEmitter } from 'events';

export type SessionStatus = 'idle' | 'starting' | 'qr_waiting' | 'authenticated' | 'disconnected' | 'error';

export class WhatsAppSession extends EventEmitter {
  private browser: Browser | null = null;
  private page: Page | null = null;
  public status: SessionStatus = 'idle';
  private qrInterval: ReturnType<typeof setInterval> | null = null;
  private authWatchInterval: ReturnType<typeof setInterval> | null = null;
  private sessionDir: string;
  public id: string;
  public name: string;

  constructor(id: string = 'default', name: string = 'Conta Principal') {
    super();
    this.id = id;
    this.name = name;
    this.sessionDir = id === 'default'
      ? path.join(process.cwd(), 'whatsapp-session-data')
      : path.join(process.cwd(), 'whatsapp-session-data', id);
      
    // Evita que erros não tratados derrubem o processo (ERR_UNHANDLED_ERROR)
    this.on('error', (err) => {
      console.error(`[WA - ${name}] Erro interno da sessão:`, err);
    });
  }

  async start(): Promise<void> {
    if (this.status === 'starting' || this.status === 'authenticated') {
      this.emit('log', 'Sessão já está ativa ou iniciando.');
      return;
    }

    this.status = 'starting';
    this.emit('status', this.status);
    this.emit('log', '🚀 Iniciando navegador Chrome...');

    try {
      // ── Limpa lock files do Chromium para evitar "browser already running" ─────────
      // Ocorre quando o servidor reinicia sem fechar o browser corretamente.
      const lockFiles = [
        'SingletonLock',
        'SingletonCookie',
        'SingletonSocket',
      ];
      for (const lf of lockFiles) {
        const lockPath = path.join(this.sessionDir, lf);
        try {
          if (fs.existsSync(lockPath)) {
            fs.unlinkSync(lockPath);
            this.emit('log', `🧹 Lock removido: ${lf}`);
          }
        } catch { /* ignora erros de permissão */ }
      }

      // Mata processos orãos do Chrome que possam estar usando o mesmo userDataDir
      try {
        execSync(`pkill -f "${this.sessionDir}" 2>/dev/null || true`, { stdio: 'ignore' });
        await new Promise(r => setTimeout(r, 500));
      } catch { /* ignora — o comando pode não encontrar processos */ }

      this.browser = await puppeteer.launch({
        headless: true,
        userDataDir: this.sessionDir,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--window-size=1280,800',
        ],
      });

      this.page = await this.browser.newPage();
      await this.page.setViewport({ width: 1280, height: 800 });
      await this.page.setUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      this.emit('log', '🌐 Abrindo WhatsApp Web...');
      await this.page.goto('https://web.whatsapp.com', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });

      // Aguarda um pouco para a página carregar
      await new Promise(r => setTimeout(r, 3000));

      await this.detectState();
    } catch (err: any) {
      this.status = 'error';
      this.emit('status', this.status);
      this.emit('log', `❌ Erro ao iniciar sessão: ${err.message}`);
      this.emit('error', err.message);
    }
  }

  private async detectState(): Promise<void> {
    if (!this.page) return;

    try {
      // Aguarda aparecer QR ou tela principal (até 30s)
      const result = await Promise.race([
        this.page.waitForSelector(
          '[data-testid="intro-md-beta-logo-dark"], [data-ref], canvas, .qr-container',
          { timeout: 20000 }
        ).then(() => 'qr').catch(() => null),
        this.page.waitForSelector(
          '[data-testid="chat-list"], [data-testid="chatlist-header"], #main',
          { timeout: 20000 }
        ).then(() => 'auth').catch(() => null),
      ]);

      if (result === 'auth') {
        this.setAuthenticated();
      } else {
        // Verifica diretamente
        const isAuth = await this.page.$('[data-testid="chat-list"], #main');
        if (isAuth) {
          this.setAuthenticated();
        } else {
          this.setQRWaiting();
        }
      }
    } catch {
      // Em caso de dúvida, assume QR waiting e inicia captura
      this.setQRWaiting();
    }
  }

  private setAuthenticated(): void {
    this.stopQRCapture();
    this.stopAuthWatch();
    this.status = 'authenticated';
    this.emit('status', 'authenticated');
    this.emit('log', '✅ WhatsApp autenticado com sucesso!');
  }

  private setQRWaiting(): void {
    this.status = 'qr_waiting';
    this.emit('status', 'qr_waiting');
    this.emit('log', '📱 Aguardando leitura do QR Code...');
    this.startQRCapture();
    this.startAuthWatch();
  }

  private startQRCapture(): void {
    this.stopQRCapture();
    this.qrInterval = setInterval(async () => {
      if (!this.page || this.status !== 'qr_waiting') return;
      try {
        const screenshot = await this.page.screenshot({ encoding: 'base64' });
        this.emit('qr_screenshot', screenshot);
      } catch {
        // ignora erros de screenshot
      }
    }, 1500);
  }

  private stopQRCapture(): void {
    if (this.qrInterval) {
      clearInterval(this.qrInterval);
      this.qrInterval = null;
    }
  }

  private startAuthWatch(): void {
    this.stopAuthWatch();
    this.authWatchInterval = setInterval(async () => {
      if (!this.page || this.status === 'authenticated') {
        this.stopAuthWatch();
        return;
      }
      try {
        const isAuth = await this.page.$('[data-testid="chat-list"], [data-testid="chatlist-header"], #main');
        if (isAuth) {
          this.setAuthenticated();
        }
      } catch {
        // ignora
      }
    }, 2000);
  }

  private stopAuthWatch(): void {
    if (this.authWatchInterval) {
      clearInterval(this.authWatchInterval);
      this.authWatchInterval = null;
    }
  }

  private async tryNavigateAndFindInput(cleanPhone: string): Promise<{ success: boolean; inputSelector?: string }> {
    if (!this.page) throw new Error('Navegador não iniciado');
    
    const url = `https://web.whatsapp.com/send?phone=${cleanPhone}&text=&type=phone_number&app_absent=0`;
    this.emit('log', `🔗 Navegando para o chat do número: ${cleanPhone}...`);

    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err: any) {
      this.emit('log', `⚠️ Erro ao carregar URL do chat para ${cleanPhone}: ${err.message}`);
      return { success: false };
    }

    // Seletores possíveis para a caixa de texto do WhatsApp Web
    const inputSelectors = [
      'div[contenteditable="true"][data-tab="10"]',
      'div[contenteditable="true"][data-lexical-editor="true"]',
      'footer div[contenteditable="true"]',
      '[data-testid="compose-box-input"]',
    ];

    // Polling rápido para detectar input de chat ou popup de erro por até 12 segundos
    const maxWaitMs = 12000;
    const intervalMs = 500;
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      if (!this.page) return { success: false };

      // 1. Verifica se algum dos seletores de input já existe e está visível
      for (const selector of inputSelectors) {
        const inputElement = await this.page.$(selector);
        if (inputElement) {
          const isVisible = await this.page.evaluate((sel) => {
            const el = document.querySelector(sel) as HTMLElement | null;
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          }, selector);

          if (isVisible) {
            return { success: true, inputSelector: selector };
          }
        }
      }

      // 2. Verifica se apareceu popup de erro ("telefone inválido" etc)
      const hasErrorPopup = await this.page.evaluate(() => {
        const dialog = document.querySelector('div[role="dialog"]');
        if (dialog) {
          const text = (dialog as HTMLElement).innerText || '';
          const lowerText = text.toLowerCase();
          return (
            lowerText.includes('inválido') ||
            lowerText.includes('invalid') ||
            lowerText.includes('não existe') ||
            lowerText.includes('não está no whatsapp') ||
            lowerText.includes('isn\'t on whatsapp') ||
            lowerText.includes('is not on whatsapp')
          );
        }
        
        const okButton = document.querySelector('[data-testid="popup-controls-ok"]');
        if (okButton) return true;

        const bodyText = document.body.innerText.toLowerCase();
        return (
          bodyText.includes('o número de telefone compartilhado por meio de link é inválido') ||
          bodyText.includes('phone number shared via url is invalid') ||
          bodyText.includes('telefone compartilhado por meio de link é inválido')
        );
      });

      if (hasErrorPopup) {
        this.emit('log', `⚠️ Popup de número inválido detectado para ${cleanPhone}.`);
        
        // Tenta fechar o popup para não obstruir próximas tentativas
        try {
          await this.page.evaluate(() => {
            const okButton = document.querySelector('[data-testid="popup-controls-ok"]') as HTMLElement | null;
            if (okButton) {
              okButton.click();
              return;
            }
            const dialog = document.querySelector('div[role="dialog"]');
            if (dialog) {
              const buttons = dialog.querySelectorAll('button');
              if (buttons.length > 0) {
                (buttons[0] as HTMLElement).click();
              }
            }
          });
          await new Promise(r => setTimeout(r, 1000));
        } catch { /* ignora */ }
        
        return { success: false };
      }

      await new Promise(r => setTimeout(r, intervalMs));
    }

    this.emit('log', `⌛ Timeout aguardando chat de ${cleanPhone}.`);
    return { success: false };
  }

  async sendMessage(phone: string, message: string): Promise<void> {
    if (!this.page) throw new Error('Navegador não iniciado');
    if (this.status !== 'authenticated') throw new Error('Sessão não autenticada');

    // Normaliza número inicial
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone) throw new Error(`Número inválido: ${phone}`);

    let navResult = await this.tryNavigateAndFindInput(cleanPhone);
    let selectedPhone = cleanPhone;

    // Se falhou e for número brasileiro, tenta o fallback com nono dígito adicionado ou removido
    if (!navResult.success && cleanPhone.startsWith('55')) {
      const alternativePhone = getAlternativeBrazilianPhone(cleanPhone);
      if (alternativePhone) {
        this.emit('log', `🔄 Tentativa inicial com ${cleanPhone} falhou. Tentando formato alternativo: ${alternativePhone}...`);
        navResult = await this.tryNavigateAndFindInput(alternativePhone);
        if (navResult.success) {
          selectedPhone = alternativePhone;
        }
      }
    }

    if (!navResult.success || !navResult.inputSelector) {
      throw new Error('Caixa de mensagem não encontrada. Contato pode não existir no WhatsApp.');
    }

    const selector = navResult.inputSelector;
    this.emit('log', `✍️ Enviando mensagem para ${selectedPhone}...`);

    // ── Injeta texto completo com execCommand ──────────────────────────
    const lines = message.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.length > 0) {
        const ok = await this.page.evaluate((sel: string, text: string) => {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (!el) return false;
          el.focus();
          return document.execCommand('insertText', false, text);
        }, selector, line);

        // Se execCommand falhar, usa keyboard.type
        if (!ok) {
          await this.page.click(selector);
          await this.page.keyboard.type(line, { delay: 10 });
        }
      }

      // Insere quebra de linha com Shift+Enter (não dispara envio)
      if (i < lines.length - 1) {
        await this.page.keyboard.down('Shift');
        await this.page.keyboard.press('Enter');
        await this.page.keyboard.up('Shift');
        await new Promise(r => setTimeout(r, 100));
      }
    }

    // Pausa humana antes de enviar (500–900ms)
    await new Promise(r => setTimeout(r, 500 + Math.random() * 400));
    await this.page.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 2000));
  }

  /**
   * Verifica se um número existe no WhatsApp sem enviar mensagem.
   * Testa o formato original e o alternativo (9º dígito) para números brasileiros.
   */
  async checkPhoneExists(phone: string): Promise<{ exists: boolean; usedPhone: string | null }> {
    if (!this.page) throw new Error('Navegador não iniciado');
    if (this.status !== 'authenticated') throw new Error('Sessão não autenticada');

    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone) return { exists: false, usedPhone: null };

    let result = await this.tryNavigateAndFindInput(cleanPhone);

    if (!result.success && cleanPhone.startsWith('55')) {
      const alt = getAlternativeBrazilianPhone(cleanPhone);
      if (alt) {
        result = await this.tryNavigateAndFindInput(alt);
        if (result.success) {
          return { exists: true, usedPhone: alt };
        }
      }
    }

    return { exists: result.success, usedPhone: result.success ? cleanPhone : null };
  }

  async getScreenshot(): Promise<string> {
    if (!this.page) return '';
    try {
      return (await this.page.screenshot({ encoding: 'base64' })) as string;
    } catch {
      return '';
    }
  }

  async disconnect(): Promise<void> {
    this.emit('log', '🔌 Desconectando sessão...');
    this.stopQRCapture();
    this.stopAuthWatch();
    if (this.browser) {
      try { await this.browser.close(); } catch { /* ignora */ }
      this.browser = null;
      this.page = null;
    }
    this.status = 'idle';
    this.emit('status', 'idle');
    this.emit('log', '✅ Sessão encerrada.');
  }

  getStatus(): SessionStatus {
    return this.status;
  }

  isReady(): boolean {
    return this.status === 'authenticated';
  }

  getPage(): Page | null {
    return this.page;
  }
}

/**
 * Normaliza o número de telefone para o formato do WhatsApp (apenas dígitos, com código de país).
 * Adiciona +55 (Brasil) por padrão se não houver código de país.
 */
export function normalizePhone(phone: string): string {
  // Remove tudo que não é dígito
  let digits = phone.replace(/\D/g, '');

  // Se vazio, inválido
  if (!digits) return '';

  // Se começa com 0, remove
  if (digits.startsWith('0')) digits = digits.slice(1);

  // Se tem 10 ou 11 dígitos, assume Brasil e adiciona 55
  if (digits.length === 10 || digits.length === 11) {
    digits = '55' + digits;
  }

  // Se tem 12 ou 13 dígitos, assume que já tem código de país
  return digits.length >= 12 ? digits : '';
}

/**
 * Obtém o formato de número alternativo (com ou sem o 9º dígito) para celulares do Brasil.
 */
export function getAlternativeBrazilianPhone(phone: string): string | null {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10 || digits.length === 11) {
    digits = '55' + digits;
  }

  if (!digits.startsWith('55')) return null;

  // Caso 1: Tem 13 dígitos (55 + DDD de 2 dígitos + 9 + 8 dígitos). Exemplo: 5527988640373
  // Retorna sem o 9: 552788640373 (12 dígitos)
  if (digits.length === 13) {
    const ddd = digits.slice(2, 4);
    const ninthDigit = digits.slice(4, 5);
    const rest = digits.slice(5);
    if (ninthDigit === '9') {
      return '55' + ddd + rest;
    }
  }

  // Caso 2: Tem 12 dígitos (55 + DDD de 2 dígitos + 8 dígitos). Exemplo: 552788640373
  // Retorna com o 9: 5527988640373 (13 dígitos)
  if (digits.length === 12) {
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    return '55' + ddd + '9' + rest;
  }

  return null;
}

// Singleton da sessão
export const whatsappSession = new WhatsAppSession();
