# SismosVE — Guía de Despliegue para IA

> Este documento es la referencia autoritativa para cualquier agente de IA que trabaje en este proyecto.
> Léelo completo antes de hacer cualquier cambio de código o despliegue.
> **TODO el despliegue va por IONOS. GitHub solo es respaldo de código fuente.**

---

## 1. Arquitectura del Sistema

```
FUNVISIS (fuente oficial)
    │
    ▼ (cada 1 minuto)
IONOS Scraper (/home/www/sismos_scraper.py)
    │
    └──► WordPress ForjaDigital (/home/www/clickandbuilds/ForjaDigital/)
              sismos_venezuela.json  ← app y web leen de aquí (SIN caché CDN)
              version.json           ← app verifica actualizaciones aquí
              sismos-venezuela.apk   ← los usuarios descargan de aquí
```

### ¿Por qué IONOS y NO GitHub?

GitHub raw (`raw.githubusercontent.com`) tiene un caché CDN de hasta 5-10 minutos.
Esto causaba que la app mostrara sismos de hace horas aunque el scraper ya hubiera actualizado los datos.
IONOS sirve los archivos directamente sin caché, garantizando datos frescos en menos de 1 minuto.

> **NUNCA** cambiar las URLs de datos/versión/descarga para que apunten a GitHub raw.
> El repositorio GitHub solo existe como respaldo del código fuente.

---

## 2. Estructura del Proyecto Local

```
terremotos/
├── test/
│   ├── src/
│   │   └── main.js          ← CÓDIGO FUENTE PRINCIPAL (editar aquí)
│   ├── public/
│   │   └── instalar.html    ← Página de descarga
│   ├── post-build.cjs       ← Script post-compilación
│   └── vite.config.js
├── web/                     ← Build de la web (generado, subir al servidor web)
│   ├── index.html
│   ├── assets/
│   ├── version.json         ← ¡MANTENER ACTUALIZADO!
│   └── sismos_venezuela.json
├── app/                     ← Proyecto Android (Proyecto Gradle)
│   ├── app/src/main/assets/dist/  ← Assets web que lee el APK (compilar aquí)
│   ├── gradlew.bat
│   └── sismos-venezuela.apk      ← APK compilado (output final)
└── version.json             ← Versión actual (fuente de verdad)
```

---

## 3. Variables Críticas del Código

En `test/src/main.js`:

```javascript
const CURRENT_VERSION = "1.1.2";  // ← Versión actual — actualizar en cada release
```

URLs de datos en `fetchFunvisisData()`:
```javascript
const IONOS_URL = 'https://forjadigitales.com/sismos_venezuela.json'; // primario
const LOCAL_URL = 'sismos_venezuela.json'; // fallback offline (bundleado en APK)
```

URL de verificación de versión:
```javascript
fetch(`https://forjadigitales.com/version.json?t=${Date.now()}`)
```

**Nunca cambiar estas URLs a GitHub raw.**

---

## 4. Credenciales y Acceso

### Servidor IONOS (SSH)
```
Host:     access-5019628204.webspace-host.com
Puerto:   22
Usuario:  su1082736
Password: s!crapper1234
Home SSH: /home/www/
```

### Rutas importantes en IONOS
```
Scraper:     /home/www/sismos_scraper.py
Log:         /home/www/sismos_scraper.log
Repo local:  /home/www/venezuelasismos/
WordPress:   /home/www/clickandbuilds/ForjaDigital/
APK:         /home/www/clickandbuilds/ForjaDigital/sismos-venezuela.apk
version:     /home/www/clickandbuilds/ForjaDigital/version.json
sismos JSON: /home/www/clickandbuilds/ForjaDigital/sismos_venezuela.json
```

### URLs Públicas (IONOS)
```
APK descarga:  https://forjadigitales.com/sismos-venezuela.apk
version.json:  https://forjadigitales.com/version.json
sismos JSON:   https://forjadigitales.com/sismos_venezuela.json
Cron endpoint: https://forjadigitales.com/sismos-cron.php?token=sismosve_cron_2024
```

### GitHub (solo código fuente)
```
Repo: https://github.com/sephirods/venezuelasismos
Uso:  Respaldo de código — NO usar para datos ni descargas
```

---

## 5. Cómo Conectarse a IONOS via Python (Paramiko)

```python
import paramiko

HOST     = 'access-5019628204.webspace-host.com'
PORT     = 22
USER     = 'su1082736'
PASSWORD = 's!crapper1234'

client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, port=PORT, username=USER, password=PASSWORD, timeout=20)

def ssh_run(cmd, timeout=30):
    stdin, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace').strip()
    err = stderr.read().decode('utf-8', errors='replace').strip()
    if out: print(out)
    if err: print("ERR:", err)
    return out, err

client.close()
```

### Subir archivos a IONOS

> ⚠️ **CRÍTICO**: NO usar `sftp.put()` — el SFTP de IONOS tiene un root distinto al SSH y
> da `FileNotFoundError`. Siempre usar SSH stdin con `cat >`:

```python
def upload_file(client, local_path, remote_path):
    """Sube un archivo a IONOS via SSH stdin. Funciona para cualquier tamaño."""
    stdin, stdout, stderr = client.exec_command(f"cat > {remote_path}")
    with open(local_path, 'rb') as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            stdin.write(chunk)
    stdin.channel.shutdown_write()
    exit_status = stdout.channel.recv_exit_status()
    return exit_status == 0
```

---

## 6. Procedimiento Completo: Publicar Nueva Versión

### Paso 1 — Actualizar versión en el código fuente

En `test/src/main.js` línea 4:
```javascript
const CURRENT_VERSION = "X.Y.Z";
```

### Paso 2 — Actualizar version.json

Editar `version.json` en la raíz:
```json
{
  "version": "X.Y.Z",
  "downloadUrl": "https://forjadigitales.com/sismos-venezuela.apk"
}
```
Copiar a `web/`:
```powershell
Copy-Item "version.json" "web\version.json" -Force
```

### Paso 3 — Compilar web

```powershell
cmd /c "cd test && npm run build && node post-build.cjs && xcopy /E /Y /I dist\* ..\web\ && xcopy /E /Y /I dist\* ..\app\app\src\main\assets\dist\"
```

### Paso 4 — Compilar APK Android

```powershell
cmd /c "cd app && gradlew.bat assembleDebug"
Copy-Item "app\app\build\outputs\apk\debug\app-debug.apk" "app\sismos-venezuela.apk" -Force
```

### Paso 5 — Subir APK y version.json a IONOS

```python
# Usar el método upload_file del paso 5
upload_file(client, 'app/sismos-venezuela.apk',
            '/home/www/clickandbuilds/ForjaDigital/sismos-venezuela.apk')
upload_file(client, 'version.json',
            '/home/www/clickandbuilds/ForjaDigital/version.json')

# Verificar
ssh_run("curl -s -o /dev/null -w '%{http_code}' https://forjadigitales.com/sismos-venezuela.apk")
ssh_run("curl -s https://forjadigitales.com/version.json")
```

### Paso 6 — Push a GitHub (respaldo de código)

```powershell
git pull origin main --no-rebase -X ours
git add -A
git commit -m "vX.Y.Z: descripcion del cambio"
git push origin main
```

> Si el push es rechazado por commits del scraper, el `--no-rebase -X ours` lo resuelve.
> Nunca usar `git push --force` sin `--force-with-lease`.

### Paso 7 — Entregar web al usuario

El usuario sube manualmente la carpeta `web/` a su servidor web.
Los archivos que cambian en cada build son:
- `web/index.html`
- `web/assets/index-HASH.js` (el hash cambia con cada compilación)
- `web/version.json`
- `web/instalar.html`

---

## 7. Lógica de Fetch de Datos (fetchFunvisisData)

Tres niveles de fallback — crítico para funcionar durante terremotos sin internet:

```
1. IONOS → forjadigitales.com/sismos_venezuela.json (online, <1 min de delay)
        ↓ timeout 8 seg o sin internet
2. localStorage cache → último JSON descargado exitosamente
        ↓ sin cache
3. sismos_venezuela.json local → bundleado en el APK al momento de compilar
```

---

## 8. Cron del Scraper en IONOS

Dos mecanismos simultáneos garantizan la ejecución cada minuto:

1. **IONOS WebCron** (panel my.ionos.es) → intervalo `0-59 0-23 1-31 1-12 0-6`
   Llama a: `http://forjadigitales.com/sismos-cron.php?token=sismosve_cron_2024`

2. **Plugin WP-Cron** (`sismos-cron` en WordPress) → respaldo cuando hay visitas

El scraper al ejecutarse:
1. Descarga `http://www.funvisis.gob.ve/maravilla.json`
2. Procesa y guarda JSON en `/home/www/venezuelasismos/web/sismos_venezuela.json`
3. Copia a WordPress: `/home/www/clickandbuilds/ForjaDigital/sismos_venezuela.json`
4. Hace `git push` a GitHub (respaldo legacy mientras usuarios migran de v1.1.1)
5. Log en `/home/www/sismos_scraper.log`

Verificar que funciona:
```python
ssh_run("tail -5 ~/sismos_scraper.log")
```

---

## 9. Errores Frecuentes y Soluciones

> [!WARNING]
> **NO USAR GIT NI GITHUB**: El repositorio local se encuentra desconectado de GitHub (la carpeta `.git` fue eliminada). Ningún script ni desarrollador de IA debe intentar ejecutar comandos de Git o subir código fuente a GitHub. El despliegue de datos es directo a IONOS y la web la sube el usuario manualmente.

| Error | Causa | Solución |
|---|---|---|
| La app sigue pidiendo actualizar tras instalar el nuevo APK | No se incrementó el `versionCode` o se copiaron los assets a la ruta incorrecta | Asegúrate de incrementar el `versionCode` en `app/app/build.gradle.kts` y que los assets web estén en `app/app/src/main/assets/dist/` |
| SFTP `FileNotFoundError` | SFTP de IONOS tiene root diferente a SSH | Usar método SSH stdin `cat >` (ver sección 5) |
| App muestra datos viejos | Solo afecta v1.1.1 (usaba GitHub CDN) | v1.1.2+ usa IONOS, no tiene este problema |
| Banner de update no aparece | version.json de IONOS sin actualizar | Subir el archivo `version.json` corregido a IONOS |
| Build JS cambia hash del archivo | Vite genera nuevo hash en cada build | Normal — el `index.html` se actualiza automáticamente con el nuevo hash |

---

## 10. Checklist Rápido de Nueva Versión

```
[ ] Actualizar CURRENT_VERSION en test/src/main.js
[ ] Actualizar version.json (raíz) — versión y downloadUrl IONOS
[ ] Copy-Item version.json web\version.json -Force
[ ] npm run build + post-build.cjs + xcopy a web/ y app/app/src/main/assets/dist/
[ ] Incrementar versionCode en app/app/build.gradle.kts (ej. de 1 a 2)
[ ] Actualizar versionName en app/app/build.gradle.kts a la nueva versión (ej. "1.1.2")
[ ] gradlew.bat assembleDebug
[ ] Copy-Item app-debug.apk → app\sismos-venezuela.apk
[ ] Subir sismos-venezuela.apk a IONOS via SSH stdin
[ ] Subir version.json a IONOS via SSH stdin
[ ] Verificar HTTP 200 en forjadigitales.com/sismos-venezuela.apk
[ ] Verificar HTTP 200 en forjadigitales.com/version.json
[ ] Decirle al usuario que suba web/ a su servidor
```
