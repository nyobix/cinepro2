package com.cinepro.app

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request

object ProviderUpdater {
    private val client = OkHttpClient()

    /**
     * Fetch provider configs JSON from remote URL and save into SharedPreferences via ProviderLoader.
     * Returns true if saved successfully.
     */
    fun updateFromUrl(context: Context, url: String): Boolean {
        try {
            val req = Request.Builder().url(url).header("User-Agent", "CineProMobile/1.0").build()
            val resp = client.newCall(req).execute()
            if (!resp.isSuccessful) return false
            val body = resp.body?.string() ?: return false
            // validate json minimally
            if (!body.trim().startsWith("[")) return false
            ProviderLoader.init(context)
            ProviderLoader.saveProvidersJson(body)
            return true
        } catch (e: Exception) {
            return false
        }
    }
}
