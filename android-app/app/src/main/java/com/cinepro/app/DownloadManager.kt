package com.cinepro.app

import android.content.Context
import androidx.work.*
import java.util.concurrent.TimeUnit

object DownloadManager {
    fun enqueueDownload(context: Context, url: String) {
        val data = Data.Builder().putString("url", url).build()
        val req = OneTimeWorkRequestBuilder<DownloadWorker>().setInputData(data).build()
        WorkManager.getInstance(context).enqueue(req)
    }
}
