import time
import sys
import random
import re
import json
import math
from concurrent.futures import ThreadPoolExecutor, as_completed

# Tenta importar bibliotecas, permitindo fallback amigável se não estiverem instaladas
try:
    import pandas as pd
    from DrissionPage import ChromiumPage, ChromiumOptions
    HAS_LIBS = True
except ImportError as e:
    HAS_LIBS = False
    IMPORT_ERROR = str(e)

# ── Regex de e-mail ─────────────────────────────────────────────────────────
EMAIL_PATTERN = re.compile(r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}')
# Extensões de arquivos e domínios de rastreamento/serviços que não são e-mails reais de contato
EMAIL_BLACKLIST_EXTENSIONS = {'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'woff', 'ttf', 'css', 'js', 'map'}
EMAIL_BLACKLIST_DOMAINS = {
    'sentry.io', 'sentry.wixpress.com', 'sentry-next.wixpress.com',
    'wixpress.com', 'example.com', 'test.com', 'yourdomain.com',
    'domain.com', 'email.com', 'company.com', 'site.com',
    'schema.org', 'w3.org', 'amazonaws.com',
}

def extract_emails(text: str) -> list[str]:
    """Extrai e-mails únicos e válidos de um texto, filtrando serviços de rastreamento."""
    if not text:
        return []
    found = EMAIL_PATTERN.findall(text)
    result = []
    for e in found:
        ext = e.split('.')[-1].lower()
        domain = e.split('@')[-1].lower()
        if ext in EMAIL_BLACKLIST_EXTENSIONS:
            continue
        if domain in EMAIL_BLACKLIST_DOMAINS:
            continue
        # Filtra subdomínios de serviços de rastreamento
        if any(bd in domain for bd in ('sentry', 'wixpress', 'segment.io', 'intercom', 'hubspot')):
            continue
        result.append(e)
    return list(set(result))

def get_emails_from_site(page, url: str) -> list[str]:
    """
    Abre a URL em uma aba existente, extrai e-mails da homepage e,
    opcionalmente, da página de contato.
    """
    emails = []
    try:
        page.get(url)
        # Espera inteligente: aguarda o body carregar (max 5 s) em vez de sleep fixo
        page.ele('tag:body', timeout=5)
        emails.extend(extract_emails(page.html))

        contact_links = (
            page.eles('tag:a@@href:contato') or
            page.eles('tag:a@@href:contact') or
            page.eles('tag:a@@text():Contato') or
            page.eles('tag:a@@text():Contact')
        )

        if contact_links:
            try:
                contact_links[0].click(by_js=True)
                page.ele('tag:body', timeout=4)
                emails.extend(extract_emails(page.html))
            except Exception:
                pass

    except Exception as e:
        print(f"EVENT:log: [-] Erro ao raspar emails de {url}: {e}", flush=True)

    return list(set(emails))


def _collect_email_worker(opts_dict: dict, url: str) -> list[str]:
    """
    Worker executado em thread separada para extrair e-mails de um site.
    Cada thread cria sua própria instância do Chrome.
    """
    try:
        co = ChromiumOptions()
        co.auto_port()
        co.headless(True)
        co.set_argument('--no-sandbox')
        co.set_argument('--disable-gpu')
        worker_page = ChromiumPage(co)
        emails = get_emails_from_site(worker_page, url)
        worker_page.quit()
        return emails
    except Exception as e:
        return []


def scroll_maps_list(page, max_leads: int = 120) -> list[tuple[str, str]]:
    """
    Rola o painel lateral do Google Maps repetidamente até coletar
    max_leads cards ou esgotar os resultados disponíveis.
    Retorna lista de (href, aria-label).
    """
    urls: list[tuple[str, str]] = []
    seen_hrefs: set[str] = set()
    SCROLL_PAUSE = 2.0   # segundos entre cada rolagem
    MAX_SCROLL_ATTEMPTS = 30  # evita loop infinito
    no_new_streak = 0   # contagem de scrolls consecutivos sem novos resultados

    for attempt in range(MAX_SCROLL_ATTEMPTS):
        cards = page.eles('.hfpxzc')

        new_found = 0
        for card in cards:
            href = card.attr('href')
            if href and href not in seen_hrefs:
                seen_hrefs.add(href)
                urls.append((href, card.attr('aria-label') or 'Desconhecido'))
                new_found += 1

        print(f"EVENT:log: [*] Scroll {attempt+1}: {len(urls)} locais coletados...", flush=True)

        if len(urls) >= max_leads:
            print(f"EVENT:log: [*] Limite de {max_leads} leads atingido.", flush=True)
            break

        # Verifica se chegou ao fim da lista ("Você chegou ao fim da lista")
        end_markers = (
            page.eles('css:.HlvSq') or
            page.eles('css:.section-no-result-title') or
            page.eles('css:p.fontBodyMedium[jslog]')
        )
        for marker in end_markers:
            if marker.text and ('fim' in marker.text.lower() or 'end' in marker.text.lower() or 'found' in marker.text.lower()):
                print("EVENT:log: [*] Fim da lista do Maps atingido.", flush=True)
                return urls[:max_leads]

        if new_found == 0:
            no_new_streak += 1
        else:
            no_new_streak = 0

        # Para se 3 scrolls consecutivos não trouxerem novos resultados
        if no_new_streak >= 3:
            print("EVENT:log: [*] Nenhum resultado novo após 3 tentativas — fim da lista.", flush=True)
            break

        # Rola o painel lateral via JavaScript de forma mais agressiva
        # Tenta diferentes seletores para o painel do Maps
        scroll_js = """
            var feed = document.querySelector('[role="feed"]') ||
                       document.querySelector('.m6QErb[aria-label]') ||
                       document.querySelector('.m6QErb.DxyBCb') ||
                       document.querySelector('.m6QErb');
            if (feed) { feed.scrollTop += 2000; return true; }
            return false;
        """
        scrolled = page.run_js(scroll_js)
        if not scrolled:
            # Fallback: scroll na página inteira
            page.scroll.down(2000)

        time.sleep(SCROLL_PAUSE)

    return urls[:max_leads]


def radius_to_zoom(radius_km: float) -> int:
    """Converte raio (km) para nível de zoom do Google Maps."""
    if radius_km <= 0:
        return 14
    zoom = round(14 - math.log2(max(radius_km, 0.5)))
    return max(10, min(16, zoom))


def extract_leads(nicho: str, localizacao: str = '', max_leads: int = 60,
                  lat: str = '', lng: str = '', radius_km: float = 5.0):
    # Monta a descrição do modo no log
    if lat and lng:
        mode_desc = f'coordenadas ({float(lat):.4f}, {float(lng):.4f}) raio={radius_km}km'
    else:
        mode_desc = f"'{localizacao}'"
    print(f"EVENT:log: [*] Iniciando extração: '{nicho}' em {mode_desc} (máx. {max_leads} leads)", flush=True)

    if not HAS_LIBS:
        print(f"EVENT:error: [-] Dependências ausentes: {IMPORT_ERROR}", flush=True)
        sys.exit(1)

    co = ChromiumOptions()
    co.auto_port()
    co.headless(True)
    co.set_argument('--no-sandbox')
    co.set_argument('--disable-gpu')

    try:
        page = ChromiumPage(co)
    except Exception as e:
        print(f"EVENT:error: [-] Erro ao iniciar Chrome: {e}", flush=True)
        print("EVENT:log: [*] Certifique-se de ter o Google Chrome instalado.", flush=True)
        sys.exit(1)

    leads = []

    # Constrói URL do Google Maps
    if lat and lng:
        zoom = radius_to_zoom(radius_km)
        search_query = nicho.replace(' ', '+')
        maps_url = f'https://www.google.com/maps/search/{search_query}/@{lat},{lng},{zoom}z'
        print(f'EVENT:log: [*] Modo coordenadas ativo — zoom calculado: {zoom}z (raio ~{radius_km}km)', flush=True)
    else:
        search_query = f'{nicho} em {localizacao}'.replace(' ', '+')
        maps_url = f'https://www.google.com/maps/search/{search_query}'

    try:
        print("EVENT:log: [*] Acessando Google Maps...", flush=True)
        page.get(maps_url)

        # Espera inteligente: aguarda o primeiro card aparecer (max 8 s)
        page.ele('.hfpxzc', timeout=8)
        time.sleep(random.uniform(1.5, 2.5))

        # ── FASE 1: Varredura completa — rola a lista e coleta todos os links ──
        print("EVENT:log: [*] Iniciando varredura da lista do Maps...", flush=True)
        urls = scroll_maps_list(page, max_leads=max_leads)
        total = len(urls)
        print(f"EVENT:log: [*] Total de locais a processar: {total}", flush=True)

        # ── FASE 2: Extração serial dos dados do Maps ──────────────────────────
        # (Maps não permite paralelismo fácil com uma única instância de Chrome)
        websites_to_scan: list[tuple[int, str, dict]] = []  # (idx, website, lead_parcial)

        for i, (url_local, nome_card) in enumerate(urls):
            print(f"EVENT:log: [{i+1}/{total}] Lendo: {nome_card}", flush=True)
            try:
                page.get(url_local)
                # Espera o título do local carregar
                page.ele('.DUwDvf', timeout=5)
                time.sleep(random.uniform(1.5, 2.5))

                nome_el = page.ele('.DUwDvf', timeout=3)
                nome = (nome_el.text if nome_el and nome_el.text else nome_card)

                tel_el = page.ele('css:[data-item-id^="phone:"]', timeout=2)
                if tel_el:
                    telefone = tel_el.text
                    telefone = re.sub(r'[\r\n]+', ' ', telefone)
                    telefone = re.sub(r'[^\d\s()+\-]', '', telefone).strip()
                else:
                    telefone = ""

                web_el = page.ele('css:[data-item-id="authority"]', timeout=2)
                website = web_el.attr('href') if web_el else ""

                # Endereço (bônus)
                addr_el = page.ele('css:[data-item-id="address"]', timeout=1)
                endereco = re.sub(r'\s+', ' ', addr_el.text).strip() if addr_el else ""

                lead = {
                    "Nome": nome,
                    "Telefone": telefone,
                    "Website": website,
                    "Endereço": endereco,
                    "E-mails": ""
                }

                if website:
                    # Guarda para extração paralela de e-mails na Fase 3
                    websites_to_scan.append((i, website, lead))
                else:
                    leads.append(lead)
                    print(f"EVENT:lead: {json.dumps(lead, ensure_ascii=False)}", flush=True)

            except Exception as e:
                print(f"EVENT:log: [-] Erro no lead {i+1}: {e}", flush=True)

        # ── FASE 3: Extração paralela de e-mails ──────────────────────────────
        if websites_to_scan:
            print(f"EVENT:log: [*] Extraindo e-mails de {len(websites_to_scan)} sites em paralelo (4 workers)...", flush=True)

            # Usa uma aba do próprio browser para cada worker não sobrecarregar
            # O ThreadPool abre abas em paralelo na mesma instância do Chrome
            def fetch_emails_tab(args):
                idx, website, lead = args
                try:
                    tab = page.new_tab(website)
                    emails = get_emails_from_site(tab, website)
                    tab.close()
                    return (idx, website, lead, emails)
                except Exception as e:
                    return (idx, website, lead, [])

            with ThreadPoolExecutor(max_workers=4) as executor:
                futures = {executor.submit(fetch_emails_tab, item): item for item in websites_to_scan}
                for future in as_completed(futures):
                    try:
                        idx, website, lead, emails = future.result()
                        lead["E-mails"] = ", ".join(emails)
                        leads.append(lead)
                        print(f"EVENT:log: [✓] E-mails de {lead['Nome']}: {lead['E-mails'] or '(nenhum)'}", flush=True)
                        print(f"EVENT:lead: {json.dumps(lead, ensure_ascii=False)}", flush=True)
                    except Exception as e:
                        print(f"EVENT:log: [-] Erro na extração de email paralela: {e}", flush=True)

    finally:
        page.quit()

    print(f"EVENT:done: {{\"total\": {len(leads)}}}", flush=True)


if __name__ == '__main__':
    nicho_alvo    = sys.argv[1] if len(sys.argv) > 1 else 'Dentistas'
    local_alvo    = sys.argv[2] if len(sys.argv) > 2 else 'São Paulo'
    max_leads_arg = int(sys.argv[3])   if len(sys.argv) > 3 else 60
    lat_arg       = sys.argv[4]        if len(sys.argv) > 4 else ''
    lng_arg       = sys.argv[5]        if len(sys.argv) > 5 else ''
    radius_arg    = float(sys.argv[6]) if len(sys.argv) > 6 else 5.0
    sys.stdout.reconfigure(encoding='utf-8')
    extract_leads(nicho_alvo, local_alvo, max_leads_arg, lat_arg, lng_arg, radius_arg)
