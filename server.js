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
const contactRequests = new Map(); // Заявки в друзья

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

app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    res.json({ url: `/uploads/${req.file.filename}` });
});

app.post('/upload-avatar', upload.single('avatar'), (req, res) => {
    if (!req.file || !req.body.userId) return res.status(400).json({ error: 'Missing data' });
    const avatarUrl = `/avatars/${req.file.filename}`;
    const userData = users.get(req.body.userId) || {};
    userData.avatar = avatarUrl;
    users.set(req.body.userId, userData);
    res.json({ avatar: avatarUrl });
});

// Общая группа
groups.set('general', {
    name: 'Общий чат',
    members: [],
    messages: [],
    password: null,
    owner: null
});

function broadcastGroupsList() {
    const groupsList = [];
    for (const [groupId, group] of groups) {
        groupsList.push({ 
            id: groupId, 
            name: group.name, 
            members: group.members,
            hasPassword: !!group.password,
            owner: group.owner
        });
    }
    for (const [userId, client] of clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({ type: 'groups_list', groups: groupsList }));
        }
    }
}

function broadcastContactsList() {
    const contactsList = [];
    for (const [userId, userData] of users) {
        const userInfo = {
            id: userId,
            name: userId,
            avatar: userData?.avatar || null,
            online: clients.has(userId)
        };
        contactsList.push(userInfo);
    }
    for (const [userId, client] of clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(JSON.stringify({ type: 'contacts_list', contacts: contactsList }));
        }
    }
}

wss.on('connection', (ws, req) => {
    let userId = null;

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        
        if (msg.type === 'auth') {
            userId = msg.userId;
            const userData = users.get(userId) || { contacts: [], avatar: null };
            userData.contacts = userData.contacts || [];
            users.set(userId, userData);
            clients.set(userId, { ws, avatar: msg.avatar, settings: msg.settings || {} });
            
            if (msg.avatar) {
                const user = users.get(userId);
                user.avatar = msg.avatar;
                users.set(userId, user);
            }
            
            const generalGroup = groups.get('general');
            if (generalGroup && !generalGroup.members.includes(userId)) {
                generalGroup.members.push(userId);
            }
            
            // История сообщений
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
            
            broadcastGroupsList();
            broadcastContactsList();
            
            const avatarsList = {};
            for (const [uid, userData] of users) {
                if (userData?.avatar) avatarsList[uid] = userData.avatar;
            }
            ws.send(JSON.stringify({ type: 'avatars', avatars: avatarsList }));
            
            // Отправляем заявки в друзья
            const requests = contactRequests.get(userId) || [];
            ws.send(JSON.stringify({ type: 'contact_requests', requests: requests }));
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
                password: msg.password || null,
                owner: userId
            });
            ws.send(JSON.stringify({ type: 'group_created', groupId, groupName: msg.groupName }));
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
        else if (msg.type === 'delete_group') {
            const group = groups.get(msg.groupId);
            if (group && group.owner === userId) {
                groups.delete(msg.groupId);
                broadcastGroupsList();
                ws.send(JSON.stringify({ type: 'group_deleted', groupId: msg.groupId }));
            } else {
                ws.send(JSON.stringify({ type: 'delete_error', error: 'Только создатель может удалить группу' }));
            }
        }
        else if (msg.type === 'leave_group') {
            const group = groups.get(msg.groupId);
            if (group) {
                const index = group.members.indexOf(userId);
                if (index !== -1) group.members.splice(index, 1);
                broadcastGroupsList();
            }
        }
        // Добавление контакта
        else if (msg.type === 'add_contact') {
            const targetUser = msg.contactName;
            if (!users.has(targetUser)) {
                ws.send(JSON.stringify({ type: 'add_contact_error', error: 'Пользователь не найден' }));
                return;
            }
            // Отправляем заявку
            const requests = contactRequests.get(targetUser) || [];
            if (!requests.includes(userId)) {
                requests.push(userId);
                contactRequests.set(targetUser, requests);
                const targetClient = clients.get(targetUser);
                if (targetClient?.ws.readyState === WebSocket.OPEN) {
                    targetClient.ws.send(JSON.stringify({
                        type: 'contact_request',
                        from: userId
                    }));
                }
            }
            ws.send(JSON.stringify({ type: 'contact_request_sent', to: targetUser }));
        }
        else if (msg.type === 'accept_contact') {
            const fromUser = msg.from;
            const userData = users.get(userId);
            if (!userData.contacts) userData.contacts = [];
            if (!userData.contacts.includes(fromUser)) {
                userData.contacts.push(fromUser);
                users.set(userId, userData);
            }
            const fromUserData = users.get(fromUser);
            if (!fromUserData.contacts) fromUserData.contacts = [];
            if (!fromUserData.contacts.includes(userId)) {
                fromUserData.contacts.push(userId);
                users.set(fromUser, fromUserData);
            }
            // Удаляем заявку
            const requests = contactRequests.get(userId) || [];
            const index = requests.indexOf(fromUser);
            if (index !== -1) requests.splice(index, 1);
            contactRequests.set(userId, requests);
            
            broadcastContactsList();
            ws.send(JSON.stringify({ type: 'contact_accepted', contact: fromUser }));
            const fromClient = clients.get(fromUser);
            if (fromClient?.ws.readyState === WebSocket.OPEN) {
                fromClient.ws.send(JSON.stringify({ type: 'contact_accepted', contact: userId }));
            }
        }
        else if (msg.type === 'reject_contact') {
            const fromUser = msg.from;
            const requests = contactRequests.get(userId) || [];
            const index = requests.indexOf(fromUser);
            if (index !== -1) requests.splice(index, 1);
            contactRequests.set(userId, requests);
            ws.send(JSON.stringify({ type: 'contact_rejected', contact: fromUser }));
        }
        else if (msg.type === 'get_contacts') {
            const userData = users.get(userId);
            ws.send(JSON.stringify({ type: 'my_contacts', contacts: userData?.contacts || [] }));
        }
        // WebRTC звонки
        else if (msg.type === 'call_offer') {
            const target = clients.get(msg.to);
            if (target?.ws.readyState === WebSocket.OPEN) {
                target.ws.send(JSON.stringify({
                    type: 'call_offer',
                    from: userId,
                    offer: msg.offer,
                    callId: msg.callId,
                    video: msg.video
                }));
            }
        }
        else if (msg.type === 'call_answer') {
            const target = clients.get(msg.to);
            if (target?.ws.readyState === WebSocket.OPEN) {
                target.ws.send(JSON.stringify({
                    type: 'call_answer',
                    from: userId,
                    answer: msg.answer,
                    callId: msg.callId
                }));
            }
        }
        else if (msg.type === 'ice_candidate') {
            const target = clients.get(msg.to);
            if (target?.ws.readyState === WebSocket.OPEN) {
                target.ws.send(JSON.stringify({
                    type: 'ice_candidate',
                    from: userId,
                    candidate: msg.candidate,
                    callId: msg.callId
                }));
            }
        }
        else if (msg.type === 'end_call') {
            const target = clients.get(msg.to);
            if (target?.ws.readyState === WebSocket.OPEN) {
                target.ws.send(JSON.stringify({ type: 'end_call', from: userId }));
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
            broadcastContactsList();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
});
