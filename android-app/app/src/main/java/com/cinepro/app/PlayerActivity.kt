package com.cinepro.app

import android.net.Uri
import android.os.Bundle
import android.widget.Button
import android.widget.SeekBar
import androidx.appcompat.app.AppCompatActivity
import com.google.android.exoplayer2.ExoPlayer
import com.google.android.exoplayer2.MediaItem
import com.google.android.exoplayer2.ui.PlayerView

class PlayerActivity : AppCompatActivity() {
    private var player: ExoPlayer? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_player)

        val playerView = findViewById<PlayerView>(R.id.player_view)
        val speedBar = findViewById<SeekBar>(R.id.speed_bar)
        val downloadBtn = findViewById<Button>(R.id.download_btn)

        val source = intent.getStringExtra("source_url") ?: return

        player = ExoPlayer.Builder(this).build()
        playerView.player = player

        val mediaItem = MediaItem.fromUri(Uri.parse(source))
        player?.setMediaItem(mediaItem)
        player?.prepare()
        player?.play()

        speedBar.max = 400
        speedBar.progress = 100
        speedBar.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                val speed = progress / 100.0f
                player?.playbackParameters = player?.playbackParameters?.withSpeed(speed) ?: com.google.android.exoplayer2.PlaybackParameters(speed)
            }

            override fun onStartTrackingTouch(seekBar: SeekBar?) {}
            override fun onStopTrackingTouch(seekBar: SeekBar?) {}
        })

        downloadBtn.setOnClickListener {
            // simple download via background worker
            DownloadManager.enqueueDownload(this, source)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        player?.release()
        player = null
    }
}
