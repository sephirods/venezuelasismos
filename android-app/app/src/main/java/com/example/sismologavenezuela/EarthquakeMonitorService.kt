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
    // Buscar últimas 2 horas (más eficiente que 24h y suficiente para tiempo real)
    val starttime = df.format(Date(System.currentTimeMillis() - 2 * 60 * 60 * 1000))

    val url = "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson" +
        "&minlatitude=0.0&maxlatitude=16.0&minlongitude=-74.0&maxlongitude=-58.0" +
        "&starttime=$starttime"

    val conn = URL(url).openConnection() as HttpURLConnection
    conn.requestMethod = "GET"
    conn.connectTimeout = 10000
    conn.readTimeout = 10000

    if (conn.responseCode != 200) {
      Log.w(TAG, "USGS HTTP ${conn.responseCode}")
      conn.disconnect()
      return
    }

    val response = InputStreamReader(conn.inputStream).use { it.readText() }
    conn.disconnect()

    val features = JSONObject(response).optJSONArray("features") ?: return

    val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    val isFirstRun = !prefs.getBoolean(KEY_FIRST_RUN, false)
    val seenIds = prefs.getStringSet(KEY_SEEN_IDS, emptySet())?.toMutableSet() ?: mutableSetOf()
    val newSeenIds = seenIds.toMutableSet()
    var notified = 0

    val featureList = (0 until features.length())
      .map { features.getJSONObject(it) }
      .sortedBy { it.getJSONObject("properties").optLong("time", 0) }

    for (feature in featureList) {
      val id = feature.optString("id").takeIf { it.isNotBlank() } ?: continue
      if (seenIds.contains(id)) continue

      val props = feature.getJSONObject("properties")
      val mag = props.optDouble("mag", 0.0)
      val place = props.optString("place", "Venezuela")

      newSeenIds.add(id)

      // Primera ejecución: solo guardamos IDs sin notificar (evitar spam inicial)
      if (!isFirstRun) {
        showAlertNotification(id, mag, place)
        notified++
        Log.d(TAG, "🚨 Nuevo sismo: M$mag - $place")
      }
    }

    val idsToSave = if (newSeenIds.size > MAX_SEEN_IDS)
      newSeenIds.toList().takeLast(MAX_SEEN_IDS).toSet()
    else newSeenIds

    prefs.edit()
      .putStringSet(KEY_SEEN_IDS, idsToSave)
      .putBoolean(KEY_FIRST_RUN, true)
      .apply()

    if (notified > 0) Log.d(TAG, "$notified notificaciones enviadas")
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
      .setContentText("Monitoreando sismos cada 60 segundos")
      .setContentIntent(pendingIntent)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setOngoing(true) // No se puede deslizar para cerrar
      .setSilent(true)
      .build()
  }

  private fun showAlertNotification(id: String, mag: Double, place: String) {
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
        .bigText("📍 $place\n📊 Magnitud $magStr • Fuente: USGS")
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
