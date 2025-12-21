const express = require('express');
const httpProxy = require('http-proxy');
const { Redis } = require('@upstash/redis');
const crypto = require('crypto');
const cors = require('cors');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 8000;
const GH_USERNAME = process.env.GH_USERNAME; 
const GH_TOKEN = process.env.GH_TOKEN;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Initialize
const app = express();
const redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });
const proxy = httpProxy.createProxyServer({ changeOrigin: true, secure: true });

app.use(cors()); // Allow requests from anywhere (for now)

// --- 1. THE GIT PROXY (High Priority Traffic) ---
// Captures anything starting with /git/
app.use('/git', (req, res) => {
    const targetUrl = 'https://github.com';
    
    // Rewrite: /git/world-id -> /BotName/world-id
    req.url = '/' + GH_USERNAME + req.url;

    // Inject Auth
    const authString = Buffer.from(`${GH_USERNAME}:${GH_TOKEN}`).toString('base64');
    req.headers['Authorization'] = `Basic ${authString}`;

    console.log(`[Proxy] Syncing world: ${req.url}`);
    
    proxy.web(req, res, { target: targetUrl }, (err) => {
        console.error("[Proxy Error]", err.message);
        if (!res.headersSent) res.sendStatus(502);
    });
});

// --- API PRE-REQUISITES ---
// Only parse JSON for API routes (NOT for Git binary streams!)
app.use('/api', express.json());

// --- 2. REGISTRATION (Offline Mode Support) ---
app.post('/api/register', async (req, res) => {
    const { username } = req.body;
    if (!username || username.length > 16) return res.status(400).json({ error: "Invalid username" });

    try {
        // Atomic Counter: Get next number for "Andy"
        // key: "counter:Andy" -> 5
        const num = await redis.incr(`counter:${username}`);
        const tag = `${username}#${num}`;
        
        // Generate a "Password" for this tag so only this user can check its mail
        const secret = crypto.randomUUID();
        
        // Store the Secret (Permanent)
        await redis.set(`secret:${tag}`, secret);

        console.log(`[Register] New User: ${tag}`);
        res.json({ tag, secret });
    } catch (err) {
        res.status(500).json({ error: "Database error" });
    }
});

// --- 3. SEND INVITE (The Mailbox) ---
app.post('/api/invite', async (req, res) => {
    const { targetTag, senderTag, ip, worldName } = req.body;
    
    // We store invites in a Hash Map to prevent duplicates
    // Key: inbox:Andy#5
    // Field: Steve#1
    // Value: JSON Data
    const inviteData = JSON.stringify({ ip, worldName, timestamp: Date.now() });

    try {
        await redis.hset(`inbox:${targetTag}`, { [senderTag]: inviteData });
        await redis.expire(`inbox:${targetTag}`, 300); // Mailbox clears after 5 mins of inactivity
        
        console.log(`[Invite] ${senderTag} -> ${targetTag}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to send invite" });
    }
});

// --- 4. CHECK NOTIFICATIONS (Polling) ---
app.post('/api/notifications', async (req, res) => {
    const { tag, secret } = req.body;

    // 1. Verify Identity
    const storedSecret = await redis.get(`secret:${tag}`);
    if (!storedSecret || storedSecret !== secret) {
        return res.status(403).json({ error: "Unauthorized" });
    }

    // 2. Fetch & Clear Inbox
    try {
        const inbox = await redis.hgetall(`inbox:${tag}`);
        
        if (!inbox) return res.json({ invites: [] });

        // Atomic Delete (So we don't show the same invite twice)
        await redis.del(`inbox:${tag}`);

        // Convert Hash to List
        const invites = Object.keys(inbox).map(sender => {
            const data = inbox[sender]; // It's already an object if using @upstash/redis automatic parsing
            return { sender, ...data }; 
        });

        res.json({ invites });
    } catch (err) {
        res.status(500).json({ error: "Polling error" });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`Haven Middleware v2.0 running on port ${PORT}`);
});