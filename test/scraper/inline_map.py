import os
import json

def main():
    base_dir = os.path.dirname(__file__)
    
    # Rutas
    main_js_path = os.path.join(base_dir, "..", "test-funvisis", "main.js")
    venezuela_json_path = os.path.join(base_dir, "..", "src", "venezuela.json")
    
    # Leer venezuela.json
    with open(venezuela_json_path, "r", encoding="utf-8") as f:
        geo_data = json.load(f)
    geo_data_str = json.dumps(geo_data, ensure_ascii=False)
    
    # Leer main.js
    with open(main_js_path, "r", encoding="utf-8") as f:
        main_js = f.read()
        
    # Reemplazar la declaración de geojsonData
    target_decl = "let geojsonData = null;"
    replacement_decl = f"let geojsonData = {geo_data_str};"
    
    if target_decl in main_js:
        main_js = main_js.replace(target_decl, replacement_decl)
        print("Mapa venezuela.json incrustado con éxito en main.js")
    else:
        print("ADVERTENCIA: No se encontró la declaración 'let geojsonData = null;' en main.js")
        
    # Reemplazar la URL local de sismos por la URL de CDN/GitHub para evitar CORS local en Android
    local_url = "../sismos_venezuela.json"
    cdn_url = "https://raw.githubusercontent.com/sephirods/venezuelasismos/main/public/sismos_venezuela.json"
    
    if local_url in main_js:
        main_js = main_js.replace(local_url, cdn_url)
        print("URL de sismos locales cambiada a la CDN de GitHub para soporte WebView.")
        
    # Guardar main.js modificado
    with open(main_js_path, "w", encoding="utf-8") as f:
        f.write(main_js)
        
    print("Incrustación completada.")

if __name__ == "__main__":
    main()
