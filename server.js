const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const clients = new Map();
let messages = [];
const groups = new Map();
const users = new Map();

// Настройка загрузки файлов
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + ext);
    }
});

const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

const uploadsDir = path.join(__dirname, 'uploads');
const avatarsDir = path.join(__dirname, 'avatars');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir);

app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use('/avatars', express.static('avatars'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Загрузка файлов
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    res.json({ url: `/uploads/${req.file.filename}` });
});

// Загрузка аватарки
app.post('/upload-avatar', upload.single('avatar'), (req, res) => {
    if (!req.file || !req.body.userId) return res.status(400).json({ error: 'Missing data' });
    const avatarUrl = `/avatars/${req.file.filename}`;
    users.set(req.body.userId, { ...users.get(req.body.userId), avatar: avatarUrl });
    res.json({ avatar: avatarUrl });
});

// Получить аватарку
app.get('/avatar/:userId', (req, res) => {
    const user = users.get(req.params.userId);
    res.json({ avatar: user?.avatar || null });
});

// Общая группа
groups.set('general', {
    name: 'Общий чат',
    members: [],
    messages: [],
    password: null
});

wss.on('connection', (ws, req) => {
    let userId = null;

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        
        if (msg.type === 'auth') {
            userId = msg.userId;
            clients.set(userId, { ws, avatar: msg.avatar, settings: msg.settings || {} });
            
            if (msg.avatar) {
                users.set(userId, { ...users.get(userId), avatar: msg.avatar });
            }
            
            const generalGroup = groups.get('general');
            if (generalGroup && !generalGroup.members.includes(userId)) {
                generalGroup.members.push(userId);
            }
            
            // Отправляем историю
            const userMessages = messages.filter(m => 
                (m.to === userId || m.from === userId) && !m.isGroup
            );
            
            const groupMessages = [];
            for (const [groupId, group] of groups) {
                group.messages.forEach(msg => {
                    groupMessages.push({
                        ...msg,
                        isGroup: true,
                        groupId,
                        groupName: group.name
                    });
                });
            }
            
            ws.send(JSON.stringify({
                type: 'history',
                messages: [...userMessages, ...groupMessages].slice(-100)
            }));
            
            const groupsList = [];
            for (const [groupId, group] of groups) {
                groupsList.push({ 
                    id: groupId, 
                    name: group.name, 
                    members: group.members,
                    hasPassword: !!group.password
                });
            }
            ws.send(JSON.stringify({ type: 'groups_list', groups: groupsList }));
            
            const avatarsList = {};
            for (const [uid, userData] of users) {
                if (userData?.avatar) avatarsList[uid] = userData.avatar;
            }
            ws.send(JSON.stringify({ type: 'avatars', avatars: avatarsList }));
        }
        else if (msg.type === 'message') {
            const newMsg = {
                from: userId,
                to: msg.to,
                text: msg.text || '',
                image: msg.image || null,
                timestamp: Date.now(),
                isGroup: false
            };
            messages.push(newMsg);
            
            const target = clients.get(msg.to);
            if (target?.ws.readyState === WebSocket.OPEN) {
                target.ws.send(JSON.stringify({ type: 'message', ...newMsg }));
            }
            ws.send(JSON.stringify({ type: 'message', ...newMsg }));
        }
        else if (msg.type === 'group_message') {
            const group = groups.get(msg.groupId);
            if (group) {
                const newMsg = {
                    from: userId,
                    text: msg.text || '',
                    image: msg.image || null,
                    timestamp: Date.now(),
                    isGroup: true,
                    groupId: msg.groupId,
                    groupName: group.name
                };
                group.messages.push(newMsg);
                
                group.members.forEach(memberId => {
                    const member = clients.get(memberId);
                    if (member?.ws.readyState === WebSocket.OPEN) {
                        member.ws.send(JSON.stringify({ type: 'group_message', ...newMsg }));
                    }
                });
            }
        }
        else if (msg.type === 'create_group') {
            const groupId = Date.now().toString();
            groups.set(groupId, {
                name: msg.groupName,
                members: [userId],
                messages: [],
                password: msg.password || null
            });
            ws.send(JSON.stringify({ type: 'group_created', groupId, groupName: msg.groupName }));
            
            // Обновляем списки у всех
            broadcastGroupsList();
        }
        else if (msg.type === 'join_group') {
            const group = groups.get(msg.groupId);
            if (!group) {
                ws.send(JSON.stringify({ type: 'join_error', error: 'Группа не найдена' }));
                return;
            }
            if (group.password && group.password !== msg.password) {
                ws.send(JSON.stringify({ type: 'join_error', error: 'Неверный пароль' }));
                return;
            }
            if (!group.members.includes(userId)) {
                group.members.push(userId);
                ws.send(JSON.stringify({ type: 'join_success', groupId: msg.groupId, groupName: group.name }));
                broadcastGroupsList();
            }
        }
        else if (msg.type === 'update_settings') {
            const userData = clients.get(userId);
            if (userData) {
                userData.settings = { ...userData.settings, ...msg.settings };
                users.set(userId, { ...users.get(userId), settings: userData.settings });
            }
        }
    });

    ws.on('close', () => {
        if (userId) {
            for (const [groupId, group] of groups) {
                const index = group.members.indexOf(userId);
                if (index !== -1) group.members.splice(index, 1);
            }
            clients.delete(userId);
            broadcastGroupsList();
        }
    });
});

function broadcastGroupsList() {
    const groupsList = [];
    for (const [groupId, group] of groups) {
        groupsList.push({ 
            id: groupId, 
            name: group.name, 
            members: group.members,
            hasPassword: !!group.password
        });
    }
    for (const [userId, client] of clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({ type: 'groups_list', groups: groupsList }));
        }
    }
}

const PORT = process.env.PORT || 3000;

// ВАЖНО: '0.0.0.0' - чтобы сервер был доступен извне
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
    console.log(`📱 Для доступа из интернета используйте туннель: ssh -R 80:localhost:3000 localhost.run`);
});