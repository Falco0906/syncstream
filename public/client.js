// client.js

// ----- Particle Background -----
const canvas = document.getElementById("bg-canvas");
const ctx = canvas.getContext("2d");
let particles = [];
const numParticles = 75;

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener("resize", resizeCanvas);

class Particle {
  constructor() {
    this.reset();
  }
  reset() {
    this.x = Math.random() * canvas.width;
    this.y = Math.random() * canvas.height;
    this.vx = (Math.random() - 0.5) * 0.5;
    this.vy = (Math.random() - 0.5) * 0.5;
    this.radius = Math.random() * 2 + 1;
  }
  update() {
    this.x += this.vx;
    this.y += this.vy;
    if (this.x < 0 || this.x > canvas.width || this.y < 0 || this.y > canvas.height) {
      this.reset();
    }
  }
  draw() {
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
    ctx.fill();
  }
}
for (let i = 0; i < numParticles; i++) particles.push(new Particle());
function animateParticles() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  particles.forEach(p => {
    p.update();
    p.draw();
  });
  requestAnimationFrame(animateParticles);
}
animateParticles();

// ----- Main Logic -----
const socket = io();
let roomId = null;
let username = null;
let ytPlayer = null;
let ytReady = false;
let ytSuppressEvent = false;
let ytSeekTimeout = null;
let youtubeApiReadyPromise = null;

// YouTube API loader check
if (!window.YT) {
  const tag = document.createElement('script');
  tag.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(tag);
}

// ----- DOM Elements -----
const createRoomBtn = document.getElementById('create-room-btn');
const homeSection = document.getElementById('home-section');
const roomSection = document.getElementById('room-section');
const video = document.getElementById('video');

class Html5PlayerAdapter {
  constructor(videoElement) {
    this.videoElement = videoElement;
    this.boundHandlers = {};
  }

  load(source) {
    const nextSource = typeof source === 'string' ? source : source?.url;
    this.videoElement.style.display = 'block';
    this.videoElement.src = nextSource;
    this.videoElement.load();
  }

  play() {
    return this.videoElement.play();
  }

  pause() {
    this.videoElement.pause();
  }

  seek(time) {
    this.videoElement.currentTime = time;
  }

  getCurrentTime() {
    return this.videoElement.currentTime;
  }

  isPlaying() {
    return !this.videoElement.paused && !this.videoElement.ended;
  }

  destroy() {
    this.pause();
    this.videoElement.removeAttribute('src');
    this.videoElement.load();
    this.videoElement.style.display = 'none';
    this.videoElement.oncanplay = null;
    this.bindEvents({});
  }

  bindEvents({ onPlay, onPause, onSeek }) {
    this.boundHandlers = { onPlay, onPause, onSeek };
    this.videoElement.onplay = () => this.boundHandlers.onPlay?.();
    this.videoElement.onpause = () => this.boundHandlers.onPause?.();
    this.videoElement.onseeked = () => this.boundHandlers.onSeek?.();
  }
}

const html5Player = new Html5PlayerAdapter(video);

function loadYouTubeApi() {
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }

  if (!youtubeApiReadyPromise) {
    youtubeApiReadyPromise = new Promise((resolve) => {
      const previousReady = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        previousReady?.();
        resolve(window.YT);
      };
    });
  }

  return youtubeApiReadyPromise;
}

class YouTubePlayerAdapter {
  constructor({ videoElement, containerId = 'yt-frame', parentElement }) {
    this.videoElement = videoElement;
    this.containerId = containerId;
    this.parentElement = parentElement;
    this.player = null;
    this.boundHandlers = {};
    this.isReady = false;
    this.pendingCommands = [];
    this.seekPollInterval = null;
    this.lastTimeSample = 0;
    this.lastTimeSampleAt = 0;
    this.suppressNextEvent = false;
    this.currentState = null;
  }

  load({ videoId }) {
    if (!videoId) {
      return Promise.reject(new Error('YouTubePlayerAdapter.load requires a videoId'));
    }

    this.videoElement.style.display = 'none';
    const container = this.ensureContainer();
    container.style.display = 'block';

    return loadYouTubeApi().then(() => {
      if (this.player) {
        this.isReady = true;
        this.player.loadVideoById(videoId);
        this.startSeekPolling();
        return;
      }

      this.isReady = false;

      return new Promise((resolve) => {
        this.player = new YT.Player(this.containerId, {
          videoId,
          height: '360',
          width: '100%',
          playerVars: {
            autoplay: 0,
            controls: 1
          },
          events: {
            onReady: () => {
              this.isReady = true;
              this.flushPendingCommands();
              this.captureTimeSample();
              this.startSeekPolling();
              resolve();
            },
            onStateChange: (event) => this.handleStateChange(event)
          }
        });
      });
    });
  }

  play() {
    this.runWhenReady(() => this.player.playVideo());
  }

  pause() {
    this.runWhenReady(() => this.player.pauseVideo());
  }

  seek(time) {
    this.runWhenReady(() => {
      this.player.seekTo(time, true);
      this.captureTimeSample();
    });
  }

  getCurrentTime() {
    if (!this.player || !this.isReady) {
      return 0;
    }

    return this.player.getCurrentTime();
  }

  isPlaying() {
    return this.currentState === YT.PlayerState.PLAYING;
  }

  destroy() {
    this.stopSeekPolling();
    this.pendingCommands = [];
    this.boundHandlers = {};
    this.isReady = false;

    if (this.player?.destroy) {
      this.player.destroy();
    }

    this.player = null;

    const container = document.getElementById(this.containerId);
    if (container) {
      container.style.display = 'none';
      container.innerHTML = '';
    }
  }

  bindEvents({ onPlay, onPause, onSeek }) {
    this.boundHandlers = { onPlay, onPause, onSeek };
  }

  withSuppressedEvents(callback) {
    this.suppressNextEvent = true;
    callback();
  }

  ensureContainer() {
    let container = document.getElementById(this.containerId);
    if (!container) {
      container = document.createElement('div');
      container.id = this.containerId;
      this.parentElement.appendChild(container);
    }

    container.style.width = '100%';
    container.style.height = '360px';
    return container;
  }

  runWhenReady(command) {
    if (this.player && this.isReady) {
      command();
      return;
    }

    this.pendingCommands.push(command);
  }

  flushPendingCommands() {
    const commands = [...this.pendingCommands];
    this.pendingCommands = [];
    commands.forEach((command) => command());
  }

  handleStateChange(event) {
    this.currentState = event.data;

    if (this.suppressNextEvent) {
      this.suppressNextEvent = false;
      this.captureTimeSample();
      return;
    }

    if (event.data === YT.PlayerState.PLAYING) {
      this.captureTimeSample();
      this.boundHandlers.onPlay?.();
      return;
    }

    if (event.data === YT.PlayerState.PAUSED) {
      this.captureTimeSample();
      this.boundHandlers.onPause?.();
    }
  }

  startSeekPolling() {
    this.stopSeekPolling();
    this.captureTimeSample();

    this.seekPollInterval = window.setInterval(() => {
      if (!this.player || !this.isReady) {
        return;
      }

      if (!this.isPlaying()) {
        this.captureTimeSample();
        return;
      }

      const currentTime = this.player.getCurrentTime();
      const now = Date.now();
      const elapsedSeconds = (now - this.lastTimeSampleAt) / 1000;
      const expectedTime = this.lastTimeSample + elapsedSeconds;
      const drift = Math.abs(currentTime - expectedTime);

      if (drift > 1) {
        this.captureTimeSample(currentTime, now);
        this.boundHandlers.onSeek?.(currentTime);
        return;
      }

      this.captureTimeSample(currentTime, now);
    }, 500);
  }

  stopSeekPolling() {
    if (this.seekPollInterval) {
      window.clearInterval(this.seekPollInterval);
      this.seekPollInterval = null;
    }
  }

  captureTimeSample(currentTime = this.getCurrentTime(), now = Date.now()) {
    this.lastTimeSample = currentTime;
    this.lastTimeSampleAt = now;
  }
}

const youtubePlayerAdapter = new YouTubePlayerAdapter({
  videoElement: video,
  parentElement: document.getElementById('video-section')
});

const playerManager = {
  activePlayer: html5Player,
  activeType: 'file',
  boundHandlers: {},

  loadMedia(media) {
    if (!media?.type) {
      return Promise.reject(new Error('playerManager.loadMedia requires a media type'));
    }

    if (media.type === 'youtube') {
      html5Player.destroy();
      this.activePlayer = youtubePlayerAdapter;
      this.activeType = 'youtube';
      this.activePlayer.bindEvents(this.boundHandlers);
      return this.activePlayer.load({ videoId: media.videoId });
    }

    youtubePlayerAdapter.destroy();
    this.activePlayer = html5Player;
    this.activeType = 'file';
    this.activePlayer.bindEvents(this.boundHandlers);
    this.activePlayer.load({ url: media.url });
    return Promise.resolve();
  },

  play() {
    return this.activePlayer?.play();
  },

  pause() {
    return this.activePlayer?.pause();
  },

  seek(time) {
    return this.activePlayer?.seek(time);
  },

  getCurrentTime() {
    return this.activePlayer?.getCurrentTime() || 0;
  },

  getActivePlayer() {
    return this.activePlayer;
  },

  getActiveType() {
    return this.activeType;
  },

  bindEvents(handlers) {
    this.boundHandlers = handlers;
    this.activePlayer?.bindEvents(handlers);
  }
};

const syncController = {
  socket: null,
  playerManager: null,
  suppressEvents: false,
  lastSyncTime: 0,
  driftThreshold: 1,
  syncCooldownMs: 1000,
  currentState: 'paused',
  currentController: null,
  lastControlTime: 0,
  CONTROL_TIMEOUT: 2000,

  init(nextSocket, nextPlayerManager) {
    this.socket = nextSocket;
    this.playerManager = nextPlayerManager;

    this.playerManager.bindEvents({
      onPlay: () => {
        if (!this.suppressEvents) this.handleLocalPlay();
      },
      onPause: () => {
        if (!this.suppressEvents) this.handleLocalPause();
      },
      onSeek: (time) => {
        if (!this.suppressEvents) this.handleLocalSeek(time);
      }
    });
  },

  handleLocalPlay() {
    this.currentState = 'playing';
    this.takeControl();
    this.sendAction('play', this.playerManager.getCurrentTime());
  },

  handleLocalPause() {
    this.currentState = 'paused';
    this.takeControl();
    this.sendAction('pause', this.playerManager.getCurrentTime());
  },

  handleLocalSeek(time) {
    const currentTime = typeof time === 'number' ? time : this.playerManager.getCurrentTime();

    if (this.currentState === 'paused') {
      return;
    }

    this.takeControl();
    this.sendAction('seek', currentTime);
  },

  takeControl() {
    this.currentController = this.socket?.id || null;
    this.lastControlTime = Date.now();
  },

  canSync(action) {
    if (action !== 'seek') {
      return true;
    }

    return Date.now() - this.lastSyncTime > this.syncCooldownMs;
  },

  applyRemoteAction(payload) {
    if (!payload) return;

    const currentTime = typeof payload.currentTime === 'number' ? payload.currentTime : payload.time;
    const activePlayer = this.playerManager.getActivePlayer();
    const currentPlayerTime = this.playerManager.getCurrentTime();
    const diff = typeof currentTime === 'number' ? Math.abs(currentPlayerTime - currentTime) : 0;

    this.currentController = payload.senderId || payload.userId || null;
    this.lastControlTime = Date.now();

    this.suppressEvents = true;

    try {
      const applyAction = () => {
        if (payload.action === 'play') {
          this.currentState = 'playing';
          this.playerManager.play();
          return;
        }

        if (payload.action === 'pause') {
          this.currentState = 'paused';
          this.playerManager.pause();
          return;
        }

        if (payload.action === 'seek' && typeof currentTime === 'number' && diff > this.driftThreshold) {
          this.playerManager.seek(currentTime);
        }
      };

      if (typeof activePlayer?.withSuppressedEvents === 'function') {
        activePlayer.withSuppressedEvents(applyAction);
      } else {
        applyAction();
      }
    } finally {
      window.setTimeout(() => {
        this.suppressEvents = false;
      }, 0);
    }
  },

  sendAction(action, time) {
    if (!this.socket || !roomId) return;
    if (!this.canSync(action)) return;

    const now = Date.now();
    const isController = this.currentController === this.socket.id;
    const isExpired = now - this.lastControlTime > this.CONTROL_TIMEOUT;

    if (!isController && !isExpired) {
      return;
    }

    if (action === 'seek') {
      this.lastSyncTime = Date.now();
    }

    this.socket.emit('video-action', { action, currentTime: time });
  }
};

// Utility
function getRoomIdFromUrl() {
  const match = window.location.pathname.match(/^\/room\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}
function isYouTubeUrl(url) {
  return Boolean(extractYouTubeId(url));
}
function extractYouTubeId(url) {
  if (!url) return null;

  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.replace(/^www\./, '').toLowerCase();

    if (hostname === 'youtu.be') {
      const shortId = parsedUrl.pathname.split('/').filter(Boolean)[0];
      return shortId && /^[a-zA-Z0-9_-]{11}$/.test(shortId) ? shortId : null;
    }

    if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
      const videoParam = parsedUrl.searchParams.get('v');
      if (videoParam && /^[a-zA-Z0-9_-]{11}$/.test(videoParam)) {
        return videoParam;
      }

      const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
      const candidateId = ['embed', 'v', 'shorts'].includes(pathParts[0]) ? pathParts[1] : null;
      return candidateId && /^[a-zA-Z0-9_-]{11}$/.test(candidateId) ? candidateId : null;
    }
  } catch (error) {
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?.*v=|embed\/|v\/|shorts\/))([a-zA-Z0-9_-]{11})/i);
    return match ? match[1] : null;
  }

  return null;
}
function getMediaType(url) {
  return isYouTubeUrl(url) ? 'youtube' : 'file';
}
function buildMediaFromUrl(url) {
  const mediaType = getMediaType(url);

  if (mediaType === 'youtube') {
    const videoId = extractYouTubeId(url);
    return videoId ? { type: 'youtube', url, videoId } : null;
  }

  return { type: 'file', url };
}
function normalizeMedia(media) {
  if (!media?.url) return null;

  const normalizedMedia = buildMediaFromUrl(media.url);
  if (!normalizedMedia) return null;

  return {
    ...media,
    ...normalizedMedia
  };
}
function copyRoomLink() {
  const input = document.getElementById('room-link');
  input.select();
  document.execCommand('copy');
  alert('Room link copied!');
}

// Home page create room
createRoomBtn?.addEventListener('click', async () => {
  const res = await fetch('/api/create-room');
  const { roomId } = await res.json();
  window.location.href = `/room/${roomId}`;
});

// On DOM Ready
document.addEventListener('DOMContentLoaded', () => {
  roomId = getRoomIdFromUrl();
  if (roomId) {
    homeSection?.classList.add('hidden');
    roomSection?.classList.remove('hidden');
    document.getElementById('current-room-id').textContent = roomId;
    document.getElementById('room-controls')?.classList.add('hidden');
    document.getElementById('room-info')?.classList.remove('hidden');

    username = prompt("Enter your name:", "Guest") || `Guest${Math.floor(Math.random() * 1000)}`;
    document.getElementById('your-username').textContent = username;

    socket.emit('join-room', roomId, username);
  }
});

// ----- Chat -----
document.getElementById('send-chat-btn').onclick = sendChat;
document.getElementById('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendChat();
});
function sendChat() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg || !roomId) return;
  socket.emit('chat-message', msg);
  input.value = '';
}
socket.on('chat-message', data => {
  const chatBox = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.innerHTML = `<span class="chat-username">${data.username}</span>: ${data.message}`;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
});

// ----- User Join/Leave -----
socket.on('user-joined', (data) => {
  const list = document.getElementById('user-list');
  const li = document.createElement('li');
  li.textContent = `${data.username}`;
  li.id = 'user-' + data.userId;
  list.appendChild(li);
});
socket.on('user-left', (data) => {
  const li = document.getElementById('user-' + data.userId);
  if (li) li.remove();
});
socket.on('user-count-update', count => {
  document.getElementById('user-count').textContent = count;
});
socket.on('room-state', data => {
  updateUserList(data.users);
  if (data.currentVideo) {
    const media = normalizeMedia(data.currentVideo);

    if (!media) {
      return;
    }

    playerManager.loadMedia(media).then(() => {
      if (typeof data.videoState?.currentTime === 'number') {
        playerManager.seek(data.videoState.currentTime);
      }

      if (data.videoState?.action) {
        syncController.applyRemoteAction(data.videoState);
      }
    });
  }
});

// ----- Video Sync -----
syncController.init(socket, playerManager);

document.getElementById('play-btn').onclick = () => {
  playerManager.play();
};
document.getElementById('pause-btn').onclick = () => {
  playerManager.pause();
};
document.getElementById('skip-btn').onclick = () => {
  playerManager.seek(playerManager.getCurrentTime() + 10);
};

socket.on('video-sync', data => {
  syncController.applyRemoteAction(data);
});

socket.on('video-loaded', videoInfo => {
  const media = normalizeMedia(videoInfo);
  if (!media) return;
  playerManager.loadMedia(media);
});

// ----- Upload -----
// ✂️ All previous code remains unchanged until this point

// ----- Video URL Load Button -----
document.getElementById('load-url-btn').onclick = () => {
  const url = document.getElementById('video-url-input').value.trim();
  if (!url || !roomId) return;

  const media = buildMediaFromUrl(url);
  if (!media) {
    return alert("Invalid YouTube URL.");
  }

  const videoData = {
    type: media.type,
    url,
    videoId: media.videoId,
    name: isYouTubeUrl(url) ? 'YouTube Video' : url,
    originalUrl: url
  };

  // Load locally
  playerManager.loadMedia(media);

  // Broadcast to room
  socket.emit('video-url-shared', videoData);
};

// ----- Receive video broadcast from others -----
socket.on('video-url-shared', videoInfo => {
  const media = normalizeMedia(videoInfo);
  if (!media) return;
  playerManager.loadMedia(media);
});

// ----- YouTube Iframe Player -----
function loadYouTubeVideo(url, seekTime = 0, action = null) {
  const videoId = extractYouTubeId(url);
  if (!videoId) {
    alert("Invalid YouTube URL.");
    return;
  }

  // Remove existing iframe
  const oldFrame = document.getElementById('yt-frame');
  if (oldFrame) oldFrame.remove();

  // Hide native video player
  video.style.display = 'none';

  // Create and insert new iframe container
  const ytFrame = document.createElement('div');
  ytFrame.id = 'yt-frame';
  ytFrame.style.width = '100%';
  ytFrame.style.height = '360px';
  ytFrame.style.display = 'block';
  document.getElementById('video-section').appendChild(ytFrame);

  // Create new YouTube player
  ytPlayer = new YT.Player('yt-frame', {
    videoId: videoId,
    height: '360',
    width: '100%',
    playerVars: {
      autoplay: 0,
      controls: 1
    },
    events: {
      onReady: function (event) {
        ytReady = true;
        if (seekTime) ytPlayer.seekTo(seekTime, true);
        if (action === 'play') ytPlayer.playVideo();
        if (action === 'pause') ytPlayer.pauseVideo();
      },
      onStateChange: onPlayerStateChange
    }
  });
}

function setVideoSrc(url) {
  // Remove YouTube iframe if exists
  const ytFrame = document.getElementById('yt-frame');
  if (ytFrame) ytFrame.remove();

  // Show the native video player
  video.style.display = 'block';
  html5Player.load(url);

  // Optional autoplay
  video.oncanplay = () => {
    html5Player.play();
  };
}

// ----- YouTube Player Events -----
function onPlayerStateChange(event) {
  if (!roomId || !ytPlayer) return;
  if (ytSuppressEvent) {
    ytSuppressEvent = false;
    return;
  }

  if (event.data === YT.PlayerState.PLAYING) {
  } else if (event.data === YT.PlayerState.PAUSED) {
    if (ytSeekTimeout) {
      clearTimeout(ytSeekTimeout);
      ytSeekTimeout = null;
      return;
    }
  }
}

// ----- Upload Button Logic -----
const uploadBtn = document.getElementById('upload-btn');
const fileInput = document.getElementById('file-input');
const uploadProgress = document.getElementById('upload-progress');

uploadBtn.addEventListener('click', () => {
  const file = fileInput.files[0];
  if (!file) return alert("Please choose a video file first.");
  if (!roomId) return alert("Join a room first.");

  const formData = new FormData();
  formData.append('video', file);
  formData.append('roomId', roomId);
  formData.append('username', username);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/upload', true);

  xhr.upload.onprogress = function (e) {
    if (e.lengthComputable) {
      uploadProgress.style.display = 'block';
      uploadProgress.value = (e.loaded / e.total) * 100;
    }
  };

  xhr.onload = function () {
    uploadProgress.style.display = 'none';
    if (xhr.status === 200) {
      const res = JSON.parse(xhr.responseText);
      if (res.success && res.videoUrl) {
        playerManager.loadMedia({ type: 'file', url: res.videoUrl });
        socket.emit('video-url-shared', {
          type: 'file',
          url: res.videoUrl,
          name: res.originalName,
          originalUrl: res.videoUrl
        });
      } else {
        alert("Upload failed: " + (res.error || "Unknown error"));
      }
    } else {
      alert("Upload failed.");
    }
  };

  xhr.onerror = function () {
    uploadProgress.style.display = 'none';
    alert("Upload failed due to network error.");
  };

  xhr.send(formData);
});
