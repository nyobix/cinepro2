package com.cinepro.app

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

object ProviderLoader {
    private const val PREFS = "provider_prefs"
    private const val KEY_CONFIGS = "provider_configs_json"
    private const val KEY_REMOTE_URL = "provider_remote_url"

    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    fun getRemoteConfigUrl(): String? {
        if (!::prefs.isInitialized) return null
        return prefs.getString(KEY_REMOTE_URL, null)
    }

    fun setRemoteConfigUrl(url: String) {
        if (!::prefs.isInitialized) return
        prefs.edit().putString(KEY_REMOTE_URL, url).apply()
    }

    fun getProviders(): List<ProviderConfig> {
        if (!::prefs.isInitialized) return builtInDefaults()
        val json = prefs.getString(KEY_CONFIGS, null) ?: return builtInDefaults()
        return try {
            val arr = JSONArray(json)
            val out = mutableListOf<ProviderConfig>()
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                out.add(fromJson(o))
            }
            out
        } catch (e: Exception) {
            builtInDefaults()
        }
    }

    fun saveProvidersJson(json: String) {
        if (!::prefs.isInitialized) return
        prefs.edit().putString(KEY_CONFIGS, json).apply()
    }

    private fun fromJson(o: JSONObject): ProviderConfig {
        val id = o.optString("id")
        val name = o.optString("name")
        val baseUrl = o.optString("baseUrl")
        val type = o.optString("type")
        val embedTemplate = o.optString("embedTemplate", null)
        val apiTemplate = o.optString("apiTemplate", null)
        val headers = mutableMapOf<String, String>()
        val hdrObj = o.optJSONObject("headers")
        if (hdrObj != null) {
            val keys = hdrObj.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                headers[k] = hdrObj.optString(k)
            }
        }
        val regexes = mutableListOf<String>()
        val rArr = o.optJSONArray("streamRegexes")
        if (rArr != null) {
            for (i in 0 until rArr.length()) regexes.add(rArr.optString(i))
        }
        val nested = mutableListOf<String>()
        val nArr = o.optJSONArray("nestedDomains")
        if (nArr != null) {
            for (i in 0 until nArr.length()) nested.add(nArr.optString(i))
        }
        return ProviderConfig(id, name, baseUrl, type, embedTemplate, apiTemplate, headers, regexes, nested)
    }

    private fun builtInDefaults(): List<ProviderConfig> {
        val vix = ProviderConfig(
            id = "vixsrc",
            name = "VixSrc",
            baseUrl = "https://vixsrc.to",
            type = "api",
            embedTemplate = null,
            apiTemplate = "/api/movie/{id}",
            headers = mapOf("Referer" to "https://vixsrc.to"),
            streamRegexes = listOf("https?:\\/\\/[^\\\"'\\s]+?(?:\\.m3u8|\\.mp4)[^\\\"'\\s]*"),
            nestedDomains = listOf("vixsrc.to")
        )

        val vidsrc = ProviderConfig(
            id = "vidsrc",
            name = "VidSrc",
            baseUrl = "https://vsembed.ru",
            type = "embed",
            embedTemplate = "/embed/{type}?tmdb={id}",
            apiTemplate = null,
            headers = mapOf("Referer" to "https://vsembed.ru"),
            streamRegexes = listOf("https?:\\/\\/[^\\\"'\\s]+?(?:\\.m3u8|\\.mp4)[^\\\"'\\s]*"),
            nestedDomains = listOf("vsembed.ru", "vidsrc.to")
        )

        return listOf(vidsrc, vix)
    }
}
