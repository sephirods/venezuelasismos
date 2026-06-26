package com.example.sismologavenezuela.ui.main

import android.annotation.SuppressLint
import android.graphics.Color
import android.util.Log
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.navigation3.runtime.NavKey
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewFeature

import android.view.ViewGroup
import com.example.sismologavenezuela.EarthquakeMonitorService

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun MainScreen(
  onItemClick: (NavKey) -> Unit,
  modifier: Modifier = Modifier
) {
  AndroidView(
    factory = { context ->
      WebView(context).apply {
        layoutParams = ViewGroup.LayoutParams(
          ViewGroup.LayoutParams.MATCH_PARENT,
          ViewGroup.LayoutParams.MATCH_PARENT
        )

        webViewClient = object : WebViewClient() {
          override fun onPageFinished(view: WebView?, url: String?) {
            Log.d("WV", "Loaded: $url")
          }

          override fun shouldOverrideUrlLoading(
            view: WebView?,
            request: android.webkit.WebResourceRequest?
          ): Boolean {
            val url = request?.url?.toString() ?: return false
            if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("tel:") || url.startsWith("mailto:")) {
              try {
                val intent = android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url))
                view?.context?.startActivity(intent)
                return true
              } catch (e: Exception) {
                Log.e("WV", "Error opening external url: $url", e)
              }
            }
            return false
          }
        }

        webChromeClient = object : WebChromeClient() {
          override fun onConsoleMessage(msg: ConsoleMessage?): Boolean {
            Log.d("WV_JS", "${msg?.message()} @ ${msg?.sourceId()}:${msg?.lineNumber()}")
            return true
          }
        }

        settings.apply {
          javaScriptEnabled = true
          domStorageEnabled = true
          @Suppress("DEPRECATION") allowFileAccess = true
          @Suppress("DEPRECATION") allowFileAccessFromFileURLs = true
          @Suppress("DEPRECATION") allowUniversalAccessFromFileURLs = true
          allowContentAccess = true
          mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
          cacheMode = WebSettings.LOAD_DEFAULT
          useWideViewPort = false
          loadWithOverviewMode = false
          setSupportZoom(false)
          builtInZoomControls = false
          displayZoomControls = false
          textZoom = 100
        }

        // Desactivar darkening forzado de Android/Samsung
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
          WebSettingsCompat.setAlgorithmicDarkeningAllowed(settings, false)
        }
        @Suppress("DEPRECATION")
        if (WebViewFeature.isFeatureSupported(WebViewFeature.FORCE_DARK)) {
          WebSettingsCompat.setForceDark(settings, WebSettingsCompat.FORCE_DARK_OFF)
        }

        setBackgroundColor(Color.parseColor("#090b10"))

        addJavascriptInterface(object {
          @android.webkit.JavascriptInterface
          fun isNativeApp(): Boolean = true

          @android.webkit.JavascriptInterface
          fun isNotificationsEnabled(): Boolean {
            val prefs = context.getSharedPreferences("EarthquakePrefs", android.content.Context.MODE_PRIVATE)
            return prefs.getBoolean("notifications_enabled", true)
          }

          @android.webkit.JavascriptInterface
          fun setNotificationsEnabled(enabled: Boolean) {
            val prefs = context.getSharedPreferences("EarthquakePrefs", android.content.Context.MODE_PRIVATE)
            prefs.edit().putBoolean("notifications_enabled", enabled).apply()
            
            val intent = android.content.Intent(context, EarthquakeMonitorService::class.java)
            if (enabled) {
              EarthquakeMonitorService.start(context)
            } else {
              context.stopService(intent)
            }
          }
        }, "AndroidApp")

        post { loadUrl("file:///android_asset/dist/index.html") }
      }
    },

    modifier = modifier.fillMaxSize()
  )
}
