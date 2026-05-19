const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

let users = {};
let tradeListings = [];
let ads = [];
let chatRooms = {};
let userSockets = {};

const STARTER_ITEMS = {
  "Effect:Fire": 3,
  "Effect:Ice": 2,
  "Ball:Soccer": 1,
  "Ball:Basketball": 2,
  "Emote:Dance": 1,
  "Emote:Wave": 2,
  "Banner:Dragon": 1,
  "Banner:Knight": 2
};

app.post('/api/auth', (req, res) => {
  const { userId, username } = req.body;
  
  if (!users[userId]) {
    users[userId] = {
      userId: userId,
      username: username,
      inventory: { ...STARTER_ITEMS },
      joinedAt: Date.now()
    };
  } else {
    users[userId].username = username;
  }
  
  res.json({ success: true, user: users[userId] });
});

app.get('/api/inventory/:userId', (req, res) => {
  const { userId } = req.params;
  
  if (!users[userId]) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  res.json({ inventory: users[userId].inventory });
});

app.get('/api/listings', (req, res) => {
  const { userId } = req.query;
  
  const filteredListings = tradeListings
    .filter(l => l.status === 'active' && l.userId !== userId)
    .map(l => ({
      id: l.id,
      userId: l.userId,
      username: l.username,
      items: l.items,
      createdAt: l.createdAt
    }));
  
  res.json({ listings: filteredListings });
});

app.get('/api/ads', (req, res) => {
  res.json({ ads: ads.slice(0, 20) });
});

app.post('/api/listings', (req, res) => {
  const { userId, username, items } = req.body;
  
  if (!users[userId]) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  for (const itemStr of items) {
    const match = itemStr.match(/^(.+) x(\d+)$/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid item format' });
    }
    
    const itemName = match[1];
    const quantity = parseInt(match[2]);
    
    if (!users[userId].inventory[itemName] || users[userId].inventory[itemName] < quantity) {
      return res.status(400).json({ error: `Insufficient ${itemName}` });
    }
  }
  
  for (const itemStr of items) {
    const match = itemStr.match(/^(.+) x(\d+)$/);
    const itemName = match[1];
    const quantity = parseInt(match[2]);
    
    users[userId].inventory[itemName] -= quantity;
    if (users[userId].inventory[itemName] <= 0) {
      delete users[userId].inventory[itemName];
    }
  }
  
  const listing = {
    id: uuidv4(),
    userId: userId,
    username: username,
    items: items,
    status: 'active',
    createdAt: Date.now()
  };
  
  tradeListings.push(listing);
  io.emit('newListing', listing);
  
  res.json({ success: true, listing: listing });
});

app.post('/api/ads', (req, res) => {
  const { userId, username, title, description, imageId } = req.body;
  
  const ad = {
    id: uuidv4(),
    userId: userId,
    username: username,
    title: title,
    description: description,
    imageId: imageId || '',
    createdAt: Date.now()
  };
  
  ads.unshift(ad);
  
  if (ads.length > 100) {
    ads = ads.slice(0, 100);
  }
  
  io.emit('newAd', ad);
  res.json({ success: true, ad: ad });
});

app.post('/api/trade/request', (req, res) => {
  const { fromUserId, fromUsername, listingId, myItems } = req.body;
  
  const listing = tradeListings.find(l => l.id === listingId && l.status === 'active');
  
  if (!listing) {
    return res.status(404).json({ error: 'Listing not found' });
  }
  
  if (listing.userId === fromUserId) {
    return res.status(400).json({ error: 'Cannot trade with yourself' });
  }
  
  for (const itemStr of myItems) {
    const match = itemStr.match(/^(.+) x(\d+)$/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid item format' });
    }
    
    const itemName = match[1];
    const quantity = parseInt(match[2]);
    
    if (!users[fromUserId].inventory[itemName] || users[fromUserId].inventory[itemName] < quantity) {
      return res.status(400).json({ error: `Insufficient ${itemName}` });
    }
  }
  
  for (const itemStr of myItems) {
    const match = itemStr.match(/^(.+) x(\d+)$/);
    const itemName = match[1];
    const quantity = parseInt(match[2]);
    
    users[fromUserId].inventory[itemName] -= quantity;
    if (users[fromUserId].inventory[itemName] <= 0) {
      delete users[fromUserId].inventory[itemName];
    }
  }
  
  listing.status = 'pending';
  
  const tradeRequest = {
    id: uuidv4(),
    listingId: listingId,
    fromUserId: fromUserId,
    fromUsername: fromUsername,
    toUserId: listing.userId,
    toUsername: listing.username,
    theirItems: listing.items,
    myItems: myItems,
    status: 'pending',
    createdAt: Date.now()
  };
  
  activeTrades[tradeRequest.id] = tradeRequest;
  
  if (userSockets[listing.userId]) {
    userSockets[listing.userId].emit('tradeRequest', tradeRequest);
  }
  
  res.json({ success: true, trade: tradeRequest });
});

app.post('/api/trade/accept', (req, res) => {
  const { tradeId, userId } = req.body;
  
  const trade = activeTrades[tradeId];
  
  if (!trade) {
    return res.status(404).json({ error: 'Trade not found' });
  }
  
  if (trade.toUserId !== userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  const listing = tradeListings.find(l => l.id === trade.listingId);
  
  if (!listing) {
    for (const itemStr of trade.myItems) {
      const match = itemStr.match(/^(.+) x(\d+)$/);
      const itemName = match[1];
      const quantity = parseInt(match[2]);
      users[trade.fromUserId].inventory[itemName] = (users[trade.fromUserId].inventory[itemName] || 0) + quantity;
    }
    delete activeTrades[tradeId];
    return res.status(404).json({ error: 'Listing no longer exists' });
  }
  
  for (const itemStr of trade.theirItems) {
    const match = itemStr.match(/^(.+) x(\d+)$/);
    const itemName = match[1];
    const quantity = parseInt(match[2]);
    users[trade.fromUserId].inventory[itemName] = (users[trade.fromUserId].inventory[itemName] || 0) + quantity;
  }
  
  for (const itemStr of trade.myItems) {
    const match = itemStr.match(/^(.+) x(\d+)$/);
    const itemName = match[1];
    const quantity = parseInt(match[2]);
    users[trade.toUserId].inventory[itemName] = (users[trade.toUserId].inventory[itemName] || 0) + quantity;
  }
  
  const listingIndex = tradeListings.findIndex(l => l.id === trade.listingId);
  if (listingIndex !== -1) {
    tradeListings.splice(listingIndex, 1);
  }
  
  trade.status = 'completed';
  
  if (userSockets[trade.fromUserId]) {
    userSockets[trade.fromUserId].emit('tradeCompleted', {
      tradeId: trade.id,
      message: `${trade.toUsername} accepted your trade!`
    });
  }
  
  if (userSockets[trade.toUserId]) {
    userSockets[trade.toUserId].emit('tradeCompleted', {
      tradeId: trade.id,
      message: `Trade with ${trade.fromUsername} completed!`
    });
  }
  
  delete activeTrades[tradeId];
  io.emit('listingRemoved', trade.listingId);
  
  res.json({ success: true });
});

app.post('/api/trade/decline', (req, res) => {
  const { tradeId, userId } = req.body;
  
  const trade = activeTrades[tradeId];
  
  if (!trade) {
    return res.status(404).json({ error: 'Trade not found' });
  }
  
  if (trade.toUserId !== userId) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  for (const itemStr of trade.myItems) {
    const match = itemStr.match(/^(.+) x(\d+)$/);
    const itemName = match[1];
    const quantity = parseInt(match[2]);
    users[trade.fromUserId].inventory[itemName] = (users[trade.fromUserId].inventory[itemName] || 0) + quantity;
  }
  
  const listing = tradeListings.find(l => l.id === trade.listingId);
  if (listing) {
    listing.status = 'active';
  }
  
  if (userSockets[trade.fromUserId]) {
    userSockets[trade.fromUserId].emit('tradeDeclined', {
      tradeId: trade.id,
      message: `${trade.toUsername} declined your trade.`
    });
  }
  
  delete activeTrades[tradeId];
  
  res.json({ success: true });
});

app.post('/api/chat/create', (req, res) => {
  const { userId, username, targetUserId } = req.body;
  
  const roomId = [userId, targetUserId].sort().join('_');
  
  if (!chatRooms[roomId]) {
    chatRooms[roomId] = {
      id: roomId,
      users: [userId, targetUserId],
      messages: []
    };
  }
  
  res.json({ roomId: roomId });
});

app.get('/api/chat/:roomId', (req, res) => {
  const { roomId } = req.params;
  
  if (!chatRooms[roomId]) {
    return res.status(404).json({ error: 'Chat room not found' });
  }
  
  res.json({ messages: chatRooms[roomId].messages.slice(-50) });
});

io.on('connection', (socket) => {
  socket.on('register', (userId) => {
    userSockets[userId] = socket;
    socket.userId = userId;
  });
  
  socket.on('joinChat', (roomId) => {
    socket.join(roomId);
  });
  
  socket.on('leaveChat', (roomId) => {
    socket.leave(roomId);
  });
  
  socket.on('chatMessage', (data) => {
    const { roomId, userId, username, message } = data;
    
    if (!chatRooms[roomId]) {
      return;
    }
    
    const chatMessage = {
      id: uuidv4(),
      userId: userId,
      username: username,
      message: message,
      timestamp: Date.now()
    };
    
    chatRooms[roomId].messages.push(chatMessage);
    
    if (chatRooms[roomId].messages.length > 200) {
      chatRooms[roomId].messages = chatRooms[roomId].messages.slice(-200);
    }
    
    io.to(roomId).emit('newMessage', chatMessage);
  });
  
  socket.on('disconnect', () => {
    if (socket.userId) {
      delete userSockets[socket.userId];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Trading server running on port ${PORT}`);
});
