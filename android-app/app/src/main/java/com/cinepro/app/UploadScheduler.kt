package com.cinepro.app

import android.content.Context
import androidx.work.*
import java.util.concurrent.TimeUnit

object UploadScheduler {
    fun enqueueCacheUpload(context: Context, mediaId: String, sources: List<StreamSource>) {
        val data = Data.Builder()
            .putString("mediaId", mediaId)
            .putString("payload", sources.joinToString(separator = ",") { it.url })
            .build()

        val req = OneTimeWorkRequestBuilder<CacheUploadWorker>()
            .setInputData(data)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
            .build()

        WorkManager.getInstance(context).enqueue(req)
    }
}
