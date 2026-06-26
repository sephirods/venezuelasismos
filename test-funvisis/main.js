// --- VARIABLES DE ESTADO ---
let map;
let geojsonData = null;
let earthquakes = []; // Datos acumulados (USGS + FUNVISIS)
let simulatedEarthquakes = []; // Datos simulados por el usuario
let knownEventIds = new Set(); // IDs conocidos para evitar duplicados en polling y detectar sismos nuevos
let activeMarkers = {}; // ID -> Marker de Leaflet
let activeSonarMarkers = []; // Almacena círculos de sonar en curso
let selectedEventId = null;
let isSimulationMode = false;
let soundEnabled = true;

// Estado de Notificaciones Cíclico:
// 'off' (Silenciado) | 'important' (Solo > 4.0 M) | 'all' (Todos los sismos)
let notificationsLevel = localStorage.getItem('notifications_level') || 'important';
let isLoading = true; // Indica si la carga inicial de sismos está en curso

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
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    const now = audioCtx.currentTime;
    
    // Sonido 1: Rumbo grave del terremoto (Frecuencia sub-baja)
    const rumbleOsc = audioCtx.createOscillator();
    const rumbleGain = audioCtx.createGain();
    
    rumbleOsc.type = 'sine';
    // Frecuencia proporcional a la fuerza (sismos fuertes suenan más profundos/graves)
    const freq = Math.max(25, 60 - magnitude * 5); 
    rumbleOsc.frequency.setValueAtTime(freq, now);
    
    // Volumen adaptativo basado en magnitud
    const maxVolume = Math.min(0.8, (magnitude - 1) * 0.15); 
    rumbleGain.gain.setValueAtTime(0.01, now);
    rumbleGain.gain.linearRampToValueAtTime(maxVolume, now + 0.1);
    rumbleGain.gain.exponentialRampToValueAtTime(0.001, now + 4.0);

    // Filtro pasa bajos para darle más pesadez analógica al estruendo
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(100, now);

    rumbleOsc.connect(rumbleGain);
    rumbleGain.connect(filter);
    filter.connect(audioCtx.destination);

    // Sonido 2: Pitido de alarma (Frecuencia aguda para llamar la atención en sismos > 4.0)
    if (magnitude >= 4.0) {
      const alertOsc = audioCtx.createOscillator();
      const alertGain = audioCtx.createGain();

      alertOsc.type = 'sawtooth';
      alertOsc.frequency.setValueAtTime(880, now); // Nota La5 (A5)
      
      // Pitch deslizante (efecto sirena)
      alertOsc.frequency.linearRampToValueAtTime(440, now + 0.8);
      alertOsc.frequency.linearRampToValueAtTime(880, now + 1.6);

      alertGain.gain.setValueAtTime(0.01, now);
      alertGain.gain.linearRampToValueAtTime(0.2, now + 0.1);
      alertGain.gain.exponentialRampToValueAtTime(0.001, now + 1.8);

      alertOsc.connect(alertGain);
      alertGain.connect(audioCtx.destination);

      alertOsc.start(now);
      alertOsc.stop(now + 2.0);
    }

    rumbleOsc.start(now);
    rumbleOsc.stop(now + 4.5);

  } catch (e) {
    console.error("Error al reproducir audio del sismo:", e);
  }
}

// --- ACTUALIZAR HORA LOCAL DE VENEZUELA EN LA CABECERA ---
function initClock() {
  const clockEl = document.getElementById('live-clock');
  if (!clockEl) return;
  
  function updateTime() {
    const now = new Date();
    // Convertir a hora de Venezuela (UTC-4)
    const vetDate = new Date(now.toLocaleString('en-US', { timeZone: 'America/Caracas' }));
    
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

async function loadLocalMap() {
  try {
    if (!geojsonData) {
      const response = await fetch('../src/venezuela.json');
      geojsonData = await response.json();
    }
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
  const centerLat = 7.8;
  const centerLon = -65.5;
  const initialZoom = 6;
  
  map = L.map('map', {
    zoomControl: false,
    minZoom: 5,
    maxZoom: 12
  }).setView([centerLat, centerLon], initialZoom);
  
  L.control.zoom({
    position: 'bottomleft'
  }).addTo(map);
  
  map.createPane('landPane');
  map.getPane('landPane').style.zIndex = 390;
  
  loadLocalMap();
  map.attributionControl.setPrefix('Desarrollado por Juan A. Baez (Experimental)');
  
  // Capa base de azulejos oscuros local
  L.tileLayer('../tiles/{z}/{x}/{y}.png', {
    minZoom: 5,
    maxZoom: 12,
    maxNativeZoom: 8,
    attribution: ''
  }).addTo(map);

  map.on('popupclose', (e) => {
    if (e.popup._source && e.popup._source.options.eventId === selectedEventId) {
      deselectActiveCard();
    }
  });
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
  return '#af52de';                       // Morado
}

// --- FETCH DE DATOS DESDE USGS (API GLOBAL) ---
async function fetchEarthquakeData(timeFilter) {
  const now = new Date();
  let starttime;

  if (timeFilter === '10min') {
    starttime = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  } else if (timeFilter === '24h') {
    starttime = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  } else if (timeFilter === '7d') {
    starttime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  } else {
    starttime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  }

  const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson` +
    `&minlatitude=${VENEZUELA_BOUNDS.minLat}&maxlatitude=${VENEZUELA_BOUNDS.maxLat}` +
    `&minlongitude=${VENEZUELA_BOUNDS.minLon}&maxlongitude=${VENEZUELA_BOUNDS.maxLon}` +
    `&starttime=${starttime}`;

  try {
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
    // Almacenado localmente en public/sismos_venezuela.json
    // En dev/producción se lee desde la carpeta superior
    const response = await fetch('../sismos_venezuela.json');
    if (!response.ok) throw new Error("HTTP " + response.status);
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
  let addedAny = false;
  
  // Ordenar sismos por tiempo cronológico para la animación
  const sortedNewFeatures = [...newFeatures].sort((a, b) => a.properties.time - b.properties.time);
  
  sortedNewFeatures.forEach(feature => {
    const id = feature.id;
    
    // Comprobar si ya conocemos el ID o si es un duplicado espacial/temporal
    if (knownEventIds.has(id) || isDuplicate(feature, earthquakes)) {
      if (!knownEventIds.has(id)) {
        knownEventIds.add(id); // Mantener en caché de IDs procesados
      }
      return;
    }
    
    knownEventIds.add(id);
    earthquakes.push(feature);
    addedAny = true;
    
    // Si NO es la carga inicial de la página, es un evento en tiempo real
    if (!isInitialLoad) {
      // Determinar si debemos alertar en base al nivel de la campanita
      let shouldAlert = false;
      const mag = feature.properties.mag;
      
      if (notificationsLevel === 'all') {
        shouldAlert = true;
      } else if (notificationsLevel === 'important') {
        shouldAlert = (mag >= 4.0);
      }
      
      if (shouldAlert) {
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

  updateUI();
}

// --- DISPARAR ALERTA EN TIEMPO REAL (ONDA ROJA/AZUL EXPANSIVA Y SONIDO) ---
function triggerRealTimeAlert(feature, isSimulated = false) {
  const [lon, lat] = feature.geometry.coordinates;
  const mag = feature.properties.mag;
  const place = feature.properties.place;
  const isFunv = feature.properties.isFunvisis;
  
  // 1. Sonido adaptativo
  playEarthquakeSound(mag);
  
  // 2. Crear marcador del Sonar en el mapa (color azul para FUNVISIS, rojo para USGS)
  const alertColor = isFunv ? 'var(--accent-blue)' : 'var(--accent-red)';
  const alertBg = isFunv ? 'rgba(0, 122, 255, 0.12)' : 'rgba(255, 59, 48, 0.12)';
  
  const sonarIcon = L.divIcon({
    className: 'sonar-marker-wrapper',
    html: `
      <div class="sonar-marker">
        <div class="sonar-center" style="background-color: ${alertColor}; box-shadow: 0 0 10px ${alertColor}"></div>
        <div class="sonar-ring" style="border-color: ${alertColor}; background: ${alertBg}"></div>
        <div class="sonar-ring" style="border-color: ${alertColor}; background: ${alertBg}"></div>
        <div class="sonar-ring" style="border-color: ${alertColor}; background: ${alertBg}"></div>
      </div>
    `,
    iconSize: [0, 0]
  });
  
  const sonarMarker = L.marker([lat, lon], { icon: sonarIcon }).addTo(map);
  activeSonarMarkers.push(sonarMarker);
  
  setTimeout(() => {
    map.removeLayer(sonarMarker);
    activeSonarMarkers = activeSonarMarkers.filter(m => m !== sonarMarker);
  }, 15000);
  
  // 3. Mover la vista suavemente
  map.flyTo([lat, lon], 8, {
    animate: true,
    duration: 2.5
  });
  
  // 4. Seleccionar la tarjeta
  setTimeout(() => {
    selectEvent(feature.id);
  }, 1500);
  
  // 5. Enviar Notificación Push del Navegador
  if (notificationsLevel !== 'off' && 'Notification' in window && Notification.permission === 'granted') {
    const sourceName = isFunv ? "FUNVISIS" : "USGS";
    const title = isSimulated ? `M ${mag.toFixed(1)} - Sismo Simulado` : `M ${mag.toFixed(1)} - ¡Nuevo Sismo (${sourceName})!`;
    try {
      new Notification(title, {
        body: place,
        icon: isFunv ? "https://www.funvisis.gob.ve/favicon.ico" : "https://earthquake.usgs.gov/favicon.ico",
        tag: feature.id
      });
    } catch (e) {
      console.error("Error al enviar notificación push:", e);
    }
  }
}

// --- ACTUALIZAR LA INTERFAZ DE USUARIO ---
function updateUI() {
  const selectedTime = document.getElementById('time-filter').value;
  const minMag = parseFloat(document.getElementById('mag-filter').value);
  
  // Combinar sismos reales y simulados
  const allEvents = [...earthquakes, ...simulatedEarthquakes];
  
  // Aplicar filtros
  const now = Date.now();
  let timeLimitMs;
  if (selectedTime === '24h') {
    timeLimitMs = 24 * 60 * 60 * 1000;
  } else if (selectedTime === '7d') {
    timeLimitMs = 7 * 24 * 60 * 60 * 1000;
  } else {
    timeLimitMs = 30 * 24 * 60 * 60 * 1000; // 30d
  }
  
  const filteredEvents = allEvents.filter(event => {
    const { mag, time } = event.properties;
    const timeMatch = (now - time) <= timeLimitMs;
    const magMatch = mag >= minMag;
    return timeMatch && magMatch;
  });
  
  // Ordenar lista del sidebar: más recientes primero
  const sortedEvents = [...filteredEvents].sort((a, b) => b.properties.time - a.properties.time);
  
  // 1. Actualizar Estadísticas
  updateStats(filteredEvents);
  
  // 2. Renderizar Marcadores en el Mapa
  renderMarkers(filteredEvents);
  
  // 3. Renderizar Lista en el Sidebar
  renderSidebarList(sortedEvents);
  
  // Actualizar contador del título
  document.getElementById('total-listed').textContent = sortedEvents.length;
}

// --- CALCULAR Y ACTUALIZAR ESTADÍSTICAS ---
function updateStats(events) {
  const statCount = document.getElementById('stat-count-24h');
  const statMax = document.getElementById('stat-max-mag');
  const statDepth = document.getElementById('stat-avg-depth');
  
  if (events.length === 0) {
    statCount.textContent = '0';
    statMax.textContent = '-';
    statDepth.textContent = '- km';
    return;
  }
  
  const now = Date.now();
  const count24h = events.filter(e => (now - e.properties.time) <= 24 * 60 * 60 * 1000).length;
  
  const maxMag = Math.max(...events.map(e => e.properties.mag));
  
  const totalDepth = events.reduce((sum, e) => sum + e.geometry.coordinates[2], 0);
  const avgDepth = Math.round(totalDepth / events.length);
  
  statCount.textContent = count24h;
  statMax.textContent = maxMag.toFixed(1);
  statDepth.textContent = `${avgDepth} km`;
}

// --- DIBUJAR MARCADORES SÍSMICOS EN EL MAPA ---
function renderMarkers(events) {
  // Limpiar marcadores obsoletos (que ya no cumplen los filtros)
  const currentIds = new Set(events.map(e => e.id));
  Object.keys(activeMarkers).forEach(id => {
    if (!currentIds.has(id)) {
      map.removeLayer(activeMarkers[id]);
      delete activeMarkers[id];
    }
  });
  
  events.forEach(event => {
    const id = event.id;
    const [lon, lat] = event.geometry.coordinates;
    const depth = event.geometry.coordinates[2];
    const { mag, place, time, isSimulated, isFunvisis, url } = event.properties;
    const cat = getMagCategory(mag);
    const color = getMagColor(mag);
    
    if (activeMarkers[id]) {
      return; // Ya dibujado
    }
    
    // Crear marcador de círculo
    const markerRadius = Math.max(6, mag * 2.5);
    const marker = L.circleMarker([lat, lon], {
      radius: markerRadius,
      fillColor: color,
      color: '#ffffff',
      weight: 1.5,
      opacity: 0.8,
      fillOpacity: 0.6,
      eventId: id
    }).addTo(map);
    
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
    
    const popupContent = `
      <div class="map-popup-content">
        <div class="map-popup-header">
          <span class="map-popup-mag mag-${cat}">M ${mag.toFixed(1)}</span>
          ${isSimulated ? '<span class="map-popup-sim-tag">SIMULADO</span>' : ''}
          ${isFunvisis ? '<span class="map-popup-sim-tag" style="background:rgba(0,122,255,0.15);color:var(--accent-blue);border:1px solid rgba(0,122,255,0.3)">FUNVISIS</span>' : ''}
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
        ${!isSimulated ? `<a href="${url}" target="_blank" rel="noopener" class="map-popup-link">${isFunvisis ? 'Página FUNVISIS →' : 'Detalles USGS →'}</a>` : ''}
      </div>
    `;
    
    marker.bindPopup(popupContent, {
      closeButton: true,
      autoClose: false,
      closeOnEscapeKey: true
    });
    
    marker.on('click', () => {
      selectEvent(id);
    });
    
    activeMarkers[id] = marker;
  });
}

// --- RENDERIZAR LA LISTA EN EL SIDEBAR ---
function renderSidebarList(sortedEvents) {
  const listEl = document.getElementById('earthquake-list');
  if (!listEl) return;
  
  if (sortedEvents.length === 0) {
    listEl.innerHTML = `
      <div class="list-empty">
        <p>No se encontraron sismos con los filtros actuales.</p>
      </div>
    `;
    return;
  }
  
  listEl.innerHTML = '';
  
  sortedEvents.forEach(event => {
    const { mag, place, time, isSimulated, isFunvisis } = event.properties;
    const depth = event.geometry.coordinates[2];
    const cat = getMagCategory(mag);
    
    const card = document.createElement('div');
    card.className = `eq-card border-${cat} ${event.id === selectedEventId ? 'active' : ''} ${isSimulated ? 'simulated' : ''} ${isFunvisis ? 'funvisis-event' : ''}`;
    card.dataset.id = event.id;
    
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
        </div>
      </div>
    `;
    
    card.addEventListener('click', () => {
      selectEvent(event.id);
      const [lon, lat] = event.geometry.coordinates;
      map.flyTo([lat, lon], 9, {
        animate: true,
        duration: 1.5
      });
    });
    
    listEl.appendChild(card);
  });
}

function deselectActiveCard() {
  selectedEventId = null;
  document.querySelectorAll('.eq-card').forEach(card => card.classList.remove('active'));
}

function selectEvent(eventId) {
  selectedEventId = eventId;
  
  // Resaltar tarjeta
  document.querySelectorAll('.eq-card').forEach(card => {
    if (card.dataset.id === eventId) {
      card.classList.add('active');
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      card.classList.remove('active');
    }
  });
  
  // Abrir Popup en el mapa
  const marker = activeMarkers[eventId];
  if (marker && map) {
    marker.openPopup();
  }
}

// --- NOTIFICACIONES DEL NAVEGADOR ---
function checkAndRequestNotificationPermission(callback) {
  if (!('Notification' in window)) {
    if (callback) callback('unsupported');
    return;
  }
  
  if (Notification.permission === 'granted') {
    if (callback) callback('granted');
    return;
  }
  
  if (Notification.permission === 'denied') {
    if (callback) callback('denied');
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
    if (soundEnabled && !audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
  });
  
  // Actualizar interfaz del botón cíclico de la campanita
  updateNotificationBtn();
  
  if (notifBtn) {
    notifBtn.addEventListener('click', () => {
      // Ciclo: off -> important -> all -> off
      if (notificationsLevel === 'off') {
        notificationsLevel = 'important';
      } else if (notificationsLevel === 'important') {
        notificationsLevel = 'all';
      } else {
        notificationsLevel = 'off';
      }
      
      localStorage.setItem('notifications_level', notificationsLevel);
      updateNotificationBtn();
      
      // Si el nivel no es 'off', solicitar permisos del navegador
      if (notificationsLevel !== 'off') {
        checkAndRequestNotificationPermission(permission => {
          if (permission !== 'granted') {
            console.warn("Permiso de notificaciones denegado:", permission);
            // Revertir a off si no se otorgó permiso en el navegador
            notificationsLevel = 'off';
            localStorage.setItem('notifications_level', 'off');
            updateNotificationBtn();
          }
        });
      }
      
      // Sincronizar con puente nativo de Android
      const isNative = typeof AndroidApp !== 'undefined' && AndroidApp.isNativeApp();
      if (isNative) {
        const enabled = (notificationsLevel !== 'off');
        AndroidApp.setNotificationsEnabled(enabled);
      }
    });
  }
  
  // Filtros de cambio
  timeFilter.addEventListener('change', () => {
    updateUI();
  });
  
  magFilter.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    magValDisplay.textContent = `${val.toFixed(1)} M`;
    updateUI();
  });
  
  resetBtn.addEventListener('click', () => {
    magFilter.value = 0.0;
    magValDisplay.textContent = '0.0 M';
    timeFilter.value = '30d';
    updateUI();
  });
}

function updateNotificationBtn() {
  const notifBtn = document.getElementById('notification-toggle-btn');
  const notifBtnText = document.getElementById('notif-btn-text');
  if (!notifBtn) return;
  
  notifBtn.classList.remove('active', 'accent-important', 'accent-all');
  
  if (notificationsLevel === 'off') {
    if (notifBtnText) notifBtnText.textContent = "Silenciado";
  } else if (notificationsLevel === 'important') {
    notifBtn.classList.add('active', 'accent-important');
    if (notifBtnText) notifBtnText.textContent = "Alertas > 4.0";
  } else if (notificationsLevel === 'all') {
    notifBtn.classList.add('active', 'accent-all');
    if (notifBtnText) notifBtnText.textContent = "Todos los Sismos";
  }
}

// --- ACTUALIZAR ESTADO DE CONEXIÓN ---
function updateConnectionStatus(isOnline) {
  const dot = document.querySelector('.connection-status .status-dot');
  const text = document.querySelector('.connection-status .status-text');
  const bar = document.querySelector('.connection-status');
  
  if (!dot || !text || !bar) return;
  
  if (isOnline) {
    dot.className = 'status-dot online';
    text.textContent = 'MONITOREANDO EN VIVO';
    text.style.color = '';
    bar.style.background = '';
    bar.style.borderColor = '';
  } else {
    dot.className = 'status-dot offline';
    text.textContent = 'SIN CONEXIÓN - REINTENTANDO';
    text.style.color = 'var(--accent-red)';
    bar.style.background = 'rgba(255, 59, 48, 0.05)';
    bar.style.borderColor = 'rgba(255, 59, 48, 0.15)';
  }
}

// --- MOSTRAR MENSAJE OFFLINE EN LA LISTA ---
function showOfflineMessage() {
  const listEl = document.getElementById('earthquake-list');
  if (listEl) {
    listEl.innerHTML = `
      <div class="list-placeholder">
        <p>No se pudo conectar con el USGS ni FUNVISIS (Sin conexión). Puedes simular sismos haciendo clic en el mapa.</p>
      </div>
    `;
  }
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
  
  map.on('click', (e) => {
    if (!isSimulationMode) return;
    const { lat, lng } = e.latlng;
    
    // Crear cuadro modal flotante para ingresar magnitud y profundidad
    const popupContent = `
      <div class="sim-modal">
        <h3>Simular Terremoto</h3>
        <div class="sim-form-group">
          <label>Magnitud:</label>
          <input type="number" id="sim-mag" value="5.0" min="1.0" max="9.0" step="0.1">
        </div>
        <div class="sim-form-group">
          <label>Profundidad (km):</label>
          <input type="number" id="sim-depth" value="10" min="0" max="700">
        </div>
        <button id="sim-trigger-btn" class="btn-sim-trigger">Generar Sismo</button>
      </div>
    `;
    
    L.popup()
      .setLatLng([lat, lng])
      .setContent(popupContent)
      .openOn(map);
      
    // Escuchar el clic de confirmación en el popup generado
    setTimeout(() => {
      const triggerBtn = document.getElementById('sim-trigger-btn');
      if (triggerBtn) {
        triggerBtn.addEventListener('click', () => {
          const mag = parseFloat(document.getElementById('sim-mag').value) || 5.0;
          const depth = parseFloat(document.getElementById('sim-depth').value) || 10.0;
          triggerSimulatedEarthquake(lat, lng, mag, depth);
          map.closePopup();
        });
      }
    }, 100);
  });
}

function toggleSimulationMode() {
  const simulateBtn = document.getElementById('simulate-btn');
  const overlay = document.getElementById('simulation-overlay');
  
  simulateBtn.classList.toggle('active', isSimulationMode);
  overlay.classList.toggle('hidden', !isSimulationMode);
  
  if (isSimulationMode) {
    map.getContainer().style.cursor = 'crosshair';
  } else {
    map.getContainer().style.cursor = '';
  }
}

function triggerSimulatedEarthquake(lat, lon, mag, depth) {
  const simId = `sim-${Date.now()}`;
  let place = `Sismo Simulado a ${lat.toFixed(2)}°N, ${Math.abs(lon).toFixed(2)}°W`;
  
  // Agregar nombres reconocibles a epicentros simulados clave
  if (lat > 10.0 && lat < 11.0 && lon > -67.5 && lon < -66.5) {
    place = "Cerca de Caracas, Venezuela (Simulado)";
  } else if (lat > 9.5 && lat < 11.0 && lon > -72.0 && lon < -71.0) {
    place = "Cerca de Maracaibo, Venezuela (Simulado)";
  } else if (lat > 9.5 && lat < 10.5 && lon > -63.5 && lon < -62.5) {
    place = "Cerca de Maturín, Venezuela (Simulado)";
  } else if (lat > 8.0 && lat < 9.0 && lon > -72.5 && lon < -71.5) {
    place = "Cerca de San Cristóbal, Venezuela (Simulado)";
  } else if (lat > 8.0 && lat < 9.0 && lon > -63.0 && lon < -62.0) {
    place = "Cerca de Ciudad Guayana, Venezuela (Simulado)";
  } else if (lat > 9.8 && lat < 10.4 && lon > -69.5 && lon < -69.0) {
    place = "Cerca de Barquisimeto, Venezuela (Simulado)";
  }
  
  const simEvent = {
    id: simId,
    type: "Feature",
    properties: {
      mag: mag,
      place: place,
      time: Date.now(),
      url: "#",
      title: `M ${mag.toFixed(1)} - ${place}`,
      isSimulated: true
    },
    geometry: {
      type: "Point",
      coordinates: [lon, lat, depth]
    }
  };
  
  simulatedEarthquakes.push(simEvent);
  processEarthquakes([simEvent], false);
  triggerRealTimeAlert(simEvent, true);
}

// --- ACTUALIZAR RELOJ Y MARCADOR DE TIEMPO EN CADA POLL ---
let lastUpdateTime = Date.now();
let lastUpdateTimer;

function updateLastUpdatedLabel() {
  const label = document.getElementById('last-updated-label');
  if (!label) return;
  
  const secondsElapsed = Math.round((Date.now() - lastUpdateTime) / 1000);
  if (secondsElapsed <= 1) {
    label.textContent = "(Actualizado ahora)";
  } else {
    label.textContent = `(Actualizado hace ${secondsElapsed}s)`;
  }
}

async function startRealTimePolling() {
  const POLL_MS = 30000; // 30s
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

  await poll();
  setInterval(poll, POLL_MS);
}

// --- BANNER DE DESCARGA DE LA APLICACIÓN ANDROID ---
function initAndroidDownloadBanner() {
  const banner = document.getElementById('android-download-banner');
  const closeBtn = document.getElementById('close-banner-btn');
  const smallBtn = document.getElementById('apk-install-small-btn');
  
  if (!banner || !closeBtn) return;
  
  const isNative = typeof AndroidApp !== 'undefined' && AndroidApp.isNativeApp();
  
  // Ocultar si ya estamos dentro de la app Android nativa o local
  if (window.location.protocol === 'file:' || isNative) {
    banner.classList.add('hidden');
    if (smallBtn) smallBtn.classList.add('hidden');
    return;
  }
  
  // Mostrar si es Android móvil
  const isAndroid = /android/i.test(navigator.userAgent);
  const isMockMode = window.location.search.includes('mock-android'); // Modo pruebas
  
  if (smallBtn) {
    if (isAndroid || isMockMode) {
      smallBtn.classList.remove('hidden');
    } else {
      smallBtn.classList.add('hidden');
    }
  }
  
  const dismissed = localStorage.getItem('android-banner-dismissed') === 'true';
  if ((isAndroid || isMockMode) && !dismissed) {
    banner.classList.remove('hidden');
  }
  
  closeBtn.addEventListener('click', () => {
    banner.classList.add('hidden');
    localStorage.setItem('android-banner-dismissed', 'true');
  });
}

// --- FUNCIÓN DE INICIO PRINCIPAL DE LA APP ---
function initApp() {
  initClock();
  initMap();
  initSimulator();
  initControls();
  initAndroidDownloadBanner();
  
  // Cargar sismos desde localStorage si existen para soporte offline inmediato
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
  
  // Carga inicial integrada (USGS 30d + FUNVISIS)
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
  }).catch(error => {
    isLoading = false;
    updateConnectionStatus(false);
    console.error("Error al cargar sismos iniciales:", error);
    if (earthquakes.length === 0) {
      showOfflineMessage();
    }
  });
  
  // Iniciar polling en tiempo real
  startRealTimePolling();
}

// Ejecutar cuando se cargue la estructura DOM
window.addEventListener('DOMContentLoaded', function() {
  initApp();
});
