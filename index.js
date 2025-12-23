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

const app = express();
const redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });
const proxy = httpProxy.createProxyServer({ changeOrigin: true, secure: true });

app.use(cors());

// --- 1. GIT PROXY (Unchanged) ---
app.use('/git', (req, res) => {
    const targetUrl = 'https://github.com';
    req.url = '/' + GH_USERNAME + req.url;
    const authString = Buffer.from(`${GH_USERNAME}:${GH_TOKEN}`).toString('base64');
    req.headers['Authorization'] = `Basic ${authString}`;
    proxy.web(req, res, { target: targetUrl }, (err) => {
        if (!res.headersSent) res.sendStatus(502);
    });
});

app.use('/api', express.json());

// --- 2. REGISTER (Unchanged) ---
app.post('/api/register', async (req, res) => {
    const { username } = req.body;
    if (!username || username.length > 16) return res.status(400).json({ error: "Invalid username" });
    try {
        const num = await redis.incr(`counter:${username}`);
        const tag = `${username}#${num}`;
        const secret = crypto.randomUUID();
        await redis.set(`secret:${tag}`, secret);
        res.json({ tag, secret });
    } catch (err) { res.status(500).json({ error: "DB Error" }); }
});

// --- 3. SEND INVITE (Updated structure) ---
app.post('/api/invite', async (req, res) => {
    const { targetTag, senderTag, ip, worldName } = req.body;
    
    // Structure: We add 'type: INVITE' so the client knows how to render it
    const payload = JSON.stringify({ 
        type: "INVITE",
        ip, 
        worldName, 
        timestamp: Date.now() 
    });

    try {
        // HSET automatically replaces old invites from the same sender
        await redis.hset(`inbox:${targetTag}`, { [senderTag]: payload });
        await redis.expire(`inbox:${targetTag}`, 600); // 10 Minutes expiry
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Failed" }); }
});

// --- 4. RESPOND TO INVITE (New Endpoint) ---
// Used when a player clicks "Deny"
app.post('/api/respond', async (req, res) => {
    const { senderTag, targetTag, action } = req.body; // action = "DENY"

    if (action === 'DENY') {
        const payload = JSON.stringify({
            type: "REJECT",
            timestamp: Date.now()
        });

        // We send a notification BACK to the original Sender
        // We use a unique field name "REJECT:TargetName" so it doesn't overwrite other invites
        try {
            await redis.hset(`inbox:${senderTag}`, { [`SYSTEM:${targetTag}`]: payload });
            await redis.expire(`inbox:${senderTag}`, 600);
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: "Failed" }); }
    } else {
        res.json({ success: true }); // Join action doesn't need server logic
    }
});

// --- 5. CHECK NOTIFICATIONS (Unchanged logic, just fetches) ---
app.post('/api/notifications', async (req, res) => {
    const { tag, secret } = req.body;
    const storedSecret = await redis.get(`secret:${tag}`);
    if (!storedSecret || storedSecret !== secret) return res.status(403).json({ error: "Unauthorized" });

    try {
        const inbox = await redis.hgetall(`inbox:${tag}`);
        if (!inbox) return res.json({ notifications: [] });

        await redis.del(`inbox:${tag}`); // Clear server-side so we don't fetch duplicates

        // Convert to array
        const notifications = Object.keys(inbox).map(key => {
            const data = inbox[key];
            return { from: key, ...data };
        });

        res.json({ notifications });
    } catch (err) { res.status(500).json({ error: "Error" }); }
});

app.listen(PORT, () => { console.log(`Haven Middleware Running on ${PORT}`); });