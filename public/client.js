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

// Utility
function getRoomIdFromUrl() {
  const match = window.location.pathname.match(/^\/room\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}
function isYouTubeUrl(url) {
  return /youtu\.?be/.test(url);
}
function extractYouTubeId(url) {
  const regex = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/|.*[?&]v=))([^"&?/ ]{11})/i;
  const match = url.match(regex);
  return match ? match[1] : null;
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
    if (isYouTubeUrl(data.currentVideo.url)) {
      loadYouTubeVideo(data.currentVideo.url, data.videoState?.currentTime || 0, data.videoState?.action);
    } else {
      setVideoSrc(data.currentVideo.url);
    }
  }
});

// ----- Video Sync -----
video.onplay = () => socket.emit('video-action', { action: 'play', currentTime: video.currentTime });
video.onpause = () => socket.emit('video-action', { action: 'pause', currentTime: video.currentTime });
video.onseeked = () => socket.emit('video-action', { action: 'seek', currentTime: video.currentTime });

document.getElementById('play-btn').onclick = () => {
  video.play();
  socket.emit('video-action', { action: 'play', currentTime: video.currentTime });
};
document.getElementById('pause-btn').onclick = () => {
  video.pause();
  socket.emit('video-action', { action: 'pause', currentTime: video.currentTime });
};
document.getElementById('skip-btn').onclick = () => {
  video.currentTime += 10;
  socket.emit('video-action', { action: 'seek', currentTime: video.currentTime });
};

socket.on('video-sync', data => {
  if (Math.abs(video.currentTime - data.currentTime) > 0.5) {
    video.currentTime = data.currentTime;
  }
  if (data.action === 'play') video.play();
  if (data.action === 'pause') video.pause();
});

socket.on('video-loaded', videoInfo => {
  if (isYouTubeUrl(videoInfo.url)) {
    loadYouTubeVideo(videoInfo.url);
  } else {
    setVideoSrc(videoInfo.url);
  }
});

// ----- Upload -----
// ✂️ All previous code remains unchanged until this point

// ----- Video URL Load Button -----
document.getElementById('load-url-btn').onclick = () => {
  const url = document.getElementById('video-url-input').value.trim();
  if (!url || !roomId) return;

  const videoData = {
    url,
    name: isYouTubeUrl(url) ? 'YouTube Video' : url,
    originalUrl: url
  };

  // Load locally
  if (isYouTubeUrl(url)) {
    loadYouTubeVideo(url);
  } else {
    setVideoSrc(url);
  }

  // Broadcast to room
  socket.emit('video-url-shared', videoData);
};

// ----- Receive video broadcast from others -----
socket.on('video-url-shared', videoInfo => {
  if (isYouTubeUrl(videoInfo.url)) {
    loadYouTubeVideo(videoInfo.url);
  } else {
    setVideoSrc(videoInfo.url);
  }
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
  video.src = url;
  video.load();

  // Optional autoplay
  video.oncanplay = () => {
    video.play();
  };
}

// ----- YouTube Player Events -----
function onPlayerStateChange(event) {
  if (!roomId || !ytPlayer) return;
  if (ytSuppressEvent) {
    ytSuppressEvent = false;
    return;
  }

  const currentTime = ytPlayer.getCurrentTime();

  if (event.data === YT.PlayerState.PLAYING) {
    socket.emit('video-action', { action: 'play', currentTime });
  } else if (event.data === YT.PlayerState.PAUSED) {
    if (ytSeekTimeout) {
      clearTimeout(ytSeekTimeout);
      ytSeekTimeout = null;
      return;
    }
    socket.emit('video-action', { action: 'pause', currentTime });
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
        setVideoSrc(res.videoUrl);
        socket.emit('video-url-shared', {
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

