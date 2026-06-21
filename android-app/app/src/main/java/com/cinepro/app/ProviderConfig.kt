package com.cinepro.app

data class ProviderConfig(
    val id: String,
    val name: String,
    val baseUrl: String,
    val type: String, // "embed" or "api"
    val embedTemplate: String?, // e.g. "/embed/{type}?tmdb={id}"
    val apiTemplate: String?, // e.g. "/api/movie/{id}"
    val headers: Map<String, String> = emptyMap(),
    val streamRegexes: List<String> = listOf("https?:\\/\\/[^\\\"'\\s]+?(?:\\.m3u8|\\.mp4|googlevideo)[^\\\"'\\s]*"),
    val nestedDomains: List<String> = emptyList()
)
