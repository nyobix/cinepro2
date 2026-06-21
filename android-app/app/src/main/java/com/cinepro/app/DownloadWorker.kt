package com.cinepro.app

import android.content.Context
import android.os.Environment
import androidx.work.Worker
import androidx.work.WorkerParameters
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.FileOutputStream

class DownloadWorker(appContext: Context, workerParams: WorkerParameters) : Worker(appContext, workerParams) {
    private val client = OkHttpClient()

    override fun doWork(): Result {
        val url = inputData.getString("url") ?: return Result.failure()
        try {
            val req = Request.Builder().url(url).build()
            val resp = client.newCall(req).execute()
            if (!resp.isSuccessful) return Result.retry()
            val body = resp.body ?: return Result.retry()

            val storage = applicationContext.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            val file = File(storage, url.hashCode().toString())
            val out = FileOutputStream(file)
            out.use {
                it.write(body.bytes())
            }
            return Result.success()
        } catch (e: Exception) {
            return Result.retry()
        }
    }
}
