const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5001;

app.use(express.json());

let qrCodeData = '';
let isReady = false;

// Initialize WhatsApp Web Client
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './.wwebjs_auth' // Saves session details in a local folder
    }),
    puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

// Event Listeners for WhatsApp Client
client.on('qr', (qr) => {
    console.log('New QR Code generated. Visit /qr page to scan.');
    qrcode.toDataURL(qr, (err, url) => {
        if (err) {
            console.error('Error generating QR Data URL:', err);
            return;
        }
        qrCodeData = url;
    });
});

client.on('ready', () => {
    console.log('SUCCESS: WhatsApp Web Client is fully connected and ready!');
    isReady = true;
    qrCodeData = ''; // Clear QR code since we are logged in
});

client.on('authenticated', () => {
    console.log('WhatsApp Client authenticated successfully.');
});

client.on('auth_failure', (msg) => {
    console.error('AUTHENTICATION FAILURE:', msg);
    isReady = false;
});

client.on('disconnected', (reason) => {
    console.warn('WARNING: WhatsApp Client was disconnected! Reason:', reason);
    isReady = false;
    qrCodeData = '';
    // Re-initialize client
    client.initialize();
});

// Web Routes
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: Arial, sans-serif; text-align: center; margin-top: 50px;">
            <h1>Sreshta WhatsApp Microservice</h1>
            <p>Status: <strong>${isReady ? 'Connected' : 'Offline / Authenticating'}</strong></p>
            <p><a href="/qr" style="display: inline-block; padding: 10px 20px; background: #25D366; color: white; text-decoration: none; border-radius: 5px;">View QR Code Scan Portal</a></p>
        </div>
    `);
});

app.get('/qr', (req, res) => {
    if (isReady) {
        return res.send(`
            <div style="font-family: Arial, sans-serif; text-align: center; margin-top: 50px;">
                <h2 style="color: #075E54;">WhatsApp Client is already connected!</h2>
                <p><a href="/">Go Back Home</a></p>
            </div>
        `);
    }
    if (!qrCodeData) {
        return res.send(`
            <div style="font-family: Arial, sans-serif; text-align: center; margin-top: 50px;">
                <h2>Generating QR Code...</h2>
                <p>Please wait and refresh this page in a few seconds.</p>
                <script>setTimeout(() => window.location.reload(), 3000);</script>
            </div>
        `);
    }
    res.send(`
        <div style="font-family: Arial, sans-serif; text-align: center; margin-top: 50px;">
            <h2 style="color: #128C7E;">Scan this QR code with your WhatsApp "Linked Devices"</h2>
            <img src="${qrCodeData}" alt="WhatsApp Web QR Code" style="border: 2px solid #333; padding: 10px; margin-top: 20px;">
            <p style="color: #666; font-size: 14px; margin-top: 15px;">Page auto-refreshes every 5 seconds to detect login states.</p>
            <script>
                setInterval(() => {
                    fetch('/')
                        .then(r => r.text())
                        .then(html => {
                            if (html.includes('Status: <strong>Connected</strong>')) {
                                window.location.href = '/';
                            }
                        });
                }, 3000);
            </script>
        </div>
    `);
});

// API endpoint to send WhatsApp message
app.post('/api/send', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const expectedApiKey = process.env.API_KEY || 'Vikirthan@WhatsApp2026';

    if (apiKey !== expectedApiKey) {
        return res.status(403).json({ error: "Access Denied. Invalid API Key." });
    }

    if (!isReady) {
        return res.status(503).json({ error: "WhatsApp Client is not ready yet. Please link your account first via /qr page." });
    }

    const { phone, message } = req.body;
    if (!phone || !message) {
        return res.status(400).json({ error: "Missing 'phone' or 'message' parameters in payload." });
    }

    // Sanitize phone number (remove non-digits)
    let cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.length === 10) {
        cleanPhone = '91' + cleanPhone; // India default country prefix
    }
    const finalRecipient = cleanPhone + '@c.us';

    try {
        await client.sendMessage(finalRecipient, message);
        console.log(`Successfully sent automated WhatsApp message to: ${cleanPhone}`);
        res.json({ success: true, message: `WhatsApp message successfully dispatched to ${cleanPhone}.` });
    } catch (err) {
        console.error(`Failed to dispatch WhatsApp message to ${cleanPhone}:`, err.message);
        res.status(500).json({ error: `Failed to dispatch WhatsApp message: ${err.message}` });
    }
});

// Start the server and WhatsApp client
app.listen(PORT, () => {
    console.log(`WhatsApp Express microservice running on port ${PORT}`);
    client.initialize().catch(err => {
        console.error("Error initializing WhatsApp client:", err.message);
    });
});
