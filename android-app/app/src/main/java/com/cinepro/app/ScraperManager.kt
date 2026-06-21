package com.cinepro.app

import okhttp3.OkHttpClient
import okhttp3.Request
import org.jsoup.Jsoup

data class StreamSource(val url: String, val quality: String = "Auto")

object ScraperManager {
    private val client = OkHttpClient()

    // Very simple search: treat query as TMDB id or raw provider term
    fun search(query: String): List<StreamSource> {
        val providers = listOf("https://vixsrc.to/embed/movie?tmdb=", "https://vsembed.ru/embed/movie?tmdb=")
        val results = mutableListOf<StreamSource>()

        for (p in providers) {
            val url = if (query.all { it.isDigit() }) p + query else p + query
            try {
                val req = Request.Builder().url(url).header("User-Agent","Mozilla/5.0").build()
                val resp = client.newCall(req).execute()
                if (!resp.isSuccessful) continue
                val body = resp.body?.string() ?: continue
                val doc = Jsoup.parse(body)
                val text = doc.html()
                // naive extraction
                val regex = Regex("https?:\\/\\/[^\"'\\s]+?(?:\\.m3u8|\\.mp4|googlevideo)[^\"'\\s]*")
                val found = regex.findAll(text).map { it.value.replace("\\\"","") }.toSet()
                for (f in found) results.add(StreamSource(f))
            } catch (e: Exception) {
                // continue
            }
        }

        return results
    }
}
