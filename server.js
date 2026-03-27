const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ========== НАСТРОЙКИ ==========
const PORT = process.env.PORT || 3000;
const clients = new Map(); // userId -> ws
const users = new Map(); // userId -> { name, avatar, online, lastSeen, contacts, createdAt }
const groups = new Map(); // groupId -> { name, owner, members, password, createdAt }
const messages = []; // все сообщения
const typingStatus = new Map(); // userId -> { to, timeout }

// Настройка загрузки файлов
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

// ========== ФИЛЬТР МАТЕРНЫХ СЛОВ ==========
const BAD_WORDS = [
    'бля', 'блядь', 'блядина', 'хуй', 'хуёвый', 'хуйло', 'хуйня', 'хуесос', 'пизда', 'пиздец',
    'ебать', 'ебанутый', 'еблан', 'ёбаный', 'залупа', 'мудак', 'гандон', 'пидор', 'пидорас',
    'срать', 'дерьмо', 'говно', 'шлюха', 'даун', 'дебил', 'идиот', 'лох', 'чмо', 'сука', 'тварь',
    'fuck', 'shit', 'bitch', 'asshole', 'dick', 'cunt'
];

function containsBadWords(text) {
    const lower = text.toLowerCase();
    return BAD_WORDS.some(word => lower.includes(word));
}

function validateUsername(name) {
    if (!name || name.length < 2) return 'Имя слишком короткое';
    if (name.length > 20) return 'Имя слишком длинное';
    if (containsBadWords(name)) return 'Имя содержит запрещённые слова';
    return null;
}

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========
function broadcast(data, filter = null) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && (!filter || filter(client))) {
            client.send(JSON.stringify(data));
        }
    });
}

function getUserData(userId) {
    const user = users.get(userId);
    if (!user) return null;
    return {
        id: userId,
        name: user.name,
        avatar: user.avatar || null,
        online: user.online,
        lastSeen: user.lastSeen,
        createdAt: user.createdAt
    };
}

function saveData() {
    const data = {
        users: Array.from(users.entries()),
        groups: Array.from(groups.entries()),
        messages: messages
    };
    fs.writeFileSync('./data.json', JSON.stringify(data, null, 2));
}

function loadData() {
    try {
        const data = JSON.parse(fs.readFileSync('./data.json', 'utf8'));
        data.users.forEach(([id, user]) => users.set(id, user));
        data.groups.forEach(([id, group]) => groups.set(id, group));
        messages.push(...data.messages);
    } catch (e) {}
}

// Загружаем данные при старте
if (!fs.existsSync('./data.json')) fs.writeFileSync('./data.json', '{}');
loadData();

// ========== API ЭНДПОИНТЫ ==========
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });
    res.json({ url: `/uploads/${req.file.filename}` });
});

app.post('/upload-avatar', upload.single('avatar'), (req, res) => {
    const { userId } = req.body;
    if (!req.file || !userId) return res.status(400).json({ error: 'Ошибка' });
    const user = users.get(userId);
    if (user) {
        user.avatar = `/uploads/${req.file.filename}`;
        users.set(userId, user);
        saveData();
        broadcast({ type: 'avatar_update', userId, avatar: user.avatar });
        res.json({ url: user.avatar });
    } else {
        res.status(404).json({ error: 'Пользователь не найден' });
    }
});

app.get('/user/:userId', (req, res) => {
    const user = getUserData(req.params.userId);
    if (user) res.json(user);
    else res.status(404).json({ error: 'Не найден' });
});

// ========== WEBSOCKET ==========
wss.on('connection', (ws) => {
    let currentUser = null;

    ws.on('message', (rawData) => {
        try {
            const data = JSON.parse(rawData);
            
            switch (data.type) {
                case 'auth':
                    const error = validateUsername(data.userId);
                    if (error) {
                        ws.send(JSON.stringify({ type: 'auth_error', error }));
                        return;
                    }
                    
                    currentUser = data.userId;
                    let user = users.get(currentUser);
                    if (!user) {
                        user = {
                            name: currentUser,
                            avatar: null,
                            online: true,
                            lastSeen: Date.now(),
                            contacts: [],
                            createdAt: Date.now()
                        };
                        users.set(currentUser, user);
                        saveData();
                    } else {
                        user.online = true;
                        user.lastSeen = Date.now();
                        users.set(currentUser, user);
                    }
                    clients.set(currentUser, ws);
                    
                    // Отправляем историю
                    const userMessages = messages.filter(m => 
                        (m.from === currentUser || m.to === currentUser) ||
                        (m.isGroup && groups.get(m.groupId)?.members?.includes(currentUser))
                    );
                    ws.send(JSON.stringify({ type: 'history', messages: userMessages }));
                    
                    // Отправляем группы
                    const userGroups = Array.from(groups.values()).filter(g => g.members.includes(currentUser));
                    ws.send(JSON.stringify({ type: 'groups_list', groups: userGroups }));
                    
                    // Отправляем контакты
                    const contacts = user.contacts.map(c => getUserData(c)).filter(c => c);
                    ws.send(JSON.stringify({ type: 'contacts_list', contacts }));
                    
                    // Рассылаем статус онлайн
                    broadcast({ type: 'user_online', userId: currentUser });
                    break;
                
                case 'message':
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
                        timestamp: Date.now()
                    };
                    messages.push(msg);
                    saveData();
                    
                    // Отправляем получателю
                    const recipientWs = clients.get(data.to);
                    if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
                        recipientWs.send(JSON.stringify(msg));
                    }
                    ws.send(JSON.stringify(msg));
                    break;
                
                case 'group_message':
                    const group = groups.get(data.groupId);
                    if (!group || !group.members.includes(currentUser)) return;
                    
                    if (containsBadWords(data.text)) {
                        ws.send(JSON.stringify({ type: 'error', error: 'Сообщение содержит запрещённые слова' }));
                        return;
                    }
                    
                    const groupMsg = {
                        type: 'group_message',
                        id: Date.now(),
                        from: currentUser,
                        groupId: data.groupId,
                        text: data.text || '',
                        image: data.image || null,
                        timestamp: Date.now(),
                        isGroup: true
                    };
                    messages.push(groupMsg);
                    saveData();
                    
                    // Отправляем всем участникам
                    group.members.forEach(memberId => {
                        const memberWs = clients.get(memberId);
                        if (memberWs && memberWs.readyState === WebSocket.OPEN) {
                            memberWs.send(JSON.stringify(groupMsg));
                        }
                    });
                    break;
                
                case 'create_group':
                    const groupId = Date.now().toString();
                    const newGroup = {
                        id: groupId,
                        name: data.groupName,
                        owner: currentUser,
                        members: [currentUser],
                        password: data.password || null,
                        createdAt: Date.now()
                    };
                    groups.set(groupId, newGroup);
                    saveData();
                    ws.send(JSON.stringify({ type: 'group_created', group: newGroup }));
                    broadcast({ type: 'groups_list', groups: Array.from(groups.values()) });
                    break;
                
                case 'join_group':
                    const targetGroup = groups.get(data.groupId);
                    if (!targetGroup) {
                        ws.send(JSON.stringify({ type: 'join_error', error: 'Группа не найдена' }));
                        return;
                    }
                    if (targetGroup.password && targetGroup.password !== data.password) {
                        ws.send(JSON.stringify({ type: 'join_error', error: 'Неверный пароль' }));
                        return;
                    }
                    if (!targetGroup.members.includes(currentUser)) {
                        targetGroup.members.push(currentUser);
                        groups.set(data.groupId, targetGroup);
                        saveData();
                        ws.send(JSON.stringify({ type: 'join_success', groupName: targetGroup.name }));
                    }
                    break;
                
                case 'leave_group':
                    const leaveGroup = groups.get(data.groupId);
                    if (leaveGroup && leaveGroup.members.includes(currentUser)) {
                        leaveGroup.members = leaveGroup.members.filter(m => m !== currentUser);
                        if (leaveGroup.members.length === 0) {
                            groups.delete(data.groupId);
                        } else if (leaveGroup.owner === currentUser && leaveGroup.members.length > 0) {
                            leaveGroup.owner = leaveGroup.members[0];
                        }
                        groups.set(data.groupId, leaveGroup);
                        saveData();
                        ws.send(JSON.stringify({ type: 'left_group', groupId: data.groupId }));
                    }
                    break;
                
                case 'delete_group':
                    const delGroup = groups.get(data.groupId);
                    if (delGroup && delGroup.owner === currentUser) {
                        groups.delete(data.groupId);
                        saveData();
                        broadcast({ type: 'group_deleted', groupId: data.groupId });
                    }
                    break;
                
                case 'add_contact':
                    const contactUser = users.get(data.contactName);
                    if (!contactUser) {
                        ws.send(JSON.stringify({ type: 'add_contact_error', error: 'Пользователь не найден' }));
                        return;
                    }
                    const currentUserData = users.get(currentUser);
                    if (currentUserData.contacts.includes(data.contactName)) {
                        ws.send(JSON.stringify({ type: 'add_contact_error', error: 'Контакт уже добавлен' }));
                        return;
                    }
                    currentUserData.contacts.push(data.contactName);
                    users.set(currentUser, currentUserData);
                    saveData();
                    ws.send(JSON.stringify({ type: 'contact_added', contact: data.contactName }));
                    
                    // Уведомляем другого пользователя
                    const contactWs = clients.get(data.contactName);
                    if (contactWs) {
                        contactWs.send(JSON.stringify({ type: 'contact_request', from: currentUser }));
                    }
                    break;
                
                case 'typing':
                    const typingTo = clients.get(data.to);
                    if (typingTo) {
                        typingTo.send(JSON.stringify({ type: 'typing', from: currentUser }));
                    }
                    break;
                
                case 'reaction':
                    // Реакция на сообщение
                    const reactionMsg = messages.find(m => m.id === data.messageId);
                    if (reactionMsg) {
                        if (!reactionMsg.reactions) reactionMsg.reactions = {};
                        reactionMsg.reactions[data.reaction] = (reactionMsg.reactions[data.reaction] || 0) + 1;
                        saveData();
                        
                        // Отправляем обновление всем в чате
                        if (reactionMsg.isGroup) {
                            const groupMembers = groups.get(reactionMsg.groupId)?.members || [];
                            groupMembers.forEach(memberId => {
                                const memberWs = clients.get(memberId);
                                if (memberWs) memberWs.send(JSON.stringify({ type: 'reaction_update', messageId: data.messageId, reactions: reactionMsg.reactions }));
                            });
                        } else {
                            const fromWs = clients.get(reactionMsg.from);
                            const toWs = clients.get(reactionMsg.to);
                            if (fromWs) fromWs.send(JSON.stringify({ type: 'reaction_update', messageId: data.messageId, reactions: reactionMsg.reactions }));
                            if (toWs) toWs.send(JSON.stringify({ type: 'reaction_update', messageId: data.messageId, reactions: reactionMsg.reactions }));
                        }
                    }
                    break;
            }
        } catch (e) {}
    });
    
    ws.on('close', () => {
        if (currentUser) {
            const user = users.get(currentUser);
            if (user) {
                user.online = false;
                user.lastSeen = Date.now();
                users.set(currentUser, user);
                saveData();
                broadcast({ type: 'user_offline', userId: currentUser });
            }
            clients.delete(currentUser);
        }
    });
});

server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
    if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
});
