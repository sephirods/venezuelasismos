package com.example.sismologavenezuela

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

class EarthquakeMonitorService : Service() {

  companion object {
    private const val TAG = "EarthquakeMonitor"
    private const val MONITOR_NOTIF_ID = 1001
    private const val CHANNEL_MONITOR_ID = "earthquake_monitor"
    private const val CHANNEL_ALERT_ID = "earthquake_alerts"
    private const val PREFS_NAME = "EarthquakePrefs"
    private const val KEY_SEEN_IDS = "seen_ids"
    private const val KEY_FIRST_RUN = "first_run_done"
    private const val POLL_INTERVAL_MS = 60_000L // 60 segundos
    private const val MAX_SEEN_IDS = 500

    fun start(context: Context) {
      val intent = Intent(context, EarthquakeMonitorService::class.java)
      ContextCompat.startForegroundService(context, intent)
      Log.d(TAG, "Servicio de monitoreo iniciado")
    }
  }

  private val job = SupervisorJob()
  private val scope = CoroutineScope(Dispatchers.IO + job)

  override fun onCreate() {
    super.onCreate()
    createNotificationChannels()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    startForeground(MONITOR_NOTIF_ID, buildMonitorNotification())
    scope.launch {
      Log.d(TAG, "Loop de monitoreo iniciado — revisando cada ${POLL_INTERVAL_MS / 1000}s")
      while (true) {
        try {
          checkForEarthquakes()
        } catch (e: Exception) {
          Log.e(TAG, "Error en poll: ${e.message}")
        }
        delay(POLL_INTERVAL_MS)
      }
    }
    // START_STICKY: Android reinicia el servicio automáticamente si lo mata por RAM
    return START_STICKY
  }

  override fun onBind(intent: Intent?) = null

  override fun onDestroy() {
    super.onDestroy()
    job.cancel()
    Log.d(TAG, "Servicio destruido")
  }

  // ─── Lógica de consulta USGS ───────────────────────────────────────────────

  private fun checkForEarthquakes() {
    val tz = TimeZone.getTimeZone("UTC")
    val df = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply { timeZone = tz }
    val starttime = df.format(Date(System.currentTimeMillis() - 2 * 60 * 60 * 1000))

    val emscUrl = "https://www.seismicportal.eu/fdsnws/event/1/query?format=json" +
        "&minlat=0.0&maxlat=16.0&minlon=-74.0&maxlon=-58.0" +
        "&starttime=$starttime"

    val usgsUrl = "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson" +
        "&minlatitude=0.0&maxlatitude=16.0&minlongitude=-74.0&maxlongitude=-58.0" +
        "&starttime=$starttime"

    val emscSismos = fetchFromUrl(emscUrl, isEmsc = true)
    val usgsSismos = fetchFromUrl(usgsUrl, isEmsc = false)
    val funvisisSismos = fetchFromUrl("https://forjadigitales.com/sismos_venezuela.json", isEmsc = false)

    val allSismos = (emscSismos + usgsSismos + funvisisSismos).sortedBy { it.time }

    val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val isFirstRun = !prefs.getBoolean(KEY_FIRST_RUN, false)
    val seenIds = prefs.getStringSet(KEY_SEEN_IDS, emptySet())?.toMutableSet() ?: mutableSetOf()
    
    val seenInfoSet = prefs.getStringSet("seen_sismos_info", emptySet()) ?: emptySet()
    val seenSismosList = seenInfoSet.mapNotNull { str ->
      val parts = str.split("|")
      if (parts.size >= 4) {
        MonitorSismo(
          id = parts[0],
          time = parts[1].toLongOrNull() ?: 0L,
          lat = parts[2].toDoubleOrNull() ?: 0.0,
          lon = parts[3].toDoubleOrNull() ?: 0.0,
          mag = 0.0,
          place = "",
          source = ""
        )
      } else null
    }.toMutableList()

    val newSeenIds = seenIds.toMutableSet()
    val newSeenSismosList = seenSismosList.toMutableList()
    var notified = 0
    val notificationsState = prefs.getString("notifications_state", "all") ?: "all"

    for (sismo in allSismos) {
      if (seenIds.contains(sismo.id)) continue
      
      if (isDuplicate(sismo, newSeenSismosList)) {
        newSeenIds.add(sismo.id)
        continue
      }

      newSeenIds.add(sismo.id)
      newSeenSismosList.add(sismo)

      if (!isFirstRun) {
        val ageMinutes = (System.currentTimeMillis() - sismo.time) / 60000.0
        if (ageMinutes > 10.0 && sismo.mag < 4.0) {
          Log.d(TAG, "Sismo antiguo detectado tarde en background (${String.format(Locale.US, "%.1f", ageMinutes)} min), omitiendo alerta: M${sismo.mag} - ${sismo.place}")
          continue
        }

        val shouldAlert = (notificationsState == "all") || (notificationsState == "important" && sismo.mag >= 4.0)
        if (shouldAlert) {
          showAlertNotification(sismo.id, sismo.mag, sismo.place, sismo.source)
          notified++
          Log.d(TAG, "🚨 Nuevo sismo (${sismo.source}): M${sismo.mag} - ${sismo.place}")
        } else {
          Log.d(TAG, "Sismo omitido por filtro (Importantes): M${sismo.mag} - ${sismo.place}")
        }
      }
    }

    val idsToSave = if (newSeenIds.size > MAX_SEEN_IDS)
      newSeenIds.toList().takeLast(MAX_SEEN_IDS).toSet()
    else newSeenIds

    val sismosToSave = if (newSeenSismosList.size > MAX_SEEN_IDS)
      newSeenSismosList.takeLast(MAX_SEEN_IDS)
    else newSeenSismosList

    val infoSetToSave = sismosToSave.map { "${it.id}|${it.time}|${it.lat}|${it.lon}" }.toSet()

    prefs.edit()
      .putStringSet(KEY_SEEN_IDS, idsToSave)
      .putStringSet("seen_sismos_info", infoSetToSave)
      .putBoolean(KEY_FIRST_RUN, true)
      .apply()

    if (notified > 0) Log.d(TAG, "$notified notificaciones enviadas")
  }

  private fun isDuplicate(sismo: MonitorSismo, list: List<MonitorSismo>): Boolean {
    for (item in list) {
      val timeDiff = Math.abs(item.time - sismo.time)
      val latDiff = Math.abs(item.lat - sismo.lat)
      val lonDiff = Math.abs(item.lon - sismo.lon)
      if (timeDiff < 10 * 60 * 1000 && latDiff < 0.5 && lonDiff < 0.5) {
        return true
      }
    }
    return false
  }

  private fun fetchFromUrl(urlStr: String, isEmsc: Boolean): List<MonitorSismo> {
    val list = mutableListOf<MonitorSismo>()
    var conn: HttpURLConnection? = null
    try {
      val url = URL(urlStr)
      conn = url.openConnection() as HttpURLConnection
      conn.requestMethod = "GET"
      conn.connectTimeout = 10000
      conn.readTimeout = 10000

      if (conn.responseCode != 200) {
        Log.w(TAG, "${if (isEmsc) "EMSC" else "USGS"} HTTP ${conn.responseCode}")
        return emptyList()
      }

      val response = InputStreamReader(conn.inputStream).use { it.readText() }
      val features = JSONObject(response).optJSONArray("features") ?: return emptyList()

      for (i in 0 until features.length()) {
        val feature = features.getJSONObject(i)
        val props = feature.optJSONObject("properties") ?: continue
        
        val id = feature.optString("id").takeIf { it.isNotBlank() }
          ?: props.optString("unid").takeIf { it.isNotBlank() }
          ?: continue

        val mag = props.optDouble("mag", 0.0)
        
        val place = if (isEmsc) {
          props.optString("flynn_region", "Venezuela")
        } else {
          props.optString("place", "Venezuela")
        }

        val timeMs = if (isEmsc) {
          val timeStr = props.optString("time")
          try {
            val dfIso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply {
              timeZone = TimeZone.getTimeZone("UTC")
            }
            dfIso.parse(timeStr.substring(0, 19))?.time ?: System.currentTimeMillis()
          } catch (e: Exception) {
            System.currentTimeMillis()
          }
        } else {
          props.optLong("time", System.currentTimeMillis())
        }

        val geom = feature.optJSONObject("geometry") ?: continue
        val coords = geom.optJSONArray("coordinates") ?: continue
        if (coords.length() < 2) continue
        val lon = coords.optDouble(0)
        val lat = coords.optDouble(1)

        val source = if (isEmsc) {
          val auth = props.optString("auth").takeIf { it.isNotBlank() } ?: "EMSC"
          "$auth (Preliminar)"
        } else if (props.optBoolean("isFunvisis", false)) {
          "FUNVISIS"
        } else {
          "USGS"
        }

        list.add(MonitorSismo(id, mag, place, timeMs, lat, lon, source))
      }
    } catch (e: Exception) {
      Log.e(TAG, "Error consultando ${if (isEmsc) "EMSC" else "USGS"}: ${e.message}")
    } finally {
      conn?.disconnect()
    }
    return list
  }

  // ─── Notificaciones ────────────────────────────────────────────────────────

  private fun createNotificationChannels() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val nm = getSystemService(NotificationManager::class.java)

      // Canal persistente de monitoreo (baja importancia → no hace sonido)
      nm.createNotificationChannel(NotificationChannel(
        CHANNEL_MONITOR_ID,
        "Monitoreo de Sismos",
        NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "Servicio en segundo plano de SismologíaVE"
        setShowBadge(false)
      })

      // Canal de alertas (alta importancia → sonido + vibración)
      val soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
      val audioAttrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ALARM)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()

      nm.createNotificationChannel(NotificationChannel(
        CHANNEL_ALERT_ID,
        "Alertas de Sismos",
        NotificationManager.IMPORTANCE_HIGH
      ).apply {
        description = "Alertas en tiempo real de terremotos en Venezuela"
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 500, 150, 500, 150, 800)
        setSound(soundUri, audioAttrs)
        enableLights(true)
        lightColor = 0xFFFF3B30.toInt()
        setShowBadge(true)
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC // Visible en pantalla bloqueada
      })
    }
  }

  private fun buildMonitorNotification(): Notification {
    val pendingIntent = PendingIntent.getActivity(
      this, 0,
      Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_IMMUTABLE
    )
    return NotificationCompat.Builder(this, CHANNEL_MONITOR_ID)
      .setSmallIcon(android.R.drawable.stat_sys_warning)
      .setContentTitle("🌎 SismologíaVE activo")
      .setContentText("Monitoreando sismos")
      .setContentIntent(pendingIntent)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setOngoing(true) // No se puede deslizar para cerrar
      .setSilent(true)
      .build()
  }

  private fun showAlertNotification(id: String, mag: Double, place: String, source: String) {
    val intent = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
      putExtra("event_id", id)
    }
    val pendingIntent = PendingIntent.getActivity(
      this, id.hashCode(), intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    val emoji = when {
      mag >= 7.0 -> "🚨🚨🚨"
      mag >= 6.0 -> "🚨🚨"
      mag >= 5.0 -> "🚨"
      mag >= 4.0 -> "⚠️"
      mag >= 3.0 -> "📳"
      else       -> "📡"
    }
    val magStr = String.format(Locale.US, "%.1f", mag)
    val title = "$emoji Magnitud $magStr — Sismo en Venezuela"

    val soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)

    val notification = NotificationCompat.Builder(this, CHANNEL_ALERT_ID)
      .setSmallIcon(android.R.drawable.stat_sys_warning)
      .setContentTitle(title)
      .setContentText("📍 $place")
      .setStyle(NotificationCompat.BigTextStyle()
        .bigText("📍 $place\n📊 Magnitud $magStr • Fuente: $source")
        .setBigContentTitle(title))
      .setPriority(NotificationCompat.PRIORITY_MAX) // Máxima prioridad
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setContentIntent(pendingIntent)
      .setAutoCancel(true)
      .setVibrate(longArrayOf(0, 500, 150, 500, 150, 800))
      .setSound(soundUri)
      .setDefaults(NotificationCompat.DEFAULT_LIGHTS)
      .build()

    try {
      NotificationManagerCompat.from(this).notify(id.hashCode(), notification)
    } catch (e: SecurityException) {
      Log.e(TAG, "Sin permiso POST_NOTIFICATIONS: ${e.message}")
    }
  }
}

data class MonitorSismo(
  val id: String,
  val mag: Double,
  val place: String,
  val time: Long,
  val lat: Double,
  val lon: Double,
  val source: String
)
