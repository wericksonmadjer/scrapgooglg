import { EventEmitter } from 'events';
import { sessionManager } from './whatsapp-session-manager.js';
import { normalizePhone } from './whatsapp-session.js';
import { maskPhone } from './whatsapp-sender.js';

export type ValidationStatus = 'pending' | 'checking' | 'valid' | 'invalid' | 'unknown';

export interface ValidationResult {
  id: string;
  phone: string;
  name: string;
  company: string;
  status: ValidationStatus;
  usedPhone?: string;
  checkedAt?: string;
}

export class WhatsAppValidator extends EventEmitter {
  private running = false;
  private done = false;
  private results: ValidationResult[] = [];

  async start(contacts: any[], sessionId: string, delayMs = 3000): Promise<void> {
    if (this.running) {
      this.emit('log', '⚠️ Verificação já está em andamento.');
      return;
    }

    const session = sessionManager.getSession(sessionId);
    if (!session || !session.isReady()) {
      this.emit('log', '❌ Conta não autenticada. Faça login primeiro.');
      this.emit('error', 'Sessão não autenticada');
      return;
    }

    this.running = true;
    this.done = false;
    this.results = contacts.map(c => ({
      id: c.id,
      phone: c.phone,
      name: c.name || '',
      company: c.company || '',
      status: 'pending' as ValidationStatus,
    }));

    const total = this.results.length;
    this.emit('started', { total });
    this.emit('log', `🔍 Iniciando verificação de ${total} números...`);
    this.emit('log', `⏱️ Intervalo de ${(delayMs / 1000).toFixed(0)}s entre verificações | Tempo estimado: ~${Math.ceil((total * delayMs) / 60000)} min`);

    for (let i = 0; i < this.results.length; i++) {
      if (!this.running) break;

      const r = this.results[i];
      const targetDisplay = r.name ? `${r.name} (${maskPhone(r.phone)})` : maskPhone(r.phone);
      r.status = 'checking';
      this.emit('progress', { index: i, total, result: { ...r } });
      this.emit('log', `🔎 [${i + 1}/${total}] Verificando ${targetDisplay}...`);

      // Verifica se o número é válido antes de tentar
      const cleanPhone = normalizePhone(r.phone);
      if (!cleanPhone) {
        r.status = 'invalid';
        r.checkedAt = new Date().toISOString();
        this.emit('log', `❌ [${i + 1}/${total}] Número inválido ou mal formatado: ${maskPhone(r.phone)}`);
        this.emit('result', { index: i, result: { ...r } });
        continue;
      }

      try {
        const checkResult = await session.checkPhoneExists(r.phone);
        r.status = checkResult.exists ? 'valid' : 'invalid';
        r.usedPhone = checkResult.usedPhone || undefined;
        r.checkedAt = new Date().toISOString();

        if (checkResult.exists) {
          this.emit('log', `✅ [${i + 1}/${total}] ${targetDisplay} — encontrado no WhatsApp`);
        } else {
          this.emit('log', `❌ [${i + 1}/${total}] ${targetDisplay} — não encontrado no WhatsApp`);
        }
      } catch (err: any) {
        r.status = 'unknown';
        r.checkedAt = new Date().toISOString();
        this.emit('log', `⚠️ [${i + 1}/${total}] ${targetDisplay} — erro ao verificar: ${err.message}`);
      }

      this.emit('result', { index: i, result: { ...r } });

      // Delay entre verificações (exceto na última)
      if (i < this.results.length - 1 && this.running) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    if (this.running) {
      this.running = false;
      this.done = true;
      const valid = this.results.filter(r => r.status === 'valid').length;
      const invalid = this.results.filter(r => r.status === 'invalid').length;
      const unknown = this.results.filter(r => r.status === 'unknown').length;
      const pending = this.results.filter(r => r.status === 'pending').length;
      const summary = { total, valid, invalid, unknown, pending, results: this.results };
      this.emit('done', summary);
      this.emit('log', `🏁 Verificação concluída! ✅ ${valid} válidos | ❌ ${invalid} inválidos${unknown > 0 ? ` | ⚠️ ${unknown} inconclusivos` : ''}${pending > 0 ? ` | ⏳ ${pending} não verificados` : ''}`);
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    const valid = this.results.filter(r => r.status === 'valid').length;
    const invalid = this.results.filter(r => r.status === 'invalid').length;
    const unknown = this.results.filter(r => r.status === 'unknown').length;
    const pending = this.results.filter(r => r.status === 'pending').length;
    this.emit('stopped', { results: this.results, valid, invalid, unknown, pending });
    this.emit('log', '🛑 Verificação interrompida pelo usuário.');
  }

  reset(): void {
    this.running = false;
    this.done = false;
    this.results = [];
  }

  getResults(): ValidationResult[] { return this.results; }
  isRunning(): boolean { return this.running; }
  isDone(): boolean { return this.done; }

  getStatus() {
    const valid = this.results.filter(r => r.status === 'valid').length;
    const invalid = this.results.filter(r => r.status === 'invalid').length;
    const unknown = this.results.filter(r => r.status === 'unknown').length;
    const pending = this.results.filter(r => r.status === 'pending').length;
    return {
      running: this.running,
      done: this.done,
      results: this.results,
      stats: { valid, invalid, unknown, pending, total: this.results.length },
    };
  }
}

export const whatsappValidator = new WhatsAppValidator();
