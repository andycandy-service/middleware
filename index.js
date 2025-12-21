const http = require('http');
const httpProxy = require('http-proxy');

// --- CONFIGURATION ---
// We read these from Koyeb's "Environment Variables" settings
// format: "ghp_xxxxxxxxxxxx"
const GITHUB_TOKEN = process.env.GH_TOKEN; 
// format: "HavenBot" (The name of the account that owns the repos)
const GITHUB_USERNAME = process.env.GH_USERNAME; 
const PORT = process.env.PORT || 8000;

// Create the Proxy Server
const proxy = httpProxy.createProxyServer({
    target: 'https://github.com',
    changeOrigin: true, // Essential: Tells GitHub "I am coming from github.com"
    secure: true        // Verifies GitHub's SSL certificate
});

// Error Handling (Prevents server crash on timeouts)
proxy.on('error', function (err, req, res) {
    console.error(`[Proxy Error] ${err.message}`);
    if (res && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Bad Gateway: Connection to GitHub failed.');
    }
});

// --- THE SERVER ---
const server = http.createServer((req, res) => {
    // 1. Security Check: Only allow traffic starting with /git/
    // Example: https://haven.koyeb.app/git/world-id.git
    if (!req.url.startsWith('/git/')) {
        res.writeHead(403);
        res.end('Forbidden: Haven Middleware only accepts Git traffic.');
        return;
    }

    // 2. URL Rewrite
    // Client asks for: /git/world-123.git
    // GitHub expects:  /HavenBot/world-123.git
    // We remove "/git" and prepend the username.
    req.url = req.url.replace('/git', '/' + GITHUB_USERNAME);
    
    // 3. Inject Authorization
    // We create a "Basic Auth" header using your hidden token.
    const authString = Buffer.from(`${GITHUB_USERNAME}:${GITHUB_TOKEN}`).toString('base64');
    req.headers['Authorization'] = `Basic ${authString}`;

    // 4. Log for Debugging (Optional - remove in production for speed)
    console.log(`[Proxy] Forwarding ${req.method} to GitHub: ${req.url}`);

    // 5. Fire the Proxy
    proxy.web(req, res);
});

server.listen(PORT, () => {
    console.log(`Haven Middleware is running on port ${PORT}`);
    console.log(`Target GitHub Account: ${GITHUB_USERNAME}`);
});
