import time
import sys
import random
import re
import json

# Tenta importar bibliotecas, permitindo fallback amigável se não estiverem instaladas
try:
    import pandas as pd
    from DrissionPage import ChromiumPage, ChromiumOptions
    HAS_LIBS = True
except ImportError as e:
    HAS_LIBS = False
    IMPORT_ERROR = str(e)

def extract_emails(text):
    if not text:
        return []
    pattern = r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}'
    return list(set(re.findall(pattern, text)))

def get_emails_from_site(page, url):
    emails = []
    try:
        page.get(url)
        time.sleep(random.uniform(2, 4))
        emails.extend(extract_emails(page.html))
        
        contact_links = page.eles('tag:a@@href:contato') or \
                        page.eles('tag:a@@href:contact') or \
                        page.eles('tag:a@@text():Contato') or \
                        page.eles('tag:a@@text():Contact')
        
        if contact_links:
            contact_links[0].click()
            time.sleep(random.uniform(2, 4))
            emails.extend(extract_emails(page.html))
            
    except Exception as e:
        print(f"EVENT:log: [-] Erro ao raspar emails do site {url}: {e}", flush=True)
        
    return list(set(emails))

def extract_leads(nicho, localizacao):
    print(f"EVENT:log: [*] Iniciando script Python em produção: {nicho} em {localizacao}", flush=True)
    
    if not HAS_LIBS:
        print(f"EVENT:error: [-] Ambiente não possui dependências: {IMPORT_ERROR}", flush=True)
        print("EVENT:log: [*] Este ambiente cloud atual não suporta DrissionPage/Pandas nativamente.", flush=True)
        sys.exit(1)

    co = ChromiumOptions()
    co.set_argument('--headless')
    co.set_argument('--no-sandbox')
    co.set_argument('--disable-gpu')
    
    try:
        page = ChromiumPage(co)
    except Exception as e:
        print(f"EVENT:error: [-] Erro ao iniciar ChromiumHeadless: {e}", flush=True)
        print("EVENT:log: [*] Geralmente falta o Google Chrome instalado no SO hospedeiro.", flush=True)
        sys.exit(1)

    leads = []
    search_query = f"{nicho} em {localizacao}".replace(" ", "+")
    maps_url = f"https://www.google.com/maps/search/{search_query}"
    
    try:
        print("EVENT:log: [*] Acessando Google Maps...", flush=True)
        page.get(maps_url)
        time.sleep(random.uniform(3, 5))
        
        resultados = page.eles('.hfpxzc')
        print(f"EVENT:log: [*] Encontrados {len(resultados)} resultados na tela atual.", flush=True)
        
        # Limitamos a max 5 para uso no preview web
        max_results = min(len(resultados), 5)
        
        for i in range(max_results):
            result = resultados[i]
            try:
                page.scroll.to_see(result)
                result.click()
                time.sleep(random.uniform(2, 4))
                
                nome_el = page.ele('.DUwDvf fontBodyLarge', timeout=2) 
                nome = nome_el.text if nome_el else "Desconhecido"
                
                tel_el = page.ele('css:[data-item-id^="phone:"]', timeout=2)
                telefone = tel_el.text if tel_el else ""
                
                web_el = page.ele('css:[data-item-id="authority"]', timeout=2)
                website = web_el.attr('href') if web_el else ""
                
                print(f"EVENT:log: [{i+1}/{max_results}] Coletado: {nome}", flush=True)
                
                emails_encontrados = []
                if website:
                    nova_aba = page.new_tab(website)
                    emails_encontrados = get_emails_from_site(nova_aba, website)
                    nova_aba.close()
                
                lead = {
                    "Nome": nome,
                    "Telefone": telefone,
                    "Website": website,
                    "E-mails": ", ".join(emails_encontrados)
                }
                leads.append(lead)
                print(f"EVENT:lead: {json.dumps(lead)}", flush=True)
                
                time.sleep(random.uniform(1.5, 3.5))
                
            except Exception as e:
                print(f"EVENT:log: [-] Erro no lead {i+1}: {e}", flush=True)
                
    finally:
        page.quit()

    if leads:
        print(f"EVENT:done: {{\"total\": {len(leads)}}}", flush=True)
    else:
        print("EVENT:done: {\"total\": 0}", flush=True)

if __name__ == "__main__":
    nicho_alvo = sys.argv[1] if len(sys.argv) > 1 else 'Dentistas'
    local_alvo = sys.argv[2] if len(sys.argv) > 2 else 'São Paulo'
    # Force utf-8 encoding for stdout
    sys.stdout.reconfigure(encoding='utf-8')
    extract_leads(nicho_alvo, local_alvo)
