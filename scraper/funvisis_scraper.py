import requests
import json
from datetime import datetime, timezone, timedelta
import os
import sys

def parse_funvisis_to_usgs(funvisis_data):
    features = []
    
    # Bucle sobre los sismos de FUNVISIS
    for item in funvisis_data.get("features", []):
        try:
            prop = item.get("properties", {})
            geom = item.get("geometry", {})
            coords = geom.get("coordinates", [0.0, 0.0])
            
            # 1. Magnitud
            mag = float(prop.get("phone", 0.0))
            
            # 2. Lugar (Epicentro)
            place = prop.get("address", "Ubicación desconocida")
            
            # 3. Profundidad
            depth_str = prop.get("state", "0.0").replace(" km", "").strip()
            depth = float(depth_str) if depth_str else 0.0
            
            # 4. Coordenadas
            lon = float(coords[0])
            lat = float(coords[1])
            
            # 5. Fecha y Hora (HLV es UTC-4)
            date_str = prop.get("postalCode", "") # DD-MM-YYYY
            time_str = prop.get("city", "")       # HH:MM
            
            epoch_ms = 0
            if date_str and time_str:
                # Combinar fecha y hora
                dt_str = f"{date_str} {time_str}"
                # Formato en FUNVISIS es DD-MM-YYYY HH:MM
                dt = datetime.strptime(dt_str, "%d-%m-%Y %H:%M")
                # HLV es UTC-4
                tz_hlv = timezone(timedelta(hours=-4))
                dt = dt.replace(tzinfo=tz_hlv)
                
                # CORRECCIÓN DE FECHA FUTURA (timezone mixup en FUNVISIS)
                # Si la hora calculada está en el futuro respecto al momento actual,
                # significa que mezclaron la fecha UTC (mañana) con la hora local de Venezuela.
                # Restamos 1 día para corregirlo al día local correcto.
                now_hlv = datetime.now(tz_hlv)
                if dt > now_hlv:
                    dt = dt - timedelta(days=1)
                    
                epoch_ms = int(dt.timestamp() * 1000)
                
            # 6. Crear Feature estilo USGS
            sismo_id = f"funvisis-{epoch_ms}-{int(lat*100)}-{int(lon*100)}"
            
            feature = {
                "type": "Feature",
                "id": sismo_id,
                "properties": {
                    "mag": mag,
                    "place": place,
                    "time": epoch_ms,
                    "url": "http://www.funvisis.gob.ve/",
                    "title": f"M {mag:.1f} - {place}",
                    "isFunvisis": True,
                    "depth": depth
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [lon, lat, depth]
                }
            }
            features.append(feature)
        except Exception as ex:
            print(f"Error procesando sismo individual: {ex}", file=sys.stderr)
            
    return {
        "type": "FeatureCollection",
        "metadata": {
            "title": "FUNVISIS Recientes (Sismología VE)",
            "count": len(features),
            "generated": int(datetime.now(timezone.utc).timestamp() * 1000)
        },
        "features": features
    }

def main():
    url = "http://www.funvisis.gob.ve/maravilla.json"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    
    try:
        print(f"Descargando {url}...")
        response = requests.get(url, headers=headers, timeout=15)
        if response.status_code != 200:
            print(f"Error HTTP {response.status_code}", file=sys.stderr)
            sys.exit(1)
            
        funvisis_data = response.json()
        usgs_styled_data = parse_funvisis_to_usgs(funvisis_data)
        
        # Guardar en public/sismos_venezuela.json
        output_dir = os.path.join(os.path.dirname(__file__), "..", "public")
        os.makedirs(output_dir, exist_ok=True)
        output_path = os.path.join(output_dir, "sismos_venezuela.json")
        
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(usgs_styled_data, f, ensure_ascii=False, indent=2)
            
        print(f"Completado: {len(usgs_styled_data['features'])} sismos convertidos y guardados en {output_path}")
        
    except Exception as e:
        print(f"Error en la ejecución del scraper: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
