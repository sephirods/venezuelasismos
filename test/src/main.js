import geojsonData from './venezuela.json';

// --- VARIABLES DE ESTADO ---
const CURRENT_VERSION = "1.1.0"; // Versión actual de la app
let map;
let earthquakes = []; // Datos de la API de USGS
let simulatedEarthquakes = []; // Datos simulados por el usuario
let knownEventIds = new Set(); // IDs conocidos para evitar duplicados en polling y detectar sismos nuevos
let activeMarkers = {}; // ID -> Marker de Leaflet
let activeSonarMarkers = []; // Almacena círculos de sonar en curso
let selectedEventId = null;
let isSimulationMode = false;
let soundEnabled = true;
let notificationsState = 'all'; // 'off', 'important', 'all'
if (typeof window !== 'undefined') {
  const cachedState = localStorage.getItem('notifications_state');
  if (cachedState) {
    notificationsState = cachedState;
  } else if ('Notification' in window && Notification.permission !== 'granted') {
    notificationsState = 'off';
  }
}

let isLoading = true; // Indica si la carga inicial de sismos está en curso
let isAppInitializing = true; // Evita alertas sonoras y popups en la carga inicial y primer poll

// Configuración de Bounding Box para Venezuela (y alrededores activos sísmicamente)
const VENEZUELA_BOUNDS = {
  minLat: 0.0,
  maxLat: 16.0,
  minLon: -74.0,
  maxLon: -58.0
};

// --- AUDIO SINTETIZADOR (WEB AUDIO API) ---
let audioCtx = null;

function playEarthquakeSound(magnitude) {
  if (!soundEnabled) return;
  
  try {
    // Inicializar el contexto de audio en el primer clic/interacción
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    
    const now = audioCtx.currentTime;
    
    // 1. Efecto sísmico (Ruido de baja frecuencia / Vibración)
    const rumbleOsc = audioCtx.createOscillator();
    const rumbleGain = audioCtx.createGain();
    
    rumbleOsc.type = 'sawtooth';
    // Frecuencia base de 35Hz que sube un poco con la magnitud
    rumbleOsc.frequency.setValueAtTime(30 + (magnitude * 4), now);
    rumbleOsc.frequency.exponentialRampToValueAtTime(10, now + 1.8);
    
    rumbleGain.gain.setValueAtTime(0.0, now);
    rumbleGain.gain.linearRampToValueAtTime(0.3 + (magnitude * 0.05), now + 0.1);
    rumbleGain.gain.exponentialRampToValueAtTime(0.001, now + 1.8);
    
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(90, now);
    
    rumbleOsc.connect(rumbleGain);
    rumbleGain.connect(filter);
    filter.connect(audioCtx.destination);
    
    // 2. Tono de Alerta (Sonar Ping)
    const alertOsc = audioCtx.createOscillator();
    const alertGain = audioCtx.createGain();
    
    alertOsc.type = 'sine';
    // El tono se vuelve más agudo con mayor magnitud
    alertOsc.frequency.setValueAtTime(700 + (magnitude * 100), now + 0.05);
    alertOsc.frequency.exponentialRampToValueAtTime(250, now + 1.2);
    
    alertGain.gain.setValueAtTime(0.0, now);
    alertGain.gain.linearRampToValueAtTime(0.2 + (magnitude * 0.02), now + 0.1);
    alertGain.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
    
    alertOsc.connect(alertGain);
    alertGain.connect(audioCtx.destination);
    
    // Iniciar y detener osciladores
    rumbleOsc.start(now);
    rumbleOsc.stop(now + 1.8);
    
    alertOsc.start(now);
    alertOsc.stop(now + 1.2);
    
  } catch (e) {
    console.error("No se pudo reproducir el sonido: ", e);
  }
}

// --- RELOJ EN VIVO ---
function startLiveClock() {
  const clockEl = document.getElementById('live-clock');
  
  function updateTime() {
    const now = new Date();
    // Obtener la hora UTC y ajustar a VET (UTC-4)
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const VET_OFFSET = -4;
    const vetDate = new Date(utc + (3600000 * VET_OFFSET));
    
    const hours = String(vetDate.getHours()).padStart(2, '0');
    const minutes = String(vetDate.getMinutes()).padStart(2, '0');
    const seconds = String(vetDate.getSeconds()).padStart(2, '0');
    
    clockEl.textContent = `${hours}:${minutes}:${seconds} VET`;
  }
  
  setInterval(updateTime, 1000);
  updateTime();
}

// --- INICIALIZACIÓN DEL MAPA ---
let geojsonLayer;

function loadLocalMap() {
  try {
    geojsonLayer = L.geoJSON(geojsonData, {
      pane: 'landPane',
      style: function() {
        return {
          fillColor: '#121824',
          weight: 1.2,
          color: '#243048', // Límite de estados
          fillOpacity: 1
        };
      },
      onEachFeature: function(feature, layer) {
        layer.bindTooltip(feature.properties.NAME_1 || feature.properties.name || "Estado", {
          sticky: true,
          className: 'state-tooltip',
          direction: 'top'
        });
        
        layer.on({
          mouseover: function(e) {
            const layer = e.target;
            layer.setStyle({
              fillColor: '#1a2233',
              color: '#007aff',
              weight: 1.5
            });
          },
          mouseout: function(e) {
            if (geojsonLayer) {
              geojsonLayer.resetStyle(e.target);
            }
          },
          click: function(e) {
            map.fitBounds(e.target.getBounds(), { padding: [30, 30] });
          }
        });
      }
    }).addTo(map);
  } catch (error) {
    console.error("Error al cargar el mapa local offline:", error);
  }
}

function initMap() {
  // Coordenadas de inicio de Venezuela
  const centerLat = 7.8;
  const centerLon = -65.5;
  const initialZoom = 6;
  
  map = L.map('map', {
    zoomControl: false, // Lo moveremos de posición
    minZoom: 5,
    maxZoom: 12
  }).setView([centerLat, centerLon], initialZoom);
  
  // Agregar control de zoom abajo a la derecha
  L.control.zoom({
    position: 'bottomleft'
  }).addTo(map);
  
  // Crear pane con z-index inferior para la capa de tierra vectorizada local
  map.createPane('landPane');
  map.getPane('landPane').style.zIndex = 390;
  
  // 1. Cargar el mapa vectorizado local (Funciona 100% offline)
  loadLocalMap();
  
  // Cambiar el prefijo de atribución de Leaflet por la firma del desarrollador
  map.attributionControl.setPrefix('Desarrollado por <a href="desarrollador.html" style="color: var(--text-secondary); text-decoration: none; font-weight: 700; border-bottom: 1px dashed var(--text-muted);">Juan A. Baez</a>');
  
  // 2. Cargar mapas oscuros de fondo desde almacenamiento local (100% offline)
  L.tileLayer('tiles/{z}/{x}/{y}.png', {
    minZoom: 5,
    maxZoom: 12,
    maxNativeZoom: 8,
    attribution: '' // Dejar vacío para mostrar solo la firma
  }).addTo(map);

  // Evento de clic en el mapa para cerrar popup seleccionado
  map.on('popupclose', (e) => {
    if (e.popup._source && e.popup._source.options.eventId === selectedEventId) {
      deselectActiveCard();
    }
  });

  // Control de colapso de leyenda
  const legendEl = document.getElementById('map-legend');
  const legendToggle = document.getElementById('legend-toggle-btn');
  if (legendEl && legendToggle) {
    legendToggle.addEventListener('click', () => {
      legendEl.classList.toggle('collapsed');
      localStorage.setItem('legend_collapsed', legendEl.classList.contains('collapsed'));
    });
    
    // Restaurar estado de colapso guardado
    const isCollapsed = localStorage.getItem('legend_collapsed') === 'true';
    if (isCollapsed) {
      legendEl.classList.add('collapsed');
    }
  }
}

// --- COLORES Y CATEGORÍAS DE MAGNITUD ---
function getMagCategory(mag) {
  if (mag < 3.5) return 'low';
  if (mag < 4.5) return 'mid';
  if (mag < 6.0) return 'high';
  return 'severe';
}

function getMagColor(mag) {
  const cat = getMagCategory(mag);
  if (cat === 'low') return '#34c759';    // Verde
  if (cat === 'mid') return '#ff9500';    // Naranja
  if (cat === 'high') return '#ff3b30';   // Rojo
  return '#af52de';                       // Púrpura
}

// --- FETCH DE DATOS DESDE USGS ---
async function fetchEarthquakeData(timeFilter) {
  const now = new Date();
  let starttime;

  if (timeFilter === '10min') {
    // Para polling en tiempo real: solo últimos 10 minutos → respuesta mínima y rápida
    starttime = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  } else if (timeFilter === '24h') {
    starttime = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  } else if (timeFilter === '7d') {
    starttime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  } else {
    // 30d por defecto
    starttime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  }

  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson` +
    `&minlatitude=${VENEZUELA_BOUNDS.minLat}&maxlatitude=${VENEZUELA_BOUNDS.maxLat}` +
    `&minlongitude=${VENEZUELA_BOUNDS.minLon}&maxlongitude=${VENEZUELA_BOUNDS.maxLon}` +
    `&starttime=${starttime}`;

  try {
    // AbortSignal.timeout no disponible en iOS Safari < 15.4 — usar AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`USGS HTTP ${response.status}`);
    const data = await response.json();
    return data.features || [];
  } catch (error) {
    if (error.name !== 'AbortError') {
      console.error('Error cargando datos de USGS:', error.message);
    }
    return null;
  }
}

// --- FETCH DE DATOS DESDE NUESTRO ARCHIVO SCRAPED DE FUNVISIS ---
async function fetchFunvisisData() {
  try {
    const isNativeApp = typeof AndroidApp !== 'undefined' && AndroidApp.isNativeApp();
    const isLocalFile = window.location.protocol === 'file:';
    
    let url = 'sismos_venezuela.json';
    if (isNativeApp || isLocalFile) {
      url = 'https://raw.githubusercontent.com/sephirods/venezuelasismos/main/web/sismos_venezuela.json';
    }
    
    // Evitar caché con parámetro de tiempo
    const response = await fetch(url + `?t=${Date.now()}`);
    if (!response.ok) {
      // Si falla la ruta relativa local en web, intentar fallback a GitHub
      if (url !== 'https://raw.githubusercontent.com/sephirods/venezuelasismos/main/web/sismos_venezuela.json') {
        const fallbackResponse = await fetch('https://raw.githubusercontent.com/sephirods/venezuelasismos/main/web/sismos_venezuela.json' + `?t=${Date.now()}`);
        if (fallbackResponse.ok) {
          const data = await fallbackResponse.json();
          return data.features || [];
        }
      }
      throw new Error("HTTP " + response.status);
    }
    const data = await response.json();
    return data.features || [];
  } catch (error) {
    console.warn("No se pudo cargar la base de sismos de FUNVISIS:", error.message);
    return [];
  }
}

// --- COMPROBAR SI UN SISMO DE FUNVISIS ES DUPLICADO DE UNO DE LA USGS ---
function isDuplicate(event, list) {
  return list.some(item => {
    const timeDiff = Math.abs(item.properties.time - event.properties.time);
    const latDiff = Math.abs(item.geometry.coordinates[1] - event.geometry.coordinates[1]);
    const lonDiff = Math.abs(item.geometry.coordinates[0] - event.geometry.coordinates[0]);
    // Considerar duplicado si ocurren con menos de 10 min de diferencia y a menos de 50km (0.5 grados)
    return timeDiff < 10 * 60 * 1000 && latDiff < 0.5 && lonDiff < 0.5;
  });
}

// --- PROCESAMIENTO DE DATOS SÍSMICOS ---
function processEarthquakes(newFeatures, isInitialLoad = false) {
  let hasNewLiveEvent = false;
  let addedAny = false;
  
  // Procesar de más antiguos a más nuevos para que la cola de animación funcione correctamente
  const sortedNewFeatures = [...newFeatures].sort((a, b) => a.properties.time - b.properties.time);
  
  sortedNewFeatures.forEach(feature => {
    const id = feature.id;
    
    // Si es un sismo nuevo o si es una actualización oficial de uno preliminar existente
    let existingPrelimIdx = -1;
    if (isDuplicate(feature, earthquakes)) {
      // Buscar si el sismo duplicado existente es preliminar y el entrante es oficial
      existingPrelimIdx = earthquakes.findIndex(item => {
        const timeDiff = Math.abs(item.properties.time - feature.properties.time);
        const latDiff = Math.abs(item.geometry.coordinates[1] - feature.geometry.coordinates[1]);
        const lonDiff = Math.abs(item.geometry.coordinates[0] - feature.geometry.coordinates[0]);
        const match = timeDiff < 10 * 60 * 1000 && latDiff < 0.5 && lonDiff < 0.5;
        return match && item.properties.isPreliminary && !feature.properties.isPreliminary;
      });
    }
    
    if (knownEventIds.has(id) || (isDuplicate(feature, earthquakes) && existingPrelimIdx === -1)) {
      if (!knownEventIds.has(id)) {
        knownEventIds.add(id);
      }
      return;
    }
    
    if (existingPrelimIdx !== -1) {
      const oldId = earthquakes[existingPrelimIdx].id;
      console.log(`Reemplazando sismo preliminar ${oldId} por oficial ${id}`);
      
      // Eliminar el marcador anterior del mapa
      if (activeMarkers[oldId]) {
        map.removeLayer(activeMarkers[oldId]);
        delete activeMarkers[oldId];
      }
      
      // Reemplazar en el listado
      earthquakes[existingPrelimIdx] = feature;
      knownEventIds.add(id);
      addedAny = true;
    } else {
      knownEventIds.add(id);
      earthquakes.push(feature);
      addedAny = true;
      
      // Si NO es la carga inicial y ya terminó la inicialización de la app, es un evento en tiempo real
      if (!isInitialLoad && !isAppInitializing) {
        hasNewLiveEvent = true;
        triggerRealTimeAlert(feature);
      }
    }
  });

  if (addedAny) {
    try {
      localStorage.setItem('cached_earthquakes', JSON.stringify(earthquakes));
    } catch (e) {
      console.error("Error al guardar sismos en localStorage:", e);
    }
  }

  // Re-renderizar la UI si hay cambios
  updateUI();
}

// --- DISPARAR ALERTA EN TIEMPO REAL (ONDA ROJA EXPANSIVA) ---
function triggerRealTimeAlert(feature, isSimulated = false) {
  const [lon, lat] = feature.geometry.coordinates;
  const mag = feature.properties.mag;
  const place = feature.properties.place;
  
  // Evitar que sismos antiguos (más de 10 minutos) suenen o parpadeen si llegan tarde (evita tormentas de alertas)
  const eventTime = feature.properties.time;
  const ageMinutes = (Date.now() - eventTime) / 60000;
  if (!isSimulated && ageMinutes > 10) {
    console.log(`[Alerta] Sismo antiguo detectado tarde (${ageMinutes.toFixed(1)} min), se agrega en silencio`);
    return;
  }

  // 1. Play Sonar Warning Sound
  const shouldNotify = (notificationsState === 'all') || (notificationsState === 'important' && mag >= 4.0);
  if (shouldNotify) {
    playEarthquakeSound(mag);
  }
  
  // 2. Crear marcador del Sonar en el mapa
  const sonarIcon = L.divIcon({
    className: 'sonar-marker-wrapper',
    html: `
      <div class="sonar-marker">
        <div class="sonar-center"></div>
        <div class="sonar-ring"></div>
        <div class="sonar-ring"></div>
        <div class="sonar-ring"></div>
      </div>
    `,
    iconSize: [0, 0]
  });
  
  const sonarMarker = L.marker([lat, lon], { icon: sonarIcon }).addTo(map);
  activeSonarMarkers.push(sonarMarker);
  
  // Eliminar el círculo del sonar después de 15 segundos para no consumir recursos
  setTimeout(() => {
    map.removeLayer(sonarMarker);
    activeSonarMarkers = activeSonarMarkers.filter(m => m !== sonarMarker);
  }, 15000);
  
  // 3. Mover la vista del mapa suavemente al epicentro si el usuario no está interactuando
  map.flyTo([lat, lon], 8, {
    animate: true,
    duration: 2.5
  });
  
  // 4. Seleccionar el sismo en la lista y mapa una vez termine el movimiento
  setTimeout(() => {
    selectEvent(feature.id);
  }, 1500);
  
  // 4.5. Mostrar Toast visual en la pantalla
  const isPreliminary = feature.properties.isPreliminary;
  const auth = feature.properties.auth || 'EMSC';
  if (isPreliminary) {
    showToast(`⚠️ Sismo PRELIMINAR (${auth.toUpperCase()}): M ${mag.toFixed(1)} - ${place}`, "important");
  } else if (!isSimulated) {
    showToast(`🚨 Nuevo sismo confirmado: M ${mag.toFixed(1)} - ${place}`, "important");
  }
  
  // 5. Enviar Notificación Push si está activa
  if (shouldNotify && 'Notification' in window && Notification.permission === 'granted') {
    let title = isSimulated ? `M ${mag.toFixed(1)} - Sismo Simulado` : `M ${mag.toFixed(1)} - ¡Nuevo Sismo en Venezuela!`;
    let body = place;
    
    if (isPreliminary && !isSimulated) {
      title = `⚠️ M ${mag.toFixed(1)} - Sismo PRELIMINAR (${auth.toUpperCase()})`;
      body = `${place} (Detectado automáticamente, sujeto a revisión)`;
    }
    
    try {
      new Notification(title, {
        body: body,
        icon: "https://earthquake.usgs.gov/favicon.ico",
        tag: feature.id // Evita notificaciones duplicadas para el mismo sismo
      });
    } catch (e) {
      console.error("Error al enviar notificación push:", e);
    }
  }
}

// --- MOSTRAR TOAST NOTIFICACIÓN EN LA PANTALLA ---
function showToast(message, type = 'info') {
  const mapContainer = document.querySelector('.map-container');
  let toastContainer = document.getElementById('toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    toastContainer.style.position = 'absolute';
    toastContainer.style.top = '76px';
    toastContainer.style.left = '50%';
    toastContainer.style.transform = 'translateX(-50%)';
    toastContainer.style.display = 'flex';
    toastContainer.style.flexDirection = 'column';
    toastContainer.style.gap = '8px';
    toastContainer.style.zIndex = '9999';
    toastContainer.style.pointerEvents = 'none';
    if (mapContainer) {
      mapContainer.appendChild(toastContainer);
    } else {
      toastContainer.style.position = 'fixed';
      document.body.appendChild(toastContainer);
    }
  }
  
  const toast = document.createElement('div');
  toast.style.background = 'rgba(15, 19, 26, 0.95)';
  toast.style.backdropFilter = 'blur(10px)';
  toast.style.webkitBackdropFilter = 'blur(10px)';
  toast.style.border = '1px solid var(--border-color)';
  toast.style.color = 'var(--text-primary)';
  toast.style.padding = '10px 20px';
  toast.style.borderRadius = '30px';
  toast.style.fontSize = '0.75rem';
  toast.style.fontWeight = '700';
  toast.style.boxShadow = 'var(--shadow-lg)';
  toast.style.display = 'flex';
  toast.style.alignItems = 'center';
  toast.style.gap = '8px';
  toast.style.opacity = '0';
  toast.style.transform = 'translateY(-20px)';
  toast.style.transition = 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
  
  let borderColor = 'var(--border-color)';
  if (type === 'important') borderColor = 'var(--accent-red)';
  else if (type === 'all') borderColor = 'var(--accent-blue)';
  toast.style.borderColor = borderColor;
  
  toast.innerHTML = message;
  toastContainer.appendChild(toast);
  
  // Trigger animation
  setTimeout(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  }, 30);
  
  // Remove after 2.5 seconds
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-20px)';
    setTimeout(() => {
      toast.remove();
    }, 300);
  }, 2200);
}

// --- ACTUALIZAR LA INTERFAZ DE USUARIO ---
function updateUI() {
  const selectedTime = document.getElementById('time-filter').value;
  const minMag = parseFloat(document.getElementById('mag-filter').value);
  
  // Combinar sismos reales y simulados
  const allEvents = [...earthquakes, ...simulatedEarthquakes];
  
  // Filtrar según los controles seleccionados en el Sidebar
  const filteredEvents = allEvents.filter(event => {
    // Filtrar por magnitud
    if (event.properties.mag < minMag) return false;

    // Filtrar por categoría de intensidad
    const intensityFilterEl = document.getElementById('intensity-filter');
    if (intensityFilterEl) {
      const selectedIntensity = intensityFilterEl.value;
      if (selectedIntensity !== 'all') {
        const cat = getMagCategory(event.properties.mag);
        if (cat !== selectedIntensity) return false;
      }
    }
    
    // Filtrar por tiempo
    const timeDiff = Date.now() - event.properties.time;
    let maxTimeDiff;
    if (selectedTime === '24h') {
      maxTimeDiff = 24 * 60 * 60 * 1000;
    } else if (selectedTime === '7d') {
      maxTimeDiff = 7 * 24 * 60 * 60 * 1000;
    } else {
      maxTimeDiff = 30 * 24 * 60 * 60 * 1000;
    }
    
    return timeDiff <= maxTimeDiff;
  });
  
  // Ordenar sismos por tiempo desc (los más recientes primero)
  filteredEvents.sort((a, b) => b.properties.time - a.properties.time);
  
  // Actualizar estadísticas basadas en el conjunto filtrado (solo si no está cargando)
  if (!isLoading) {
    updateStats(allEvents, filteredEvents);
  }
  
  // Renderizar la lista de tarjetas
  renderList(filteredEvents);
  
  // Renderizar los marcadores en el mapa
  renderMapMarkers(filteredEvents);
}

// --- CALCULAR Y MOSTRAR ESTADÍSTICAS ---
function updateStats(allEvents, filteredEvents) {
  // 1. Sismos en las últimas 24 horas (usando todo el set, reales y simulados)
  const past24hTime = Date.now() - 24 * 60 * 60 * 1000;
  const count24h = allEvents.filter(e => e.properties.time >= past24hTime).length;
  document.getElementById('stat-count-24h').textContent = count24h;
  
  // 2. Magnitud máxima del periodo filtrado
  if (filteredEvents.length > 0) {
    const maxMag = Math.max(...filteredEvents.map(e => e.properties.mag));
    document.getElementById('stat-max-mag').textContent = maxMag.toFixed(1);
    
    // 3. Profundidad promedio del periodo filtrado
    const sumDepth = filteredEvents.reduce((sum, e) => sum + e.geometry.coordinates[2], 0);
    const avgDepth = sumDepth / filteredEvents.length;
    document.getElementById('stat-avg-depth').textContent = `${Math.round(avgDepth)} km`;
  } else {
    document.getElementById('stat-max-mag').textContent = '0.0';
    document.getElementById('stat-avg-depth').textContent = '0 km';
  }
}

// --- RENDERIZAR LISTA LATERAL ---
function renderList(events) {
  const listEl = document.getElementById('earthquake-list');
  
  if (isLoading) {
    document.getElementById('total-listed').textContent = '...';
    listEl.innerHTML = `
      <div class="list-placeholder">Cargando eventos sísmicos...</div>
    `;
    return;
  }
  
  document.getElementById('total-listed').textContent = events.length;
  
  if (events.length === 0) {
    listEl.innerHTML = `
      <div class="list-empty">
        <p>No se encontraron sismos con los filtros actuales.</p>
      </div>
    `;
    return;
  }
  
  listEl.innerHTML = '';
  
  events.forEach(event => {
    const { mag, place, time, isSimulated, isFunvisis, isPreliminary, auth } = event.properties;
    const depth = event.geometry.coordinates[2];
    const cat = getMagCategory(mag);
    
    const card = document.createElement('div');
    card.className = `eq-card border-${cat} ${event.id === selectedEventId ? 'active' : ''} ${isSimulated ? 'simulated' : ''} ${isFunvisis ? 'funvisis-event' : ''} ${isPreliminary ? 'preliminary-event' : ''}`;
    card.dataset.id = event.id;
    
    // Formatear fecha en Venezuela (VET)
    const eventDate = new Date(time);
    const formattedDate = eventDate.toLocaleString('es-VE', {
      timeZone: 'America/Caracas',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      min: '2-digit',
      hour12: true
    });
    
    card.innerHTML = `
      <div class="eq-mag-badge bg-${cat}">
        ${mag.toFixed(1)}
      </div>
      <div class="eq-info">
        <div class="eq-place" title="${place}">${place}</div>
        <div class="eq-time">${formattedDate}</div>
        <div class="eq-meta">
          <span class="eq-tag">Prof: ${Math.round(depth)} km</span>
          <span class="eq-tag">M: ${event.geometry.coordinates[1].toFixed(2)}, ${event.geometry.coordinates[0].toFixed(2)}</span>
          ${isSimulated ? '<span class="eq-tag-sim">SIMULADO</span>' : ''}
          ${isFunvisis ? '<span class="eq-tag-funvisis">FUNVISIS</span>' : ''}
          ${isPreliminary ? `<span class="eq-tag-preliminary">${(auth || 'AUTOMÁTICO').toUpperCase()} - PRELIMINAR</span>` : ''}
        </div>
      </div>
    `;
    
    // Evento de clic en la tarjeta
    card.addEventListener('click', () => {
      selectEvent(event.id);
      // Volar al punto en el mapa
      const [lon, lat] = event.geometry.coordinates;
      map.flyTo([lat, lon], 9, {
        animate: true,
        duration: 1.5
      });
    });
    
    listEl.appendChild(card);
  });
}

// --- DESENFOCAR OTRAS TARJETAS ---
function deselectActiveCard() {
  selectedEventId = null;
  document.querySelectorAll('.eq-card').forEach(card => card.classList.remove('active'));
}

// --- SELECCIONAR UN EVENTO SÍSMICO Y ABRIR POPUP ---
function selectEvent(eventId) {
  selectedEventId = eventId;
  
  // 1. Resaltar tarjeta en el sidebar
  document.querySelectorAll('.eq-card').forEach(card => {
    if (card.dataset.id === eventId) {
      card.classList.add('active');
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      card.classList.remove('active');
    }
  });
  
  // 2. Abrir Popup del marcador del mapa correspondiente
  const marker = activeMarkers[eventId];
  if (marker) {
    marker.openPopup();
  }
}

// --- RENDERIZAR MARCADORES EN EL MAPA ---
function renderMapMarkers(events) {
  // Limpiar marcadores obsoletos que ya no están en el set filtrado
  const currentFilteredIds = new Set(events.map(e => e.id));
  
  Object.keys(activeMarkers).forEach(id => {
    if (!currentFilteredIds.has(id)) {
      map.removeLayer(activeMarkers[id]);
      delete activeMarkers[id];
    }
  });
  
  // Crear o actualizar marcadores
  events.forEach(event => {
    const id = event.id;
    const [lon, lat, depth] = event.geometry.coordinates;
    const { mag, place, time, url, isSimulated, isFunvisis, isPreliminary, auth } = event.properties;
    const cat = getMagCategory(mag);
    const color = getMagColor(mag);
    
    // Si ya existe el marcador, mantenerlo y solo verificar si está seleccionado
    if (activeMarkers[id]) {
      return;
    }
    
    // Crear marcador de círculo
    const markerRadius = Math.max(6, mag * 2.5);
    const marker = L.circleMarker([lat, lon], {
      radius: markerRadius,
      fillColor: color,
      color: isPreliminary ? '#ff9500' : '#ffffff',
      weight: isPreliminary ? 2.5 : 1.5,
      dashArray: isPreliminary ? '5, 5' : null,
      opacity: 0.8,
      fillOpacity: isPreliminary ? 0.45 : 0.6,
      eventId: id // Guardamos el ID en las opciones del marcador
    }).addTo(map);
    
    // Formatear fecha en Venezuela (VET)
    const eventDate = new Date(time);
    const formattedDate = eventDate.toLocaleString('es-VE', {
      timeZone: 'America/Caracas',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      min: '2-digit',
      hour12: true
    });
    
    // Crear contenido personalizado para el Popup
    const popupContent = `
      <div class="map-popup-content">
        <div class="map-popup-header">
          <span class="map-popup-mag mag-${cat}">M ${mag.toFixed(1)}</span>
          ${isSimulated ? '<span class="map-popup-sim-tag">SIMULADO</span>' : ''}
          ${isFunvisis ? '<span class="map-popup-sim-tag" style="background:rgba(0,122,255,0.15);color:var(--accent-blue);border:1px solid rgba(0,122,255,0.3);">FUNVISIS</span>' : ''}
          ${isPreliminary ? `<span class="map-popup-sim-tag" style="background:rgba(255,149,0,0.15);color:#ff9500;border:1px solid rgba(255,149,0,0.3);">${(auth || 'AUTOMÁTICO').toUpperCase()} PRELIMINAR</span>` : ''}
        </div>
        <div class="map-popup-place">${place}</div>
        <div class="map-popup-row">
          <span>Fecha/Hora:</span>
          <span>${formattedDate}</span>
        </div>
        <div class="map-popup-row">
          <span>Profundidad:</span>
          <span>${Math.round(depth)} km</span>
        </div>
        <div class="map-popup-row">
          <span>Coordenadas:</span>
          <span>${lat.toFixed(3)}°, ${lon.toFixed(3)}°</span>
        </div>
        ${isFunvisis ? `<a href="http://www.funvisis.gob.ve/" target="_blank" rel="noopener" class="map-popup-link">Detalles FUNVISIS →</a>` : (isPreliminary ? `<a href="${url}" target="_blank" rel="noopener" class="map-popup-link">Detalles EMSC →</a>` : (!isSimulated ? `<a href="${url}" target="_blank" rel="noopener" class="map-popup-link">Detalles USGS →</a>` : ''))}
      </div>
    `;
    
    marker.bindPopup(popupContent, {
      closeButton: true,
      autoClose: false,
      closeOnEscapeKey: true
    });
    
    // Evento al hacer clic en el marcador
    marker.on('click', (e) => {
      // Activar la tarjeta en el sidebar y abrir el popup
      selectEvent(id);
    });
    
    activeMarkers[id] = marker;
  });
}

// --- POLLING EN TIEMPO REAL ---
let lastUpdateTime = null;
let lastUpdateTimer = null;

function updateLastUpdatedLabel() {
  const el = document.getElementById('last-updated-label');
  if (!el || !lastUpdateTime) return;
  const secs = Math.floor((Date.now() - lastUpdateTime) / 1000);
  if (secs < 60) {
    el.textContent = `Actualizado hace ${secs}s`;
    el.style.color = secs < 45 ? '#4ade80' : '#facc15'; // verde → amarillo si pasa 45s
  } else {
    el.textContent = `Actualizado hace ${Math.floor(secs / 60)}m`;
    el.style.color = '#f87171'; // rojo si hace más de 1 minuto
  }
}

async function startRealTimePolling() {
  const POLL_MS = 30000; // 30s — USGS actualiza el feed cada ~1 minuto

  // Contador visual de última actualización
  lastUpdateTimer = setInterval(updateLastUpdatedLabel, 1000);

  const poll = async () => {
    // Polling en tiempo real: pedir últimos 10min de USGS y base actualizada de FUNVISIS
    const [newUsgsFeatures, newFunvisisFeatures] = await Promise.all([
      fetchEarthquakeData('10min'),
      fetchFunvisisData()
    ]);
    
    let combined = [];
    if (newUsgsFeatures !== null) {
      combined = combined.concat(newUsgsFeatures);
      updateConnectionStatus(true);
    } else {
      updateConnectionStatus(false);
    }
    
    if (newFunvisisFeatures) {
      combined = combined.concat(newFunvisisFeatures);
    }
    
    if (combined.length > 0) {
      lastUpdateTime = Date.now();
      updateLastUpdatedLabel();
      processEarthquakes(combined, false);
    }
  };

  // Primera comprobación inmediata, luego cada 30s
  await poll();
  setInterval(poll, POLL_MS);
}

// --- CONFIGURACIÓN DEL SIMULADOR DE SISMOS ---
function initSimulator() {
  const simulateBtn = document.getElementById('simulate-btn');
  const cancelBtn = document.getElementById('cancel-simulation-btn');
  const overlay = document.getElementById('simulation-overlay');
  
  simulateBtn.addEventListener('click', () => {
    isSimulationMode = !isSimulationMode;
    toggleSimulationMode();
  });
  
  cancelBtn.addEventListener('click', () => {
    isSimulationMode = false;
    toggleSimulationMode();
  });
}

function toggleSimulationMode() {
  const overlay = document.getElementById('simulation-overlay');
  const mapEl = document.getElementById('map');
  const simulateBtn = document.getElementById('simulate-btn');
  
  if (isSimulationMode) {
    overlay.classList.remove('hidden');
    mapEl.style.cursor = 'crosshair';
    simulateBtn.classList.add('active');
    
    // Registrar evento de clic en el mapa para simulación
    map.on('click', handleMapClickForSimulation);
  } else {
    overlay.classList.add('hidden');
    mapEl.style.cursor = '';
    simulateBtn.classList.remove('active');
    
    // Remover evento de clic
    map.off('click', handleMapClickForSimulation);
  }
}

// Manejar el clic en el mapa para colocar el sismo simulado
function handleMapClickForSimulation(e) {
  const { lat, lng } = e.latlng;
  
  // Asegurar que esté dentro del rango razonable de nuestra vista
  if (lat < VENEZUELA_BOUNDS.minLat || lat > VENEZUELA_BOUNDS.maxLat || 
      lng < VENEZUELA_BOUNDS.minLon || lng > VENEZUELA_BOUNDS.maxLon) {
    alert("Por favor haz clic dentro de la región de Venezuela y sus alrededores.");
    return;
  }
  
  // Desactivar el modo de simulación y el overlay de inmediato para que no se quede la pantalla borrosa
  isSimulationMode = false;
  toggleSimulationMode();
  
  // Generar magnitud inicial aleatoria entre 3.0 y 7.0
  const randomMag = (Math.random() * 4 + 3.0).toFixed(1);
  
  // Crear el contenido del modal emergente usando Leaflet Popup
  const popupContainer = document.createElement('div');
  popupContainer.className = 'sim-modal';
  popupContainer.innerHTML = `
    <h3>Disparar Sismo Simulado</h3>
    <div class="sim-form-group">
      <label for="sim-mag">Magnitud (M)</label>
      <input type="number" id="sim-mag" min="1.0" max="9.0" step="0.1" value="${randomMag}">
    </div>
    <div class="sim-form-group">
      <label for="sim-depth">Profundidad (km)</label>
      <input type="number" id="sim-depth" min="0" max="300" step="5" value="15">
    </div>
    <div class="sim-modal-buttons">
      <button id="sim-trigger-btn" class="btn-sim-trigger">Disparar Onda</button>
    </div>
  `;
  
  const simPopup = L.popup()
    .setLatLng([lat, lng])
    .setContent(popupContainer)
    .openOn(map);
    
  // Manejador del botón dentro del Popup
  setTimeout(() => {
    const triggerBtn = document.getElementById('sim-trigger-btn');
    if (triggerBtn) {
      triggerBtn.addEventListener('click', () => {
        const mag = parseFloat(document.getElementById('sim-mag').value) || 5.0;
        const depth = parseFloat(document.getElementById('sim-depth').value) || 10;
        
        // Ejecutar simulación
        triggerSimulatedEarthquake(lat, lng, mag, depth);
        
        // Cerrar el popup
        map.closePopup();
      });
    }
  }, 100);
}

// Crear el objeto del sismo simulado e inyectarlo en el sistema
function triggerSimulatedEarthquake(lat, lng, mag, depth) {
  const id = `sim-${Date.now()}`;
  
  // Determinar la localización cercana aproximada para el texto
  let locationText = `Sismo Simulado a ${lat.toFixed(2)}°N, ${Math.abs(lng).toFixed(2)}°W`;
  
  // Ficción geográfica rápida
  if (lat > 10.0 && lat < 11.0 && lng > -67.5 && lng < -66.5) locationText = `Cerca de Caracas, Venezuela (Simulado)`;
  else if (lat > 9.5 && lat < 11.0 && lng > -72.0 && lng < -71.0) locationText = `Cerca de Maracaibo, Venezuela (Simulado)`;
  else if (lat > 9.5 && lat < 10.5 && lng > -63.5 && lng < -62.5) locationText = `Cerca de Maturín, Venezuela (Simulado)`;
  else if (lat > 8.0 && lat < 9.0 && lng > -72.5 && lng < -71.5) locationText = `Cerca de San Cristóbal, Venezuela (Simulado)`;
  else if (lat > 8.0 && lat < 9.0 && lng > -63.0 && lng < -62.0) locationText = `Cerca de Ciudad Guayana, Venezuela (Simulado)`;
  else if (lat > 9.8 && lat < 10.4 && lng > -69.5 && lng < -69.0) locationText = `Cerca de Barquisimeto, Venezuela (Simulado)`;
  
  const simEvent = {
    id: id,
    type: 'Feature',
    properties: {
      mag: mag,
      place: locationText,
      time: Date.now(),
      url: '#',
      title: `M ${mag.toFixed(1)} - ${locationText}`,
      isSimulated: true
    },
    geometry: {
      type: 'Point',
      coordinates: [lng, lat, depth] // Lon, Lat, Depth
    }
  };
  
  // Agregar al listado de simulados
  simulatedEarthquakes.push(simEvent);
  
  // Disparar flujo de sismo nuevo (Onda roja, sonido, centrar)
  triggerRealTimeAlert(simEvent, true);
  
  // Actualizar interfaz
  updateUI();
}

// --- SOLICITUD ROBUSTA DE NOTIFICACIONES (COMPATIBLE CON MÚLTIPLES NAVEGADORES) ---
function requestNotificationPermission(callback) {
  if (!('Notification' in window)) {
    if (callback) callback('unsupported');
    return;
  }
  
  const handlePermission = (permission) => {
    if (callback) callback(permission);
  };
  
  try {
    const promise = Notification.requestPermission(handlePermission);
    if (promise && typeof promise.then === 'function') {
      promise.then(handlePermission);
    }
  } catch (e) {
    try {
      Notification.requestPermission(handlePermission);
    } catch (err) {
      if (callback) callback('unsupported');
    }
  }
}

// --- CONFIGURAR AUDIO CONTROL Y RESETS ---
function initControls() {
  const soundBtn = document.getElementById('sound-toggle-btn');
  const notifBtn = document.getElementById('notification-toggle-btn');
  const timeFilter = document.getElementById('time-filter');
  const magFilter = document.getElementById('mag-filter');
  const magValDisplay = document.getElementById('mag-val');
  const resetBtn = document.getElementById('reset-filters-btn');
  
  // Control de sonido
  soundBtn.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    soundBtn.classList.toggle('active', soundEnabled);
    
    // Iniciar contexto de audio en caso de que esté deshabilitado
    if (soundEnabled && !audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
  });
  
  // Control de Notificaciones (UI Update)
  function updateNotificationBtn() {
    if (!notifBtn) return;
    
    // Remover todas las clases de estado
    notifBtn.classList.remove('active', 'accent-important', 'accent-all');
    
    const labelSpan = notifBtn.querySelector('span');
    const badgeSpan = notifBtn.querySelector('.control-btn-badge');
    
    if (notificationsState === 'off') {
      notifBtn.title = "Notificaciones: Silenciado";
      if (labelSpan) labelSpan.textContent = "Silenciado";
      if (badgeSpan) badgeSpan.style.display = 'none';
    } else if (notificationsState === 'important') {
      notifBtn.classList.add('active', 'accent-important');
      notifBtn.title = "Notificaciones: Solo Importantes (> 4.0 M)";
      if (labelSpan) labelSpan.textContent = "Importantes";
      if (badgeSpan) {
        badgeSpan.textContent = "4M";
        badgeSpan.style.display = 'block';
      }
    } else if (notificationsState === 'all') {
      notifBtn.classList.add('active', 'accent-all');
      notifBtn.title = "Notificaciones: Todos los Sismos";
      if (labelSpan) labelSpan.textContent = "Todos";
      if (badgeSpan) {
        badgeSpan.textContent = "Todo";
        badgeSpan.style.display = 'block';
      }
    }
  }
  
  // Inicializar estado del botón de notificaciones
  const isNative = typeof AndroidApp !== 'undefined' && AndroidApp.isNativeApp();
  if (isNative) {
    const nativeEnabled = AndroidApp.isNotificationsEnabled();
    if (!nativeEnabled) {
      notificationsState = 'off';
    } else if (notificationsState === 'off') {
      notificationsState = 'all';
    }
  }
  updateNotificationBtn();
  
  // Manejador del clic manual en el botón de notificaciones
  if (notifBtn) {
    notifBtn.addEventListener('click', () => {
      // Ciclar estados: 'off' -> 'important' -> 'all' -> 'off'
      if (notificationsState === 'off') {
        notificationsState = 'important';
      } else if (notificationsState === 'important') {
        notificationsState = 'all';
      } else {
        notificationsState = 'off';
      }
      
      // Guardar en localStorage
      localStorage.setItem('notifications_state', notificationsState);
      
      // Mostrar toast visual de estado
      if (notificationsState === 'off') {
        showToast("🔕 Alertas silenciadas", "off");
      } else if (notificationsState === 'important') {
        showToast("🔔 Alertas: Solo importantes (≥ 4.0 M)", "important");
      } else if (notificationsState === 'all') {
        showToast("🔔 Alertas: Todos los sismos", "all");
      }
      
      const isNative = typeof AndroidApp !== 'undefined' && AndroidApp.isNativeApp();
      if (isNative) {
        AndroidApp.setNotificationsEnabled(notificationsState !== 'off');
        updateNotificationBtn();
        return;
      }

      if (notificationsState === 'off') {
        updateNotificationBtn();
        return;
      }

      if (!('Notification' in window)) {
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
                      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
                      window.location.search.includes('mock-ios');
        if (isIOS) {
          const backdrop = document.getElementById('ios-pwa-modal-backdrop');
          if (backdrop) backdrop.classList.add('show');
        } else {
          alert('Tu navegador no soporta notificaciones de escritorio.');
        }
        notificationsState = 'off';
        updateNotificationBtn();
        return;
      }
      
      if (Notification.permission === 'denied') {
        alert('Has bloqueado las notificaciones en tu navegador. Por favor habilítalas desde la configuración del sitio en tu navegador (junto a la barra de direcciones).');
        notificationsState = 'off';
        updateNotificationBtn();
        return;
      }
      
      if (Notification.permission === 'default') {
        requestNotificationPermission((permission) => {
          if (permission === 'granted') {
            updateNotificationBtn();
            const text = notificationsState === 'important' ? "Solo importantes (> 4.0 M)" : "Todos los sismos";
            new Notification("Notificaciones Activas", {
              body: `Recibirás alertas de sismos: ${text}.`,
              icon: "https://earthquake.usgs.gov/favicon.ico"
            });
          } else {
            notificationsState = 'off';
            updateNotificationBtn();
          }
        });
      } else if (Notification.permission === 'granted') {
        updateNotificationBtn();
        const text = notificationsState === 'important' ? "Solo importantes (> 4.0 M)" : "Todos los sismos";
        new Notification("Configuración de Alertas", {
          body: `Alertas configuradas: ${text}.`,
          icon: "https://earthquake.usgs.gov/favicon.ico"
        });
      }
    });
  }

  // Solicitar permiso automáticamente en la primera interacción si está en estado 'default'
  if ('Notification' in window && Notification.permission === 'default') {
    const promptOnFirstInteraction = () => {
      const isNative = typeof AndroidApp !== 'undefined' && AndroidApp.isNativeApp();
      if (isNative) return;
      requestNotificationPermission((permission) => {
        if (permission === 'granted') {
          if (notificationsState === 'off') {
            notificationsState = 'all';
            localStorage.setItem('notifications_state', 'all');
          }
          updateNotificationBtn();
          new Notification("Notificaciones Activas", {
            body: "Recibirás alertas en pantalla cuando se detecten nuevos sismos en Venezuela.",
            icon: "https://earthquake.usgs.gov/favicon.ico"
          });
        }
      });
      // Remover el event listener para que no vuelva a dispararse
      document.removeEventListener('click', promptOnFirstInteraction);
    };
    document.addEventListener('click', promptOnFirstInteraction);
  }

  
  // Filtro de Tiempo
  timeFilter.addEventListener('change', () => {
    deselectActiveCard();
    updateUI();
  });

  // Filtro de Intensidad
  const intensityFilter = document.getElementById('intensity-filter');
  if (intensityFilter) {
    intensityFilter.addEventListener('change', () => {
      deselectActiveCard();
      updateUI();
    });
  }
  
  // Filtro de Magnitud
  magFilter.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    magValDisplay.textContent = `${val.toFixed(1)} M`;
    deselectActiveCard();
    updateUI();
  });
  
  // Limpiar Filtros
  resetBtn.addEventListener('click', () => {
    magFilter.value = 0.0;
    magValDisplay.textContent = "0.0 M";
    timeFilter.value = '30d';
    if (intensityFilter) {
      intensityFilter.value = 'all';
    }
    deselectActiveCard();
    
    // Recargar datos por defecto (30 días)
    timeFilter.dispatchEvent(new Event('change'));
  });
}

function initAndroidDownloadBanner() {
  const banner = document.getElementById('android-download-banner');
  const closeBtn = document.getElementById('close-banner-btn');
  const smallBtn = document.getElementById('apk-install-small-btn');
  
  if (!banner || !closeBtn) return;
  
  // Si estamos dentro de la app nativa (protocolo file o interfaz nativa), ocultamos los banners
  const isNativeApp = typeof AndroidApp !== 'undefined' && AndroidApp.isNativeApp();
  if (window.location.protocol === 'file:' || isNativeApp) {
    banner.classList.add('hidden');
    if (smallBtn) smallBtn.classList.add('hidden');
    return;
  }
  
  // Detectar si está en Android o si se está forzando la visualización con ?mock-android (para pruebas en PC)
  const isAndroid = /android/i.test(navigator.userAgent);
  const isMock = window.location.search.includes('mock-android');
  
  // Mostrar el botón pequeño permanente para descargar APK en Android
  if (smallBtn) {
    if (isAndroid || isMock) {
      smallBtn.classList.remove('hidden');
    } else {
      smallBtn.classList.add('hidden');
    }
  }
  
  // Comprobar si el usuario ya cerró el banner grande en esta sesión/navegador
  const isDismissed = localStorage.getItem('android-banner-dismissed') === 'true';
  
  if ((isAndroid || isMock) && !isDismissed) {
    banner.classList.remove('hidden');
  }
  
  closeBtn.addEventListener('click', () => {
    banner.classList.add('hidden');
    localStorage.setItem('android-banner-dismissed', 'true');
  });
}

function initIosNotificationBanner() {
  const banner = document.getElementById('ios-pwa-banner');
  const closeBtn = document.getElementById('ios-pwa-banner-close-btn');
  const learnMoreBtn = document.getElementById('ios-pwa-banner-learn-more');
  const backdrop = document.getElementById('ios-pwa-modal-backdrop');
  const modalCloseBtn = document.getElementById('ios-pwa-modal-close-btn');
  const modalFooterBtn = document.getElementById('ios-pwa-modal-footer-btn');

  if (!banner || !backdrop) return;

  // Detectar si es iOS (iPhone/iPad/iPod) o si hay parámetro de pruebas ?mock-ios
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
                (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ||
                window.location.search.includes('mock-ios');

  // Detectar si ya está instalado/corriendo en modo standalone (PWA)
  const isStandalone = window.navigator.standalone === true || 
                       window.matchMedia('(display-mode: standalone)').matches;

  // Detectar si estamos dentro de la app nativa de Android
  const isNativeApp = typeof AndroidApp !== 'undefined' && AndroidApp.isNativeApp();

  // Guardar en localStorage si ya lo cerraron
  const isDismissed = localStorage.getItem('ios-pwa-banner-dismissed') === 'true';

  // Solo mostrar si es iOS, NO está instalado como PWA, NO es la app nativa de Android y NO ha sido dismissed
  if (isIOS && !isStandalone && !isNativeApp && !isDismissed) {
    // Retrasar 2 segundos para dar una buena primera impresión
    setTimeout(() => {
      banner.classList.add('show');
    }, 2000);
  }

  // Evento de cerrar banner
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      banner.classList.remove('show');
      localStorage.setItem('ios-pwa-banner-dismissed', 'true');
    });
  }

  // Abrir modal explicativo
  const openModal = () => {
    backdrop.classList.add('show');
  };

  const closeModal = () => {
    backdrop.classList.remove('show');
  };

  if (learnMoreBtn) {
    learnMoreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openModal();
    });
  }

  // Click en el banner abre el modal (excepto si hacen click en la X de cerrar)
  banner.addEventListener('click', (e) => {
    if (closeBtn && (e.target === closeBtn || closeBtn.contains(e.target))) {
      return;
    }
    openModal();
  });

  if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeModal);
  if (modalFooterBtn) modalFooterBtn.addEventListener('click', closeModal);
  
  // Cerrar haciendo click en el fondo oscuro
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      closeModal();
    }
  });
}

function updateConnectionStatus(isOnline) {
  const statusDot = document.querySelector('.connection-status .status-dot');
  const statusText = document.querySelector('.connection-status .status-text');
  const connectionEl = document.querySelector('.connection-status');
  
  if (!statusDot || !statusText || !connectionEl) return;
  
  if (isOnline) {
    statusDot.className = 'status-dot online';
    statusText.textContent = 'MONITOREANDO EN VIVO';
    statusText.style.color = '';
    connectionEl.style.background = '';
    connectionEl.style.borderColor = '';
  } else {
    statusDot.className = 'status-dot offline';
    statusText.textContent = 'SIN CONEXIÓN - REINTENTANDO';
    statusText.style.color = 'var(--accent-red)';
    connectionEl.style.background = 'rgba(255, 59, 48, 0.05)';
    connectionEl.style.borderColor = 'rgba(255, 59, 48, 0.15)';
  }
}

function showOfflineMessage() {
  const listEl = document.getElementById('earthquake-list');
  if (listEl) {
    listEl.innerHTML = `
      <div class="list-empty">
        <p>No se pudo conectar con el USGS (Sin conexión). Puedes simular sismos haciendo clic en el mapa.</p>
      </div>
    `;
  }
}

// --- SISTEMA DE ACTUALIZACIÓN AUTOMÁTICA (GITHUB) ---
async function checkForUpdates() {
  const isNativeApp = typeof AndroidApp !== 'undefined' && AndroidApp.isNativeApp();
  const forceCheck = window.location.search.includes('check-updates');
  
  if (!isNativeApp && !forceCheck) return;

  try {
    const response = await fetch(`https://raw.githubusercontent.com/sephirods/venezuelasismos/main/web/version.json?t=${Date.now()}`);
    if (!response.ok) return;
    const data = await response.json();
    
    if (data.version && data.version !== CURRENT_VERSION) {
      const banner = document.getElementById('update-banner');
      if (banner) {
        const titleEl = banner.querySelector('.banner-text strong');
        const descEl = banner.querySelector('.banner-text p');
        const downloadBtn = document.getElementById('btn-update-download');
        
        if (titleEl) titleEl.textContent = `🚀 Actualización Disponible (v${data.version})`;
        if (descEl) descEl.textContent = data.description || 'Hay una nueva versión de la aplicación con mejoras importantes. ¡Descárgala ahora!';
        if (downloadBtn) downloadBtn.href = data.downloadUrl || 'instalar.html';
        
        banner.classList.remove('hidden');
      }
    }
  } catch (e) {
    console.warn("No se pudo verificar actualizaciones:", e);
  }
}

function initUpdateBanner() {
  const banner = document.getElementById('update-banner');
  const closeBtn = document.getElementById('close-update-banner-btn');
  if (!banner || !closeBtn) return;

  closeBtn.addEventListener('click', () => {
    banner.classList.add('hidden');
  });

  // Comprobar actualizaciones tras 3 segundos de iniciar la app
  setTimeout(checkForUpdates, 3000);
}

// --- CARGA INICIAL DE LA APP ---
function initApp() {
  // 1. Reloj en vivo
  startLiveClock();
  
  // 2. Mapa Leaflet
  initMap();
  
  // 3. Controles de audio y filtros
  initControls();
  
  // 4. Simulador
  initSimulator();
  
  // 4.5. Inicializar banner de descarga de Android
  initAndroidDownloadBanner();
  
  // 4.6. Inicializar banner e instrucciones de notificaciones para iOS (iPhone/iPad)
  initIosNotificationBanner();
  
  // 4.8. Cargar sismos desde localStorage si existen para soporte offline inmediato
  isLoading = true;
  const cachedSismos = localStorage.getItem('cached_earthquakes');
  if (cachedSismos) {
    try {
      const parsedSismos = JSON.parse(cachedSismos);
      if (Array.isArray(parsedSismos) && parsedSismos.length > 0) {
        earthquakes = parsedSismos;
        earthquakes.forEach(e => knownEventIds.add(e.id));
        isLoading = false;
        updateUI();
      }
    } catch (e) {
      console.error("Error al cargar sismos de la caché local:", e);
    }
  }
  
  // 5. Carga inicial de datos (USGS 30d + FUNVISIS) - Asíncrono para evitar bloqueos del hilo principal
  Promise.all([
    fetchEarthquakeData('30d'),
    fetchFunvisisData()
  ]).then(([initialRawEvents, funvisisEvents]) => {
    isLoading = false;
    let combined = [];
    
    if (initialRawEvents !== null) {
      combined = combined.concat(initialRawEvents);
      updateConnectionStatus(true);
    } else {
      updateConnectionStatus(false);
    }
    
    if (funvisisEvents) {
      combined = combined.concat(funvisisEvents);
    }
    
    if (combined.length === 0) {
      if (earthquakes.length === 0) {
        showOfflineMessage();
      }
    } else {
      processEarthquakes(combined, true);
    }
    
    // Desactivar inicialización después de procesar y renderizar los sismos iniciales
    // Damos un pequeño margen para asegurar que el primer poll termine
    setTimeout(() => {
      isAppInitializing = false;
    }, 2000);
  }).catch(error => {
    isLoading = false;
    isAppInitializing = false;
    updateConnectionStatus(false);
    console.error("Error al cargar sismos iniciales:", error);
    if (earthquakes.length === 0) {
      showOfflineMessage();
    }
  });
  
  // 6. Iniciar polling en tiempo real cada 15s
  startRealTimePolling();
  
  // 7. Verificar si hay actualizaciones de la APK
  initUpdateBanner();
  
  // 8. Inicializar alertas instantáneas por WebSockets (EMSC)
  initEMSCWebSocket();
}

let emscWs = null;
let emscReconnectTimeout = null;

function initEMSCWebSocket() {
  const isNativeApp = typeof AndroidApp !== 'undefined' && AndroidApp.isNativeApp();
  // Enable WebSockets in native app too for real-time updates when open
  
  if (emscWs) {
    try { emscWs.close(); } catch (e) {}
  }
  
  console.log('Conectando a SeismicPortal WebSocket (EMSC)...');
  emscWs = new WebSocket('wss://www.seismicportal.eu/standing_order/websocket');
  
  emscWs.onopen = () => {
    console.log('Conectado a SeismicPortal WebSocket (EMSC) exitosamente.');
    if (emscReconnectTimeout) {
      clearTimeout(emscReconnectTimeout);
      emscReconnectTimeout = null;
    }
  };
  
  emscWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.action !== 'create' && msg.action !== 'update') return;
      
      const emscEvent = msg.data;
      if (!emscEvent || !emscEvent.properties || !emscEvent.geometry) return;
      
      const props = emscEvent.properties;
      const coords = emscEvent.geometry.coordinates; // [lon, lat, depth]
      
      if (!coords || coords.length < 2) return;
      const lon = parseFloat(coords[0]);
      const lat = parseFloat(coords[1]);
      const depth = coords.length >= 3 ? parseFloat(coords[2]) : 0.0;
      
      // 1. Filtrar geográficamente para Venezuela y alrededores:
      // Latitud: [0.0, 16.0], Longitud: [-74.0, -58.0]
      if (lat < 0.0 || lat > 16.0 || lon < -74.0 || lon > -58.0) {
        return; // Fuera del área de cobertura
      }
      
      const mag = parseFloat(props.mag || 0.0);
      const place = props.flynn_region || 'Ubicación Desconocida (Costa/Mar)';
      const timeISO = props.time;
      const timeMs = timeISO ? new Date(timeISO).getTime() : Date.now();
      const auth = props.auth || 'EMSC';
      const unid = props.unid || `emsc-${timeMs}`;
      
      // 2. Construir sismo compatible estilo USGS
      const feature = {
        type: "Feature",
        id: `emsc-${unid}`,
        properties: {
          mag: mag,
          place: place,
          time: timeMs,
          url: `https://www.seismicportal.eu/eventdetails.html?unid=${unid}`,
          title: `M ${mag.toFixed(1)} - ${place} (Preliminar)`,
          isFunvisis: false,
          isPreliminary: true,
          auth: auth,
          depth: depth
        },
        geometry: {
          type: "Point",
          coordinates: [lon, lat, depth]
        }
      };
      
      console.log(`[EMSC WebSocket] Sismo preliminar detectado en Venezuela: M ${mag} - ${place} (Autoridad: ${auth})`);
      
      // 3. Procesar en el hilo principal
      processEarthquakes([feature], false);
      
    } catch (err) {
      console.error('Error procesando mensaje de EMSC WebSocket:', err);
    }
  };
  
  emscWs.onclose = () => {
    console.warn('Conexión con EMSC WebSocket cerrada. Intentando reconectar en 10 segundos...');
    if (!emscReconnectTimeout) {
      emscReconnectTimeout = setTimeout(initEMSCWebSocket, 10000);
    }
  };
  
  emscWs.onerror = (err) => {
    console.error('Error en EMSC WebSocket:', err);
    try { emscWs.close(); } catch (e) {}
  };

  // Soporte de simulación para pruebas en PC (?mock-emsc)
  if (window.location.search.includes('mock-emsc')) {
    setTimeout(() => {
      console.log('[Mock EMSC] Disparando sismo de prueba desde WebSocket...');
      const mockEvent = {
        action: 'create',
        data: {
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [-66.89, 10.61, 10.0]
          },
          properties: {
            mag: 4.8,
            flynn_region: 'Cerca de la Costa de La Guaira (Mock EMSC)',
            time: new Date().toISOString(),
            auth: 'SGC',
            unid: 'mock-emsc-12345'
          }
        }
      };
      // Enviar al event handler
      emscWs.onmessage({ data: JSON.stringify(mockEvent) });
    }, 5000);
  }
}

// Ejecutar cuando se cargue la estructura DOM
window.addEventListener('DOMContentLoaded', function() {
  initApp();
});
