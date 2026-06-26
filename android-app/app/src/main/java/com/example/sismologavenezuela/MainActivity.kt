package com.example.sismologavenezuela

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import com.example.sismologavenezuela.ui.main.MainScreen

class MainActivity : ComponentActivity() {

  private val requestPermissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestPermission()
  ) { granted ->
    if (granted) startMonitorService()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    // Renderizar el WebView DIRECTAMENTE — sin NavDisplay ni Surface de Compose
    // para evitar cualquier interferencia de colores de Material3 o insets
    setContent {
      WebViewScreen(modifier = Modifier.fillMaxSize())
    }

    // Iniciar servicio de monitoreo sísmico en segundo plano
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
        != PackageManager.PERMISSION_GRANTED
      ) {
        requestPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
      } else {
        startMonitorService()
      }
    } else {
      startMonitorService()
    }
  }

  private fun startMonitorService() {
    val prefs = getSharedPreferences("EarthquakePrefs", MODE_PRIVATE)
    val enabled = prefs.getBoolean("notifications_enabled", true)
    if (enabled) {
      EarthquakeMonitorService.start(this)
    }
  }
}

@Composable
private fun WebViewScreen(modifier: Modifier = Modifier) {
  // MainScreen ya contiene el WebView con todos los settings correctos
  MainScreen(onItemClick = {}, modifier = modifier)
}
