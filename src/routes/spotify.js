'use client'
import { useState, useEffect, useRef } from 'react'
import { getSpotifyToken, getSpotifyPlaylists, getSpotifyLoginUrl, spotifyPlay } from '../../lib/api'

export default function SpotifyPlayer({ accentColor, isOwner }) {
  const [player, setPlayer] = useState(null)
  const [deviceId, setDeviceId] = useState(null)
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [currentTrack, setCurrentTrack] = useState(null)
  const [playlists, setPlaylists] = useState([])
  const [showPlaylists, setShowPlaylists] = useState(false)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [connecting, setConnecting] = useState(false)
  const progressInterval = useRef(null)

  useEffect(function() {
    if (!isOwner) return

    const script = document.createElement('script')
    script.src = 'https://sdk.scdn.co/spotify-player.js'
    script.async = true
    document.body.appendChild(script)

    window.onSpotifyWebPlaybackSDKReady = async function() {
      const tokenData = await getSpotifyToken().catch(function() { return null })
      if (!tokenData?.token) return

      const spotifyPlayer = new window.Spotify.Player({
        name: 'Blue Room',
        getOAuthToken: async function(cb) {
          const data = await getSpotifyToken().catch(function() { return null })
          if (data?.token) cb(data.token)
        },
        volume: 0.7,
      })

      spotifyPlayer.addListener('ready', function(data) {
        setDeviceId(data.device_id)
        setReady(true)
      })

      spotifyPlayer.addListener('player_state_changed', function(state) {
        if (!state) return
        setCurrentTrack(state.track_window.current_track)
        setPlaying(!state.paused)
        setProgress(state.position)
        setDuration(state.duration)
      })

      spotifyPlayer.connect()
      setPlayer(spotifyPlayer)
    }

    return function() {
      if (player) player.disconnect()
    }
  }, [isOwner])

  useEffect(function() {
    if (playing) {
      progressInterval.current = setInterval(function() {
        setProgress(function(p) { return p + 1000 })
      }, 1000)
    } else {
      clearInterval(progressInterval.current)
    }
    return function() { clearInterval(progressInterval.current) }
  }, [playing])

  async function handleConnect() {
    setConnecting(true)
    try {
      const data = await getSpotifyLoginUrl()
      if (data?.url) window.location.href = data.url
    } catch {}
    setConnecting(false)
  }

  async function loadPlaylists() {
    setLoading(true)
    try {
      const data = await getSpotifyPlaylists()
      console.log('Playlists data:', data)
      const items = data?.items || data?.playlists?.items || []
      setPlaylists(items)
      setShowPlaylists(true)
    } catch (err) {
      console.error('Playlists error:', err)
    }
    setLoading(false)
  }

  async function playPlaylist(uri) {
    if (!deviceId) return
    try {
      await spotifyPlay(deviceId, uri, null)
      setShowPlaylists(false)
    } catch {}
  }

  function togglePlay() {
    if (!player) return
    player.togglePlay()
  }

  function skipNext() {
    if (!player) return
    player.nextTrack()
  }

  function skipPrev() {
    if (!player) return
    player.previousTrack()
  }

  function formatTime(ms) {
    if (!ms) return '0:00'
    const s = Math.floor(ms / 1000)
    const m = Math.floor(s / 60)
    const sec = s % 60
    return m + ':' + (sec < 10 ? '0' : '') + sec
  }

  if (!isOwner) return null

  const progressPct = duration ? (progress / duration) * 100 : 0

  // Not connected / not ready — show connect button with dimmed player
  if (!ready) {
    return (
      <div
        className="rounded-2xl p-5 mb-4 border backdrop-blur-sm"
        style={{ background: 'rgba(0,0,0,0.5)', borderColor: '#1DB95444' }}
      >
        <div className="flex items-center gap-2 mb-4">
          <span style={{ color: '#1DB954' }}>🎵</span>
          <span className="text-xs font-mono" style={{ color: '#1DB954' }}>spotify player</span>
        </div>
        <div className="text-center py-2 mb-4">
          <div className="text-dim text-xs font-mono mb-4">
            connect spotify to play music in your bedroom
          </div>
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="px-6 py-2 rounded-full text-sm font-semibold text-white transition-all disabled:opacity-50"
            style={{ background: '#1DB954' }}
          >
            {connecting ? '...' : 'connect spotify'}
          </button>
        </div>
        <div className="flex items-center justify-center gap-6 opacity-20 pointer-events-none">
          <span className="text-lg">⏮</span>
          <div
            className="w-12 h-12 rounded-full flex items-center justify-center text-white text-xl"
            style={{ background: '#1DB954' }}
          >
            ▶
          </div>
          <span className="text-lg">⏭</span>
        </div>
      </div>
    )
  }

  return (
    <div
      className="rounded-2xl p-5 mb-4 border backdrop-blur-sm"
      style={{ background: 'rgba(0,0,0,0.5)', borderColor: '#1DB95444' }}
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span style={{ color: '#1DB954' }}>🎵</span>
          <span className="text-xs font-mono" style={{ color: '#1DB954' }}>
            spotify player
          </span>
          <span className="text-xs font-mono text-success bg-success/10 px-2 py-0.5 rounded-full">
            ready
          </span>
        </div>
        <button
          onClick={loadPlaylists}
          disabled={loading}
          className="text-xs font-mono text-muted hover:text-soft transition-colors border border-border rounded-full px-3 py-1"
        >
          {loading ? '...' : '📋 playlists'}
        </button>
      </div>

      {currentTrack ? (
        <div className="flex items-center gap-3 mb-4">
          {currentTrack.album?.images?.[0] && (
            <img
              src={currentTrack.album.images[0].url}
              alt="album"
              className="w-14 h-14 flex-shrink-0 object-cover"
              style={{
                animation: playing ? 'spin 8s linear infinite' : 'none',
                borderRadius: playing ? '50%' : '8px',
                transition: 'border-radius 0.5s',
              }}
            />
          )}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-soft truncate">{currentTrack.name}</div>
            <div className="text-xs text-muted truncate">
              {currentTrack.artists?.map(function(a) { return a.name }).join(', ')}
            </div>
          </div>
        </div>
      ) : (
        <div className="text-xs font-mono text-dim mb-4 text-center py-4">
          pick a playlist to start playing
        </div>
      )}

      {currentTrack && (
        <div className="mb-3">
          <div className="h-1 rounded-full overflow-hidden mb-1" style={{ background: 'rgba(255,255,255,0.1)' }}>
            <div
              className="h-full rounded-full transition-all"
              style={{ width: progressPct + '%', background: '#1DB954' }}
            />
          </div>
          <div className="flex justify-between text-xs font-mono text-dim">
            <span>{formatTime(progress)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>
      )}

      <div className="flex items-center justify-center gap-6">
        <button onClick={skipPrev} className="text-muted hover:text-soft transition-colors text-lg">⏮</button>
        <button
          onClick={togglePlay}
          className="w-12 h-12 rounded-full flex items-center justify-center text-white text-xl transition-all hover:scale-105"
          style={{ background: '#1DB954' }}
        >
          {playing ? '⏸' : '▶'}
        </button>
        <button onClick={skipNext} className="text-muted hover:text-soft transition-colors text-lg">⏭</button>
      </div>

      {showPlaylists && (
        <div className="mt-4 border-t border-border pt-4">
          <div className="text-xs font-mono text-dim mb-3">
            your playlists {playlists.length === 0 ? '(none found)' : '(' + playlists.length + ')'}
          </div>
          {playlists.length === 0 ? (
            <div className="text-xs text-dim font-mono text-center py-4">
              no playlists found — check console for details
            </div>
          ) : (
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {playlists.map(function(playlist) {
                return (
                  <button
                    key={playlist.id}
                    onClick={function() { playPlaylist(playlist.uri) }}
                    className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-white/5 transition-colors text-left"
                  >
                    {playlist.images && playlist.images[0] && (
                      <img
                        src={playlist.images[0].url}
                        alt="playlist"
                        className="w-8 h-8 rounded flex-shrink-0"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-mono text-soft truncate">{playlist.name}</div>
                      <div className="text-xs text-dim">{playlist.tracks?.total} tracks</div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}