package com.example.sismologavenezuela

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

class EarthquakeWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

  companion object {
    private const val TAG = "EarthquakeWorker"
    private const val PREFS_NAME = "EarthquakePrefs"
    private const val KEY_SEEN_IDS = "seen_ids"
    private const val KEY_FIRST_RUN = "first_run_done"
    private const val CHANNEL_ID = "earthquake_alerts"
    private const val MAX_SEEN_IDS = 500 // Evitar que crezca infinitamente
  }

  override suspend fun doWork(): Result {
    Log.d(TAG, "doWork() iniciado")
    return try {
      // 1. Obtener datos USGS (últimas 24 horas en Venezuela y alrededores)
      val tz = TimeZone.getTimeZone("UTC")
      val df = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply { timeZone = tz }
      val starttime = df.format(Date(System.currentTimeMillis() - 24 * 60 * 60 * 1000))

      val urlString = "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson" +
          "&minlatitude=0.0&maxlatitude=16.0&minlongitude=-74.0&maxlongitude=-58.0" +
          "&starttime=$starttime"

      Log.d(TAG, "Consultando USGS: $urlString")

      val conn = URL(urlString).openConnection() as HttpURLConnection
      conn.requestMethod = "GET"
      conn.connectTimeout = 15000
      conn.readTimeout = 15000

      if (conn.responseCode != 200) {
        Log.w(TAG, "USGS respondió ${conn.responseCode}, reintentando...")
        return Result.retry()
      }

      val response = BufferedReader(InputStreamReader(conn.inputStream)).use { it.readText() }
      conn.disconnect()

      // 2. Parsear GeoJSON
      val features = JSONObject(response).optJSONArray("features") ?: return Result.success()
      Log.d(TAG, "Sismos encontrados: ${features.length()}")

      // 3. Cargar IDs ya vistos (máx 500)
      val prefs = applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      val isFirstRun = !prefs.getBoolean(KEY_FIRST_RUN, false)
      val seenIds = prefs.getStringSet(KEY_SEEN_IDS, emptySet())?.toMutableSet() ?: mutableSetOf()

      // 4. Construir lista de sismos, ordenados de más antiguo a más nuevo
      val featuresList = (0 until features.length()).map { features.getJSONObject(it) }
        .sortedBy { it.getJSONObject("properties").optLong("time", 0) }

      val newSeenIds = seenIds.toMutableSet()
      var notifiedCount = 0

      // Crear canal de notificaciones ANTES de enviar (solo crea una vez, idempotente)
      createNotificationChannel()

      for (feature in featuresList) {
        val id = feature.optString("id").takeIf { it.isNotBlank() } ?: continue

        if (seenIds.contains(id)) continue // Ya notificado

        val props = feature.getJSONObject("properties")
        val mag = props.optDouble("mag", 0.0)
        val place = props.optString("place", "Venezuela")

        newSeenIds.add(id)

        // En la PRIMERA ejecución solo registramos los IDs sin notificar
        // (para no mandar spam de todos los sismos de las últimas 24h de golpe)
        if (!isFirstRun) {
          Log.d(TAG, "Nuevo sismo: M$mag - $place")
          showNotification(id, mag, place)
          notifiedCount++
        }
      }

      // Guardar estado — limitar a MAX_SEEN_IDS para no crecer infinitamente
      val idsToSave = if (newSeenIds.size > MAX_SEEN_IDS) {
        newSeenIds.toList().takeLast(MAX_SEEN_IDS).toSet()
      } else {
        newSeenIds
      }

      prefs.edit()
        .putStringSet(KEY_SEEN_IDS, idsToSave)
        .putBoolean(KEY_FIRST_RUN, true)
        .apply()

      Log.d(TAG, "Completado. Notificaciones enviadas: $notifiedCount")
      Result.success()

    } catch (e: Exception) {
      Log.e(TAG, "Error en doWork(): ${e.message}", e)
      Result.retry()
    }
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
      val audioAttrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()

      val channel = NotificationChannel(
        CHANNEL_ID,
        "Alertas de Sismos",
        NotificationManager.IMPORTANCE_HIGH // Aparece en pantalla aunque esté bloqueada
      ).apply {
        description = "Notificaciones en tiempo real de terremotos en Venezuela"
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 400, 200, 400, 200, 400) // Patrón intenso
        setSound(soundUri, audioAttrs)
        enableLights(true)
        lightColor = 0xFFFF3B30.toInt() // Rojo sísmico
      }

      val nm = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      nm.createNotificationChannel(channel)
    }
  }

  private fun showNotification(id: String, mag: Double, place: String) {
    val context = applicationContext

    // Intent para abrir la app al tocar la notificación
    val intent = Intent(context, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
      putExtra("event_id", id)
    }
    val pendingIntent = PendingIntent.getActivity(
      context,
      id.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    val soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)

    // Formato del título según severidad
    val emoji = when {
      mag >= 6.0 -> "🚨"
      mag >= 4.5 -> "⚠️"
      mag >= 3.5 -> "📳"
      else -> "📡"
    }
    val title = "$emoji M ${String.format(Locale.US, "%.1f", mag)} - ¡Sismo Detectado!"

    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_warning)
      .setContentTitle(title)
      .setContentText(place)
      .setStyle(NotificationCompat.BigTextStyle().bigText("📍 $place\n📊 Magnitud ${String.format(Locale.US, "%.1f", mag)} — Venezuela y alrededores"))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_ALARM) // Trata como alarma para máxima visibilidad
      .setContentIntent(pendingIntent)
      .setAutoCancel(true)
      .setVibrate(longArrayOf(0, 400, 200, 400, 200, 400))
      .setSound(soundUri)
      .setDefaults(NotificationCompat.DEFAULT_LIGHTS)
      .build()

    try {
      NotificationManagerCompat.from(context).notify(id.hashCode(), notification)
      Log.d(TAG, "Notificación enviada: $title")
    } catch (e: SecurityException) {
      Log.e(TAG, "Sin permiso para notificaciones: ${e.message}")
    }
  }
}
