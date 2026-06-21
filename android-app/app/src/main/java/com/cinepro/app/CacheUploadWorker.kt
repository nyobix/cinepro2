package com.cinepro.app

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

class CacheUploadWorker(appContext: Context, workerParams: WorkerParameters) : Worker(appContext, workerParams) {
    private val client = OkHttpClient()

    override fun doWork(): Result {
        val mediaId = inputData.getString("mediaId") ?: return Result.failure()
        val payload = inputData.getString("payload") ?: ""

        // Upload payload to Supabase table 'scraped_streams' via REST
        val supabaseUrl = System.getenv("SUPABASE_URL") ?: inputData.getString("SUPABASE_URL")
        val supabaseKey = System.getenv("SUPABASE_KEY") ?: inputData.getString("SUPABASE_KEY")

        if (supabaseUrl.isNullOrBlank() || supabaseKey.isNullOrBlank()) {
            return Result.retry()
        }

        val json = "{" + "\"mediaId\":\"$mediaId\",\"sources\":\"${payload.replace("\"","\\\"")}\"}" 

        try {
            val req = Request.Builder()
                .url(supabaseUrl.trimEnd('/') + "/rest/v1/scraped_streams")
                .post(json.toRequestBody("application/json".toMediaTypeOrNull()))
                .addHeader("apikey", supabaseKey)
                .addHeader("Authorization", "Bearer $supabaseKey")
                .addHeader("Prefer","return=minimal")
                .build()

            val resp = client.newCall(req).execute()
            if (!resp.isSuccessful) {
                return Result.retry()
            }
            return Result.success()
        } catch (e: Exception) {
            return Result.retry()
        }
    }
}
