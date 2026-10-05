import fs from 'fs';
import path from 'path';
import { WhatsAppSession, type SessionStatus } from './whatsapp-session.js';

export interface SessionData {
  id: string;
  name: string;
  phone: string;
  status: SessionStatus;
}

export class WhatsAppSessionManager {
  private sessionsFile: string;
  private sessionsMetadata: Omit<SessionData, 'status'>[] = [];
  private activeInstances: Map<string, WhatsAppSession> = new Map();

  constructor() {
    this.sessionsFile = path.join(process.cwd(), 'whatsapp-sessions.json');
    this.loadSessions();
  }

  private loadSessions() {
    try {
      if (fs.existsSync(this.sessionsFile)) {
        const raw = fs.readFileSync(this.sessionsFile, 'utf-8');
        this.sessionsMetadata = JSON.parse(raw);
      } else {
        // Inicializa com uma sessão "default" para manter retrocompatibilidade com o chip antigo já logado
        this.sessionsMetadata = [
          {
            id: 'default',
            name: 'Conta Principal (Padrão)',
            phone: '',
          }
        ];
        this.saveSessions();
      }
    } catch (e) {
      console.error('[Session Manager] Erro ao carregar sessões:', e);
      this.sessionsMetadata = [{ id: 'default', name: 'Conta Principal (Padrão)', phone: '' }];
    }
  }

  private saveSessions() {
    try {
      fs.writeFileSync(this.sessionsFile, JSON.stringify(this.sessionsMetadata, null, 2), 'utf-8');
    } catch (e) {
      console.error('[Session Manager] Erro ao salvar sessões:', e);
    }
  }

  /**
   * Obtém todas as sessões e seus status em tempo real
   */
  getSessions(): SessionData[] {
    return this.sessionsMetadata.map(meta => {
      const instance = this.activeInstances.get(meta.id);
      return {
        ...meta,
        status: instance ? instance.getStatus() : 'idle',
      };
    });
  }

  /**
   * Retorna a instância física de WhatsAppSession correspondente
   */
  getSession(id: string): WhatsAppSession {
    let instance = this.activeInstances.get(id);
    if (!instance) {
      const meta = this.sessionsMetadata.find(s => s.id === id);
      const name = meta ? meta.name : 'Sessão';
      instance = new WhatsAppSession(id, name);
      this.activeInstances.set(id, instance);
      
      // Monitora se o status muda para autenticado e tenta capturar o telefone real da conta
      instance.on('status', async (status) => {
        if (status === 'authenticated') {
          // Quando autenticar, tenta ler o próprio número do WhatsApp Web
          try {
            const page = instance?.getPage();
            if (page) {
              // Executa script na página do WhatsApp para ler o próprio número do window.Store ou do DOM
              const myNumber = await page.evaluate(() => {
                try {
                  // Tenta acessar o ID do usuário conectado via WhatsApp Web Store interno
                  const wStore = (window as any).Debug?.store || (window as any).Store;
                  if (wStore && wStore.User && wStore.User.wid) {
                    return wStore.User.wid.user;
                  }
                  // Fallback: Tenta achar na imagem de perfil ou configurações
                  const myUser = localStorage.getItem('last-mem-wid-literal');
                  if (myUser) return myUser.replace('@c.us', '');
                } catch {}
                return '';
              });
              if (myNumber) {
                this.updatePhone(id, myNumber);
              }
            }
          } catch (e) {
            console.error('[Session Manager] Erro ao capturar número:', e);
          }
        }
      });
    }
    return instance;
  }

  /**
   * Atualiza o número de telefone da sessão conectada
   */
  updatePhone(id: string, phone: string) {
    const session = this.sessionsMetadata.find(s => s.id === id);
    if (session && session.phone !== phone) {
      session.phone = phone;
      this.saveSessions();
    }
  }

  /**
   * Cria uma nova sessão
   */
  createSession(name: string): SessionData {
    const id = 'session_' + Math.random().toString(36).slice(2, 10);
    const newSession = {
      id,
      name: name.trim() || `Conta ${this.sessionsMetadata.length + 1}`,
      phone: '',
    };
    this.sessionsMetadata.push(newSession);
    this.saveSessions();

    // Instancia a sessão na memória
    const instance = new WhatsAppSession(id, newSession.name);
    this.activeInstances.set(id, instance);

    return {
      ...newSession,
      status: 'idle',
    };
  }

  /**
   * Deleta uma sessão, encerra seu navegador e remove seus arquivos físicos de cookies
   */
  async deleteSession(id: string): Promise<boolean> {
    const index = this.sessionsMetadata.findIndex(s => s.id === id);
    if (index === -1) return false;

    // 1. Encerra e limpa a instância na memória
    const instance = this.activeInstances.get(id);
    if (instance) {
      await instance.disconnect();
      this.activeInstances.delete(id);
    }

    // 2. Remove do metadados
    this.sessionsMetadata.splice(index, 1);

    // 3. Se era a última sessão, recria a sessão padrão automaticamente
    if (this.sessionsMetadata.length === 0) {
      this.sessionsMetadata = [{ id: 'default', name: 'Conta Principal (Padrão)', phone: '' }];
    }

    this.saveSessions();

    // 4. Remove a pasta física de cookies para poupar espaço
    const sessionDir = id === 'default'
      ? path.join(process.cwd(), 'whatsapp-session-data')
      : path.join(process.cwd(), 'whatsapp-session-data', id);
      
    try {
      if (fs.existsSync(sessionDir)) {
        if (id === 'default') {
          const files = fs.readdirSync(sessionDir);
          for (const file of files) {
            if (file.startsWith('session_')) continue; // preserva subpastas de sessões auxiliares
            const filePath = path.join(sessionDir, file);
            fs.rmSync(filePath, { recursive: true, force: true });
          }
        } else {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
      }
    } catch (e) {
      console.error(`[Session Manager] Erro ao deletar diretório da sessão ${id}:`, e);
    }

    return true;
  }

  /**
   * Faz logout da sessão (encerra o navegador e apaga os cookies fisicamente sem excluir a conta da lista)
   */
  async logoutSession(id: string): Promise<boolean> {
    const meta = this.sessionsMetadata.find(s => s.id === id);
    if (!meta) return false;

    // 1. Encerra e limpa a instância na memória
    const instance = this.activeInstances.get(id);
    if (instance) {
      await instance.disconnect();
    }

    // 2. Reseta o número de telefone associado
    meta.phone = '';
    this.saveSessions();

    // 3. Remove a pasta física de cookies para forçar novo QR Code
    const sessionDir = id === 'default'
      ? path.join(process.cwd(), 'whatsapp-session-data')
      : path.join(process.cwd(), 'whatsapp-session-data', id);
      
    try {
      if (fs.existsSync(sessionDir)) {
        if (id === 'default') {
          const files = fs.readdirSync(sessionDir);
          for (const file of files) {
            if (file.startsWith('session_')) continue; // preserva subpastas de sessões auxiliares
            const filePath = path.join(sessionDir, file);
            fs.rmSync(filePath, { recursive: true, force: true });
          }
        } else {
          fs.rmSync(sessionDir, { recursive: true, force: true });
        }
      }
    } catch (e) {
      console.error(`[Session Manager] Erro ao limpar diretório de sessão no logout da ${id}:`, e);
    }

    // Garante que o status da sessão seja atualizado para idle
    if (instance) {
      instance.status = 'idle';
      instance.emit('status', 'idle');
      instance.emit('log', '🔄 Login limpo. Pronto para nova autenticação.');
    }

    return true;
  }


  /**
   * Encerra todas as sessões ativas (utilizado no shutdown do servidor)
   */
  async shutdownAll() {
    console.log('[Session Manager] Encerrando todas as instâncias do WhatsApp...');
    for (const [id, instance] of this.activeInstances.entries()) {
      try {
        await instance.disconnect();
      } catch (e) {
        console.error(`Erro ao desconectar instância ${id}:`, e);
      }
    }
    this.activeInstances.clear();
  }
}

export const sessionManager = new WhatsAppSessionManager();
