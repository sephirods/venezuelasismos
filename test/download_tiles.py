import os
import math
import urllib.request
import time
import sys

# Definir la extensión geográfica del mapa completo (desde México/Guatemala hasta Brasil, y Cuba hasta Perú)
# Coordenadas aproximadas basadas en tu captura de pantalla:
MIN_LAT = -15.0
MAX_LAT = 25.0
MIN_LON = -95.0
MAX_LON = -45.0

# Niveles de zoom a descargar
ZOOM_LEVELS = [5, 6, 7, 8]

# Directorio de salida
OUTPUT_DIR = os.path.join(os.getcwd(), 'public', 'tiles')

# URL del servidor de teselas de CartoDB Dark Matter
TILE_URL_TEMPLATE = "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"

# Encabezado User-Agent para evitar que el servidor bloquee la descarga (Error 403)
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
}

def latlon_to_tile(lat_deg, lon_deg, zoom):
    lat_rad = math.radians(lat_deg)
    n = 2.0 ** zoom
    xtile = int((lon_deg + 180.0) / 360.0 * n)
    ytile = int((1.0 - math.log(math.tan(lat_rad) + (1.0 / math.cos(lat_rad))) / math.pi) / 2.0 * n)
    return xtile, ytile

def download_tile(z, x, y):
    url = TILE_URL_TEMPLATE.format(z=z, x=x, y=y)
    
    # Crear estructura de carpetas: public/tiles/z/x/
    folder_path = os.path.join(OUTPUT_DIR, str(z), str(x))
    os.makedirs(folder_path, exist_ok=True)
    
    file_path = os.path.join(folder_path, f"{y}.png")
    
    # Si la tesela ya existe localmente, no la volvemos a descargar
    if os.path.exists(file_path) and os.path.getsize(file_path) > 0:
        return True
        
    try:
        req = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=10) as response:
            with open(file_path, 'wb') as out_file:
                out_file.write(response.read())
        # Un pequeño delay de cortesía para no saturar el servidor
        time.sleep(0.02)
        return True
    except Exception as e:
        print(f"\nError descargando {z}/{x}/{y}: {e}")
        return False

def main():
    print("--- INICIANDO DESCARGA DE MAPAS PARA USO COMPLETAMENTE OFFLINE ---")
    print(f"Extensión: Latitud [{MIN_LAT} a {MAX_LAT}], Longitud [{MIN_LON} a {MAX_LON}]")
    print(f"Niveles de zoom a procesar: {ZOOM_LEVELS}")
    print(f"Guardando en: {OUTPUT_DIR}\n")
    
    total_downloaded = 0
    total_skipped = 0
    total_failed = 0
    
    # 1. Calcular el total de teselas para mostrar progreso
    tiles_to_download = []
    for z in ZOOM_LEVELS:
        x_min, y_min = latlon_to_tile(MAX_LAT, MIN_LON, z)  # Latitud max = y_min
        x_max, y_max = latlon_to_tile(MIN_LAT, MAX_LON, z)  # Latitud min = y_max
        
        # Ajustar bordes
        x_start, x_end = min(x_min, x_max), max(x_min, x_max)
        y_start, y_end = min(y_min, y_max), max(y_min, y_max)
        
        for x in range(x_start, x_end + 1):
            for y in range(y_start, y_end + 1):
                tiles_to_download.append((z, x, y))
                
    total_tiles = len(tiles_to_download)
    print(f"Total de imágenes de mapa a procesar: {total_tiles}")
    
    # 2. Descargar las teselas
    start_time = time.time()
    for index, (z, x, y) in enumerate(tiles_to_download):
        # Mostrar barra de progreso simple en consola
        progress = (index + 1) / total_tiles * 100
        sys.stdout.write(f"\rProgreso: {progress:.1f}% ({index+1}/{total_tiles}) | Procesando zoom {z}...")
        sys.stdout.flush()
        
        # Comprobar si ya existe
        folder_path = os.path.join(OUTPUT_DIR, str(z), str(x))
        file_path = os.path.join(folder_path, f"{y}.png")
        if os.path.exists(file_path):
            total_skipped += 1
            continue
            
        success = download_tile(z, x, y)
        if success:
            total_downloaded += 1
        else:
            total_failed += 1
            
    end_time = time.time()
    duration = end_time - start_time
    
    print("\n\n--- DESCARGA FINALIZADA ---")
    print(f"Tiempo transcurrido: {duration:.1f} segundos")
    print(f"Imágenes descargadas nuevas: {total_downloaded}")
    print(f"Imágenes omitidas (ya existían): {total_skipped}")
    print(f"Imágenes fallidas: {total_failed}")
    print(f"El mapa completo ahora funcionará 100% offline para los zooms {ZOOM_LEVELS}.")

if __name__ == "__main__":
    main()
