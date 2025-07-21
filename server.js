const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        // Generate unique filename
        const uniqueSuffix = crypto.randomBytes(16).toString('hex');
        const extension = path.extname(file.originalname);
        cb(null, `${uniqueSuffix}${extension}`);
    }
});
const upload = multer({
    storage: storage,
    limits: {
        fileSize: 500 * 1024 * 1024, // 500MB limit
    },
    fileFilter: (req, file, cb) => {
        // Check if file is a video
        if (file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Only video files are allowed'));
        }
    }
});

// Serve static files
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

// Store room data
const rooms = new Map();
const uploadedFiles = new Map(); // Store file metadata

// ----------------------
// Room creation endpoint
// ----------------------
app.get('/api/create-room', (req, res) => {
    // Generate a unique, short room ID
    const roomId = crypto.randomBytes(4).toString('hex');
    // Optionally, initialize the room here if you want
    res.json({ roomId, roomUrl: `/room/${roomId}` });
});

// File upload endpoint
app.post('/upload', upload.single('video'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        const roomId = req.body.roomId;
        const username = req.body.username || 'Anonymous';
        if (!roomId) {
            return res.status(400).json({ error: 'Room ID is required' });
        }
        const fileInfo = {
            filename: req.file.filename,
            originalName: req.file.originalname,
            size: req.file.size,
            mimetype: req.file.mimetype,
            uploadedBy: username,
            uploadedAt: Date.now(),
            roomId: roomId
        };
        // Store file info
        uploadedFiles.set(req.file.filename, fileInfo);
        // Create video URL
        const videoUrl = `/uploads/${req.file.filename}`;
        res.json({
            success: true,
            videoUrl: videoUrl,
            filename: req.file.filename,
            originalName: req.file.originalname,
            size: req.file.size
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// ----------------------
// Route for /room/:roomId (and all other non-upload/static routes)
// ----------------------
app.get('*', (req, res) => {
    // Don't serve HTML for API routes or file uploads
    if (
        req.path.startsWith('/uploads') ||
        req.path.startsWith('/upload') ||
        req.path.startsWith('/api/')
    ) {
        return;
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join-room', (roomId, username) => {
        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username || `User${Math.floor(Math.random() * 1000)}`;

        // Create room if it doesn't exist
        if (!rooms.has(roomId)) {
            rooms.set(roomId, {
                users: new Map(),
                videoState: null,
                currentVideo: null,
                host: socket.id,
                createdAt: Date.now()
            });
        }

        const room = rooms.get(roomId);
        room.users.set(socket.id, {
            username: socket.username,
            userId: socket.id,
            isHost: room.host === socket.id
        });

        // Send current room state to new user
        socket.emit('room-state', {
            users: Array.from(room.users.values()),
            videoState: room.videoState,
            currentVideo: room.currentVideo
        });

        // Notify others in the room about new user
        socket.to(roomId).emit('user-joined', {
            username: socket.username,
            userId: socket.id
        });

        // Update user count for all users in room
        io.to(roomId).emit('user-count-update', room.users.size);

        console.log(`User ${socket.username} joined room ${roomId}`);
    });

    // Handle video control actions (play, pause, seek)
    socket.on('video-action', (data) => {
        if (!socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (room) {
            const videoState = {
                ...data,
                timestamp: Date.now(),
                userId: socket.id,
                username: socket.username
            };
            room.videoState = videoState;
            // Broadcast to all other users in the room
            socket.to(socket.roomId).emit('video-sync', videoState);
            console.log(`Video ${data.action} by ${socket.username} in room ${socket.roomId}`);
        }
    });

    // Handle when a user loads a video (URL or uploaded file)
    socket.on('video-loaded', (videoInfo) => {
        if (!socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (room) {
            room.currentVideo = {
                ...videoInfo,
                loadedBy: socket.username,
                loadedAt: Date.now(),
                userId: socket.id
            };
            // Broadcast to all other users in the room
            socket.to(socket.roomId).emit('video-loaded', room.currentVideo);
            console.log(`Video ${videoInfo.name || videoInfo.url} loaded by ${socket.username} in room ${socket.roomId}`);
        }
    });

    // Handle file upload notification
    socket.on('file-uploaded', (fileData) => {
        if (!socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (room) {
            const videoInfo = {
                url: fileData.videoUrl,
                name: fileData.originalName,
                type: 'uploaded',
                uploadedBy: socket.username,
                uploadedAt: Date.now(),
                size: fileData.size
            };
            room.currentVideo = videoInfo;
            // Notify all other users about the new uploaded video
            socket.to(socket.roomId).emit('video-loaded', videoInfo);
            console.log(`File ${fileData.originalName} uploaded by ${socket.username} in room ${socket.roomId}`);
        }
    });

    // Handle URL video sharing (YOUTUBE/DIRECT URL) - FIXED: emit to ALL in room, not just others
    socket.on('video-url-shared', (data) => {
        if (!socket.roomId) return;
        const room = rooms.get(socket.roomId);
        if (room) {
            const videoInfo = {
                url: data.url,
                name: data.name,
                type: 'url',
                originalUrl: data.originalUrl,
                loadedBy: socket.username,
                loadedAt: Date.now(),
                userId: socket.id
            };
            room.currentVideo = videoInfo;
            // BROADCAST TO ALL in room (including sender) so all tabs update!
            io.to(socket.roomId).emit('video-loaded', videoInfo);
            console.log(`URL video ${data.name} shared by ${socket.username} in room ${socket.roomId}`);
        }
    });

    // Handle chat messages
    socket.on('chat-message', (message) => {
        if (!socket.roomId || !message.trim()) return;
        const chatData = {
            username: socket.username,
            message: message.trim(),
            timestamp: Date.now(),
            userId: socket.id
        };
        // Broadcast to all users in the room (including sender)
        io.to(socket.roomId).emit('chat-message', chatData);
        console.log(`Chat message from ${socket.username} in room ${socket.roomId}: ${message}`);
    });

    // Handle user disconnection
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        if (socket.roomId) {
            const room = rooms.get(socket.roomId);
            if (room) {
                room.users.delete(socket.id);
                // Notify other users about the disconnect
                socket.to(socket.roomId).emit('user-left', {
                    username: socket.username,
                    userId: socket.id
                });
                // Update user count
                io.to(socket.roomId).emit('user-count-update', room.users.size);
                // If the host left and there are other users, assign new host
                if (room.host === socket.id && room.users.size > 0) {
                    const newHostId = room.users.keys().next().value;
                    room.host = newHostId;
                    io.to(socket.roomId).emit('new-host', { hostId: newHostId });
                    console.log(`New host assigned in room ${socket.roomId}: ${newHostId}`);
                }
                // Clean up empty rooms
                if (room.users.size === 0) {
                    rooms.delete(socket.roomId);
                    // Clean up uploaded files for this room
                    cleanupRoomFiles(socket.roomId);
                    console.log(`Room ${socket.roomId} deleted (empty)`);
                }
                console.log(`User ${socket.username} left room ${socket.roomId}`);
            }
        }
    });

    socket.on('error', (error) => {
        console.error('Socket error:', error);
    });
});

// Function to clean up files when room is empty
function cleanupRoomFiles(roomId) {
    const filesToDelete = [];
    for (const [filename, fileInfo] of uploadedFiles.entries()) {
        if (fileInfo.roomId === roomId) {
            filesToDelete.push(filename);
        }
    }
    filesToDelete.forEach(filename => {
        const filePath = path.join(uploadsDir, filename);
        if (fs.existsSync(filePath)) {
            fs.unlink(filePath, (err) => {
                if (err) {
                    console.error(`Error deleting file ${filename}:`, err);
                } else {
                    console.log(`Deleted file: ${filename}`);
                }
            });
        }
        uploadedFiles.delete(filename);
    });
}

// Periodic cleanup of old rooms and files
setInterval(() => {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours
    // Clean up empty rooms
    for (const [roomId, room] of rooms.entries()) {
        if (room.users.size === 0) {
            const roomAge = now - (room.createdAt || 0);
            if (roomAge > maxAge) {
                rooms.delete(roomId);
                cleanupRoomFiles(roomId);
                console.log(`Cleaned up old room: ${roomId}`);
            }
        }
    }
    // Clean up orphaned files
    for (const [filename, fileInfo] of uploadedFiles.entries()) {
        const fileAge = now - fileInfo.uploadedAt;
        if (fileAge > maxAge && !rooms.has(fileInfo.roomId)) {
            const filePath = path.join(uploadsDir, filename);
            if (fs.existsSync(filePath)) {
                fs.unlink(filePath, (err) => {
                    if (!err) {
                        console.log(`Cleaned up orphaned file: ${filename}`);
                    }
                });
            }
            uploadedFiles.delete(filename);
        }
    }
}, 60 * 60 * 1000); // Run every hour

// Error handling for multer
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ error: 'File too large. Maximum size is 500MB.' });
        }
    }
    if (error.message === 'Only video files are allowed') {
        return res.status(400).json({ error: error.message });
    }
    console.error('Server error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SyncStream Server running on port ${PORT}`);
    console.log(`🌐 Local access: http://localhost:${PORT}`);
    console.log(`📁 Upload directory: ${uploadsDir}`);
    console.log(`📌 Share room links with friends to watch together!`);
});
