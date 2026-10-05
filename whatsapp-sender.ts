import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { whatsappSession } from './whatsapp-session.js';
import { sessionManager } from './whatsapp-session-manager.js';

/**
 * Oculta os dígitos intermediários do telefone para proteger dados pessoais nos logs do servidor.
 * Exemplo: '5511999998888' -> '5511****8888'
 */
export function maskPhone(phone?: string): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return digits.slice(0, 4) + '****' + digits.slice(-4);
}

export interface Contact {
  id: string;
  phone: string;
  name: string;
  company: string;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  error?: string;
  sentAt?: string;
}

export interface SendConfig {
  delayMinSec: number;
  delayMaxSec: number;
  limitPerHour: number;
  pauseAfterN: number;
  pauseDurationMin: number;
  activeSessionIds?: string[];
  rotationMode?: 'message' | 'batch';
  rotationBatchSize?: number;
  /** Falhas consecutivas antes de remover a conta da rotação (default: 3) */
  maxConsecutiveFailsPerSession?: number;
  /** Se true, para o disparo se o pool de contas ativas ficar abaixo do total inicial (default: true) */
  stopIfRotationBroken?: boolean;
}

export const defaultSendConfig: SendConfig = {
  delayMinSec: 20,
  delayMaxSec: 60,
  limitPerHour: 20,
  pauseAfterN: 10,
  pauseDurationMin: 5,
  activeSessionIds: ['default'],
  rotationMode: 'message',
  rotationBatchSize: 5,
  maxConsecutiveFailsPerSession: 3,
  stopIfRotationBroken: true,
};

export class WhatsAppSender extends EventEmitter {
  private contacts: Contact[] = [];
  private message: string = '';
  private config: SendConfig = { ...defaultSendConfig };
  private running: boolean = false;
  private paused: boolean = false;
  private sentThisHour: number = 0;
  private hourStartedAt: number = Date.now();
  private progressFile = path.join(process.cwd(), 'whatsapp-dispatch-progress.json');

  constructor() {
    super();
    this.loadProgress();
  }

  private saveProgress(): void {
    try {
      const data = {
        message: this.message,
        config: this.config,
        contacts: this.contacts,
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(this.progressFile, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      console.error('[WhatsAppSender] Falha ao salvar progresso em disco:', e);
    }
  }

  private loadProgress(): void {
    try {
      if (fs.existsSync(this.progressFile)) {
        const raw = fs.readFileSync(this.progressFile, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.contacts)) {
          this.contacts = data.contacts;
        }
        if (typeof data.message === 'string') {
          this.message = data.message;
        }
        if (data.config && typeof data.config === 'object') {
          this.config = { ...this.config, ...data.config };
        }
        console.log(`[WhatsAppSender] Progresso anterior restaurado: ${this.contacts.length} contatos recuperados.`);
      }
    } catch (e) {
      console.error('[WhatsAppSender] Falha ao carregar progresso anterior:', e);
    }
  }

  clearProgress(): void {
    try {
      if (fs.existsSync(this.progressFile)) {
        fs.unlinkSync(this.progressFile);
      }
    } catch (e) {
      console.error('[WhatsAppSender] Falha ao remover arquivo de progresso:', e);
    }
    this.contacts = [];
    this.message = '';
    this.emit('contacts_updated', this.contacts);
  }

  setContacts(contacts: Omit<Contact, 'status' | 'error' | 'sentAt'>[]) {
    this.contacts = contacts.map(c => ({ ...c, status: 'pending' as const }));
    this.saveProgress();
    this.emit('contacts_updated', this.contacts);
  }

  setMessage(message: string) {
    this.message = message;
    this.saveProgress();
  }

  setConfig(config: Partial<SendConfig>) {
    this.config = { ...this.config, ...config };
    this.saveProgress();
  }

  getContacts(): Contact[] {
    return this.contacts;
  }

  getStats() {
    const sent = this.contacts.filter(c => c.status === 'sent').length;
    const failed = this.contacts.filter(c => c.status === 'failed').length;
    const pending = this.contacts.filter(c => c.status === 'pending').length;
    return { sent, failed, pending, total: this.contacts.length };
  }

  async start(): Promise<void> {
    if (this.running) {
      this.emit('log', '⚠️ Disparo já está em andamento.');
      return;
    }

    const selectedIds = this.config.activeSessionIds || ['default'];
    const initialSessions = selectedIds
      .map(id => sessionManager.getSession(id))
      .filter(s => s && s.isReady());

    if (initialSessions.length === 0) {
      this.emit('log', '❌ Nenhuma conta conectada e selecionada para o disparo. Faça login primeiro.');
      this.emit('error', 'Sem sessões autenticadas');
      return;
    }

    if (!this.message.trim()) {
      this.emit('log', '❌ Mensagem não pode estar vazia.');
      this.emit('error', 'Mensagem vazia');
      return;
    }

    const pending = this.contacts.filter(c => c.status === 'pending');
    if (pending.length === 0) {
      this.emit('log', '⚠️ Nenhum contato pendente na fila.');
      return;
    }

    this.running = true;
    this.paused = false;
    this.sentThisHour = 0;
    this.hourStartedAt = Date.now();
    this.emit('started');
    this.emit('log', `🚀 Iniciando disparo para ${pending.length} contatos usando ${initialSessions.length} conta(s)...`);
    this.emit('log', `⚙️ Configuração: ${this.config.delayMinSec}–${this.config.delayMaxSec}s de intervalo | limite de ${this.config.limitPerHour}/hora | rotação: ${this.config.rotationMode === 'message' ? 'por mensagem' : 'por lote de ' + this.config.rotationBatchSize}`);

    // ── Pool mutável de sessões (Fase 1: Rotação Inteligente) ────────────────
    const initialPoolSize = initialSessions.length;
    let activePool = [...initialSessions];
    const consecutiveFails = new Map<string, number>(); // sessionId → falhas consecutivas
    const maxFails = this.config.maxConsecutiveFailsPerSession ?? 3;
    const stopIfBroken = this.config.stopIfRotationBroken !== false;
    let rotationBroken = false;
    // ────────────────────────────────────────────────────────────────────────

    let sentInBatch = 0;
    let currentSessionIndex = 0;
    let sentInCurrentRotationBatch = 0;

    for (let i = 0; i < this.contacts.length; i++) {
      if (!this.running) break;

      const contact = this.contacts[i];
      if (contact.status !== 'pending') continue;

      // Aguarda se pausado
      while (this.paused && this.running) {
        await new Promise(r => setTimeout(r, 1000));
      }
      if (!this.running) break;

      // Controle de limite por hora
      if (this.sentThisHour >= this.config.limitPerHour) {
        const elapsed = Date.now() - this.hourStartedAt;
        const remaining = 3600000 - elapsed;
        if (remaining > 0) {
          const waitMin = Math.ceil(remaining / 60000);
          this.emit('log', `⏸ Limite de ${this.config.limitPerHour}/hora atingido. Aguardando ${waitMin} min...`);
          await this.sleepInterruptible(remaining);
          if (!this.running) break;
        }
        this.sentThisHour = 0;
        this.hourStartedAt = Date.now();
      }

      // Pausa automática após N mensagens
      if (sentInBatch > 0 && sentInBatch % this.config.pauseAfterN === 0) {
        const pauseMs = this.config.pauseDurationMin * 60 * 1000;
        this.emit('log', `☕ Pausa automática de ${this.config.pauseDurationMin} min após ${sentInBatch} envios...`);
        await this.sleepInterruptible(pauseMs);
        if (!this.running) break;
      }

      if (activePool.length === 0) break;

      // Define a sessão de rotação ativa para esta mensagem
      const currentSession = activePool[currentSessionIndex % activePool.length];

      // Personaliza a mensagem
      const personalizedMsg = this.message
        .replace(/\{nome\}/gi, contact.name || '')
        .replace(/\{empresa\}/gi, contact.company || '')
        .replace(/\{telefone\}/gi, contact.phone || '');

      const contactDisplay = contact.name ? `${contact.name} (${maskPhone(contact.phone)})` : maskPhone(contact.phone);
      this.emit('log', `📤 [${i + 1}/${this.contacts.length}] Enviando via [${currentSession.name}] para ${contactDisplay}...`);
      this.emit('contact_status', { id: contact.id, status: 'sending' });

      let sendSuccess = false;
      try {
        await currentSession.sendMessage(contact.phone, personalizedMsg);
        sendSuccess = true;
        contact.status = 'sent';
        contact.sentAt = new Date().toISOString();
        this.sentThisHour++;
        sentInBatch++;
        sentInCurrentRotationBatch++;
        this.saveProgress();
        this.emit('contact_status', { id: contact.id, status: 'sent', sentAt: contact.sentAt });
        this.emit('log', `✅ [${currentSession.name}] Enviado para ${contactDisplay}`);
        this.emit('stats', this.getStats());
        // Sucesso → zera contador de falhas consecutivas desta conta
        consecutiveFails.set(currentSession.id, 0);
      } catch (err: any) {
        contact.status = 'failed';
        contact.error = err.message;
        this.saveProgress();
        this.emit('contact_status', { id: contact.id, status: 'failed', error: err.message });
        this.emit('log', `❌ [${currentSession.name}] Falha em ${contactDisplay}: ${err.message}`);
        this.emit('stats', this.getStats());
        sentInCurrentRotationBatch++;

        // ── Lógica de degradação de conta (Fase 1) ──────────────────────────
        const fails = (consecutiveFails.get(currentSession.id) || 0) + 1;
        consecutiveFails.set(currentSession.id, fails);

        if (fails >= maxFails) {
          // Remove a conta do pool ativo
          activePool = activePool.filter(s => s.id !== currentSession.id);
          consecutiveFails.delete(currentSession.id);

          this.emit('log', `⚠️ Conta [${currentSession.name}] removida da rotação após ${fails} falhas consecutivas.`);
          this.emit('session_degraded', {
            sessionId: currentSession.id,
            sessionName: currentSession.name,
            failCount: fails,
          });

          // Ajusta índice para não sair dos bounds do novo pool
          if (activePool.length > 0) {
            currentSessionIndex = currentSessionIndex % activePool.length;
          }

          // Verifica se deve parar o disparo
          if (activePool.length === 0 || (stopIfBroken && activePool.length < initialPoolSize)) {
            rotationBroken = true;
            this.running = false;
            this.emit('rotation_broken', {
              degradedSession: currentSession.name,
              remainingCount: activePool.length,
              minRequired: initialPoolSize,
            });
            this.emit('log',
              activePool.length === 0
                ? `🚨 Disparo interrompido: todas as contas falharam. Nenhuma conta disponível no pool.`
                : `🚨 Disparo interrompido: rotação comprometida. Conta [${currentSession.name}] falhou ${fails}x. Verifique-a e retome o disparo.`
            );
            break;
          }

          // Rotação já foi tratada ao remover do pool — pula para o próximo contato
          const isLastContact = this.contacts.slice(i + 1).every(c => c.status !== 'pending');
          if (!isLastContact && this.running) {
            const delayMs = (this.config.delayMinSec + Math.random() * (this.config.delayMaxSec - this.config.delayMinSec)) * 1000;
            this.emit('log', `⏳ Aguardando ${(delayMs / 1000).toFixed(0)}s...`);
            await this.sleepInterruptible(delayMs);
          }
          continue;
        }
        // ────────────────────────────────────────────────────────────────────
      }

      // Lógica de rotação normal (só se pool tiver mais de 1)
      if (activePool.length > 1 && this.running) {
        let shouldRotate = false;
        const rotationMode = this.config.rotationMode || 'message';
        const batchSize = this.config.rotationBatchSize || 5;

        if (rotationMode === 'message') {
          shouldRotate = true;
        } else if (rotationMode === 'batch' && sentInCurrentRotationBatch >= batchSize) {
          shouldRotate = true;
        }

        if (shouldRotate) {
          currentSessionIndex = (currentSessionIndex + 1) % activePool.length;
          sentInCurrentRotationBatch = 0;
          const nextSession = activePool[currentSessionIndex];
          this.emit('log', `🔄 Rotacionando canal de disparo para: [${nextSession.name}]`);
        }
      }

      // Delay aleatório antes do próximo (exceto no último)
      const isLast = this.contacts.slice(i + 1).every(c => c.status !== 'pending');
      if (!isLast && this.running) {
        const delayMs =
          (this.config.delayMinSec +
            Math.random() * (this.config.delayMaxSec - this.config.delayMinSec)) *
          1000;
        this.emit('log', `⏳ Aguardando ${(delayMs / 1000).toFixed(0)}s...`);
        await this.sleepInterruptible(delayMs);
      }
    }

    if (!rotationBroken && this.running) {
      this.running = false;
      const stats = this.getStats();
      this.emit('finished', stats);
      this.emit('log', `🏁 Disparo finalizado! ✅ ${stats.sent} enviados | ❌ ${stats.failed} falhas`);
      this.emit('stats', stats);
    } else if (rotationBroken) {
      // Já emitiu rotation_broken acima; emite stats para atualizar UI
      this.running = false;
      this.emit('stats', this.getStats());
    }
  }

  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.emit('paused');
    this.emit('log', '⏸ Disparo pausado pelo usuário.');
  }

  resume(): void {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this.emit('resumed');
    this.emit('log', '▶️ Disparo retomado.');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.paused = false;
    this.emit('stopped');
    this.emit('log', '🛑 Disparo interrompido pelo usuário.');
    this.emit('stats', this.getStats());
  }

  resetContacts(): void {
    this.contacts = this.contacts.map(c => ({ ...c, status: 'pending', error: undefined, sentAt: undefined }));
    this.saveProgress();
    this.emit('contacts_updated', this.contacts);
  }

  isRunning(): boolean { return this.running; }
  isPaused(): boolean { return this.paused; }

  /** Aguarda o tempo dado, mas pode ser interrompido se `running` mudar para false */
  private sleepInterruptible(ms: number): Promise<void> {
    return new Promise(resolve => {
      const step = 500;
      let elapsed = 0;
      const interval = setInterval(() => {
        elapsed += step;
        if (!this.running || elapsed >= ms) {
          clearInterval(interval);
          resolve();
        }
      }, step);
    });
  }
}

export const whatsappSender = new WhatsAppSender();
