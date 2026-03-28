const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const clients = new Map();
const users = new Map();
const groups = new Map();
const messages = [];

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
if (!fs.existsSync('./public')) fs.mkdirSync('./public');

const storage = multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, unique + path.extname(file.originalname));
    }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

const BAD_WORDS = ['бля', 'хуй', 'пизд', 'еблан', 'пидор', 'мудак', 'гандон', 'лох', 'сука', 'тварь', 'дебил', 'даун', 'идиот', 'чмо', 'шлюха', 'говно', 'дерьмо'];

function containsBadWords(text) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return BAD_WORDS.some(word => lower.includes(word));
}

function broadcast(data, filter = null) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && (!filter || filter(client))) {
            client.send(JSON.stringify(data));
        }
    });
}

app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });
    res.json({ url: `/uploads/${req.file.filename}` });
});

app.post('/upload-avatar', upload.single('avatar'), (req, res) => {
    const { userId } = req.body;
    if (!req.file || !userId) return res.status(400).json({ error: 'Ошибка' });
    const user = users.get(userId);
    if (user) {
        if (user.avatar && user.avatar !== req.file.filename) {
            try { fs.unlinkSync('.' + user.avatar); } catch(e) {}
        }
        user.avatar = `/uploads/${req.file.filename}`;
        users.set(userId, user);
        broadcast({ type: 'avatar_update', userId, avatar: user.avatar });
        res.json({ url: user.avatar });
    } else {
        res.status(404).json({ error: 'Пользователь не найден' });
    }
});

wss.on('connection', (ws) => {
    let currentUser = null;

    ws.on('message', (rawData) => {
        try {
            const data = JSON.parse(rawData);
            
            if (data.type === 'auth') {
                if (containsBadWords(data.userId)) {
                    ws.send(JSON.stringify({ type: 'auth_error', error: 'Имя содержит запрещённые слова' }));
                    return;
                }
                if (data.userId.length < 2 || data.userId.length > 20) {
                    ws.send(JSON.stringify({ type: 'auth_error', error: 'Имя должно быть 2-20 символов' }));
                    return;
                }
                
                currentUser = data.userId;
                let user = users.get(currentUser);
                if (!user) {
                    user = { 
                        name: currentUser, 
                        avatar: null, 
                        online: true, 
                        contacts: [], 
                        createdAt: Date.now() 
                    };
                    users.set(currentUser, user);
                } else {
                    user.online = true;
                }
                clients.set(currentUser, ws);
                
                const userMessages = messages.filter(m => 
                    (m.from === currentUser || m.to === currentUser) ||
                    (m.isGroup && groups.get(m.groupId)?.members?.includes(currentUser))
                );
                ws.send(JSON.stringify({ type: 'history', messages: userMessages }));
                
                const userGroups = Array.from(groups.values()).filter(g => g.members && g.members.includes(currentUser));
                ws.send(JSON.stringify({ type: 'groups_list', groups: userGroups }));
                
                const contactsList = user.contacts.map(c => {
                    const u = users.get(c);
                    return u ? { name: u.name, online: u.online || false, avatar: u.avatar } : null;
                }).filter(c => c);
                ws.send(JSON.stringify({ type: 'contacts_list', contacts: contactsList }));
                
                broadcast({ type: 'user_online', userId: currentUser });
                const onlineUsers = Array.from(clients.keys());
                ws.send(JSON.stringify({ type: 'online_list', users: onlineUsers }));
                
                console.log(`✅ ${currentUser} вошёл, онлайн: ${onlineUsers.length}`);
            }
            
            else if (data.type === 'message') {
                if (containsBadWords(data.text)) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Сообщение содержит запрещённые слова' }));
                    return;
                }
                const msg = { 
                    type: 'message', 
                    id: Date.now(), 
                    from: currentUser, 
                    to: data.to, 
                    text: data.text || '', 
                    image: data.image || null,
                    audio: data.audio || null,
                    timestamp: Date.now() 
                };
                messages.push(msg);
                const recipientWs = clients.get(data.to);
                if (recipientWs) recipientWs.send(JSON.stringify(msg));
                ws.send(JSON.stringify(msg));
            }
                
                else if (data.type === 'group_call_offer') {
    const group = groups.get(data.groupId);
    if (!group) return;
    group.members.forEach(memberId => {
        if (memberId !== currentUser) {
            const memberWs = clients.get(memberId);
            if (memberWs) {
                memberWs.send(JSON.stringify({
                    type: 'group_call_offer',
                    from: currentUser,
                    groupId: data.groupId,
                    offer: data.offer,
                    callId: data.callId,
                    video: data.video
                }));
            }
        }
    });
}
            
            else if (data.type === 'group_message') {
                const group = groups.get(data.groupId);
                if (!group || !group.members || !group.members.includes(currentUser)) return;
                if (containsBadWords(data.text)) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Сообщение содержит запрещённые слова' }));
                    return;
                }
                const msg = { 
                    type: 'group_message', 
                    id: Date.now(), 
                    from: currentUser, 
                    groupId: data.groupId, 
                    text: data.text || '', 
                    image: data.image || null,
                    audio: data.audio || null,
                    timestamp: Date.now(), 
                    isGroup: true 
                };
                messages.push(msg);
                group.members.forEach(memberId => {
                    const memberWs = clients.get(memberId);
                    if (memberWs) memberWs.send(JSON.stringify(msg));
                });
            }
            
            else if (data.type === 'create_group') {
                const groupId = Date.now().toString();
                groups.set(groupId, { 
                    id: groupId, 
                    name: data.groupName, 
                    owner: currentUser, 
                    members: [currentUser], 
                    password: data.password || null, 
                    createdAt: Date.now() 
                });
                ws.send(JSON.stringify({ type: 'group_created' }));
                broadcast({ type: 'groups_list', groups: Array.from(groups.values()) });
            }
            
            else if (data.type === 'invite_to_group') {
                const group = groups.get(data.groupId);
                if (!group) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Группа не найдена' }));
                    return;
                }
                if (!group.members.includes(currentUser)) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Вы не участник группы' }));
                    return;
                }
                const invitedUser = users.get(data.userToInvite);
                if (!invitedUser) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Пользователь не найден' }));
                    return;
                }
                const invitedWs = clients.get(data.userToInvite);
                if (invitedWs) {
                    invitedWs.send(JSON.stringify({
                        type: 'group_invite',
                        from: currentUser,
                        groupId: group.id,
                        groupName: group.name
                    }));
                    ws.send(JSON.stringify({ type: 'invite_sent', to: data.userToInvite }));
                } else {
                    ws.send(JSON.stringify({ type: 'error', error: 'Пользователь не в сети' }));
                }
            }
            
            else if (data.type === 'accept_group_invite') {
                const group = groups.get(data.groupId);
                if (!group) {
                    ws.send(JSON.stringify({ type: 'error', error: 'Группа не найдена' }));
                    return;
                }
                if (!group.members.includes(currentUser)) {
                    group.members.push(currentUser);
                    groups.set(data.groupId, group);
                    broadcast({ type: 'groups_list', groups: Array.from(groups.values()) });
                    ws.send(JSON.stringify({ type: 'group_joined', groupName: group.name }));
                }
            }
            
            else if (data.type === 'join_group') {
                const group = groups.get(data.groupId);
                if (!group) { ws.send(JSON.stringify({ type: 'join_error', error: 'Группа не найдена' })); return; }
                if (group.password && group.password !== data.password) { ws.send(JSON.stringify({ type: 'join_error', error: 'Неверный пароль' })); return; }
                if (!group.members.includes(currentUser)) {
                    group.members.push(currentUser);
                    ws.send(JSON.stringify({ type: 'join_success', groupName: group.name }));
                }
            }
            
            else if (data.type === 'leave_group') {
                const group = groups.get(data.groupId);
                if (group && group.members && group.members.includes(currentUser)) {
                    group.members = group.members.filter(m => m !== currentUser);
                    if (group.members.length === 0) groups.delete(data.groupId);
                    ws.send(JSON.stringify({ type: 'left_group', groupId: data.groupId }));
                }
            }
            
            else if (data.type === 'delete_group') {
                const group = groups.get(data.groupId);
                if (group && group.owner === currentUser) {
                    groups.delete(data.groupId);
                    broadcast({ type: 'group_deleted', groupId: data.groupId });
                }
            }
            
            else if (data.type === 'add_contact') {
                const contact = users.get(data.contactName);
                if (!contact) { ws.send(JSON.stringify({ type: 'add_contact_error', error: 'Пользователь не найден' })); return; }
                const user = users.get(currentUser);
                if (!user.contacts.includes(data.contactName)) {
                    user.contacts.push(data.contactName);
                    ws.send(JSON.stringify({ type: 'contact_added', contact: data.contactName }));
                    const contactWs = clients.get(data.contactName);
                    if (contactWs) contactWs.send(JSON.stringify({ type: 'contact_request', from: currentUser }));
                }
            }
            
            else if (data.type === 'typing') {
                const toWs = clients.get(data.to);
                if (toWs) toWs.send(JSON.stringify({ type: 'typing', from: currentUser }));
            }
            
            else if (data.type === 'reaction') {
                const msg = messages.find(m => m.id === data.messageId);
                if (msg) {
                    if (!msg.reactions) msg.reactions = {};
                    msg.reactions[data.reaction] = (msg.reactions[data.reaction] || 0) + 1;
                    if (msg.isGroup) {
                        const group = groups.get(msg.groupId);
                        group?.members.forEach(m => {
                            const mWs = clients.get(m);
                            if (mWs) mWs.send(JSON.stringify({ type: 'reaction_update', messageId: data.messageId, reactions: msg.reactions }));
                        });
                    } else {
                        [msg.from, msg.to].forEach(u => {
                            const uWs = clients.get(u);
                            if (uWs) uWs.send(JSON.stringify({ type: 'reaction_update', messageId: data.messageId, reactions: msg.reactions }));
                        });
                    }
                }
            }
            
            // ========== ВЕБРТС ЗВОНКИ ==========
            else if (data.type === 'call_offer') {
                const targetWs = clients.get(data.to);
                if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                    targetWs.send(JSON.stringify({
                        type: 'call_offer',
                        from: currentUser,
                        offer: data.offer,
                        callId: data.callId,
                        video: data.video
                    }));
                }
            }
            
            else if (data.type === 'call_answer') {
                const targetWs = clients.get(data.to);
                if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                    targetWs.send(JSON.stringify({
                        type: 'call_answer',
                        from: currentUser,
                        answer: data.answer,
                        callId: data.callId
                    }));
                }
            }
            
            else if (data.type === 'ice_candidate') {
                const targetWs = clients.get(data.to);
                if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                    targetWs.send(JSON.stringify({
                        type: 'ice_candidate',
                        from: currentUser,
                        candidate: data.candidate,
                        callId: data.callId
                    }));
                }
            }
            
            else if (data.type === 'end_call') {
                const targetWs = clients.get(data.to);
                if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                    targetWs.send(JSON.stringify({ type: 'end_call', from: currentUser }));
                }
            }
            
        } catch(e) { console.error('WebSocket error:', e); }
    });
    
    ws.on('close', () => {
        if (currentUser) {
            const user = users.get(currentUser);
            if (user) user.online = false;
            clients.delete(currentUser);
            broadcast({ type: 'user_offline', userId: currentUser });
            console.log(`❌ ${currentUser} вышел`);
        }
    });
});

server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
});
