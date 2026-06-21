package com.cinepro.app

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView

class MainActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        val searchInput = findViewById<EditText>(R.id.search_input)
        val searchBtn = findViewById<Button>(R.id.search_btn)
        val list = findViewById<RecyclerView>(R.id.results_list)

        list.layoutManager = LinearLayoutManager(this)
        val adapter = SourcesAdapter { sourceUrl ->
            val intent = Intent(this, PlayerActivity::class.java)
            intent.putExtra("source_url", sourceUrl)
            startActivity(intent)
        }
        list.adapter = adapter

        searchBtn.setOnClickListener {
            val query = searchInput.text.toString().trim()
            if (query.isNotEmpty()) {
                // Run scraping in background thread
                Thread {
                    val sources = ScraperManager.search(query)
                    runOnUiThread {
                        adapter.update(sources)
                        // schedule background upload
                        UploadScheduler.enqueueCacheUpload(this, query, sources)
                    }
                }.start()
            }
        }
    }
}
