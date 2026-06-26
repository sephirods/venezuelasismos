import requests
import sys

def test_url(url):
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    try:
        print(f"\nConectando a {url}...")
        response = requests.get(url, headers=headers, timeout=10, verify=False)
        print(f"ÉXITO: Status Code {response.status_code}")
        print(f"Tamaño de respuesta: {len(response.text)} caracteres")
        return response.text
    except Exception as e:
        print(f"ERROR en {url}: {e}")
        return None

# Probar HTTPS
html = test_url("https://www.funvisis.gob.ve/")
if not html:
    # Probar HTTP index.php
    html = test_url("http://www.funvisis.gob.ve/index.php")
    if not html:
        # Probar HTTP raíz
        html = test_url("http://www.funvisis.gob.ve/")

    
if html:
    # Buscar palabras clave
    for keyword in ["sismo", "magnitud", "profundidad", "vargas", "caracas"]:
        count = html.lower().count(keyword)
        print(f"Palabra '{keyword}': encontrada {count} veces")
    
    with open("raw_funvisis.html", "w", encoding="utf-8") as f:
        f.write(html[:50000])
    print("Guardado HTML en raw_funvisis.html")

