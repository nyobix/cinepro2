package com.cinepro.app

import okhttp3.OkHttpClient
import okhttp3.Request
import org.jsoup.Jsoup

data class StreamSource(val url: String, val quality: String = "Auto")

object ScraperManager {
    private val client = OkHttpClient()

    // Search using runtime provider configs loaded via ProviderLoader
    fun search(query: String): List<StreamSource> {
        val results = mutableListOf<StreamSource>()
        val providers = ProviderLoader.getProviders()

        for (p in providers) {
            val target = buildTargetUrl(p, query) ?: continue
            try {
                val rb = Request.Builder().url(target)
                p.headers.forEach { (k, v) -> rb.header(k, v) }
                rb.header("User-Agent", "Mozilla/5.0")
                val resp = client.newCall(rb.build()).execute()
                if (!resp.isSuccessful) continue
                val body = resp.body?.string() ?: continue
                val doc = Jsoup.parse(body)
                val text = doc.html()
                for (regexStr in p.streamRegexes) {
                    val regex = Regex(regexStr)
                    val found = regex.findAll(text).map { it.value.replace("\\\"", "") }.toSet()
                    for (f in found) results.add(StreamSource(f))
                }
            } catch (e: Exception) {
                // continue on provider failure
            }
        }

        return results
    }

    private fun buildTargetUrl(p: ProviderConfig, query: String): String? {
        val isId = query.all { it.isDigit() }
        return when (p.type) {
            "embed" -> {
                val tmpl = p.embedTemplate ?: return null
                tmpl.replace("{type}", if (isId) "movie" else "movie").replace("{id}", query).let { p.baseUrl.trimEnd('/') + it }
            }
            "api" -> {
                val tmpl = p.apiTemplate ?: return null
                tmpl.replace("{id}", query).let { p.baseUrl.trimEnd('/') + it }
            }
            else -> null
        }
    }
}
