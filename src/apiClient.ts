/**
 * Utilitário centralizado para chamadas à API do backend.
 *
 * - apiFetch: wrapper sobre fetch() que injeta automaticamente o Bearer token.
 * - sseUrl: constrói a URL de um endpoint SSE com o token como query param.
 *   (O EventSource nativo do browser não suporta headers customizados, por isso
 *    o token é passado via query param e validado no servidor.)
 */

const APP_SECRET: string = process.env.APP_SECRET || '';

/**
 * Retorna os headers padrão de autenticação para fetch().
 */
function authHeaders(): Record<string, string> {
  if (!APP_SECRET) return {};
  return { Authorization: `Bearer ${APP_SECRET}` };
}

/**
 * Wrapper sobre fetch() que inclui automaticamente o header de autenticação
 * e o Content-Type JSON quando o body for fornecido como objeto.
 */
export async function apiFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    ...authHeaders(),
    ...(options.headers as Record<string, string> | undefined),
  };

  // Se o body é um objeto, serializa para JSON e define o Content-Type
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options = { ...options, body: JSON.stringify(options.body) };
  }

  return fetch(url, { ...options, headers });
}

/**
 * Constrói a URL de um endpoint SSE com o token como query param.
 * Use com: new EventSource(sseUrl('/api/whatsapp/send-stream'))
 */
export function sseUrl(path: string): string {
  if (!APP_SECRET) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}_token=${encodeURIComponent(APP_SECRET)}`;
}
