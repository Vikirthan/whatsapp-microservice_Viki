const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const pino = require('pino');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5001;

app.use(express.json());

let qrCodeData = '';
let isReady = false;
let sock = null;

// Silent logger to reduce memory and noise
const logger = pino({ level: 'silent' });

async function startWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');

    sock = makeWASocket({
        auth: state,
        logger,
        printQRInTerminal: false,
        browser: ['Sreshta', 'Chrome', '1.0.0'],
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
    });

    // Handle credentials update (saves session so QR scan is one-time)
    sock.ev.on('creds.update', saveCreds);

    // Handle connection updates
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('New QR Code generated. Visit /qr page to scan.');
            try {
                qrCodeData = await qrcode.toDataURL(qr);
            } catch (err) {
                console.error('Error generating QR Data URL:', err);
            }
        }

        if (connection === 'open') {
            console.log('SUCCESS: WhatsApp connection is fully open and ready!');
            isReady = true;
            qrCodeData = '';
        }

        if (connection === 'close') {
            isReady = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            console.warn('Connection closed. Status code:', statusCode);

            if (shouldReconnect) {
                console.log('Attempting to reconnect...');
                await delay(3000);
                startWhatsApp();
            } else {
                console.log('Device was logged out. Please re-scan QR code.');
                qrCodeData = '';
            }
        }
    });
}

// ─── Web Routes ───

app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: Arial, sans-serif; text-align: center; margin-top: 50px;">
            <h1>Sreshta WhatsApp Microservice</h1>
            <p>Status: <strong>${isReady ? '✅ Connected' : '⏳ Offline / Authenticating'}</strong></p>
            <p><a href="/qr" style="display: inline-block; padding: 10px 20px; background: #25D366; color: white; text-decoration: none; border-radius: 5px;">View QR Code Scan Portal</a></p>
        </div>
    `);
});

app.get('/api/status', (req, res) => {
    res.json({ isReady, hasQr: !!qrCodeData, qrCodeData: qrCodeData || '' });
});

app.get('/qr', (req, res) => {
    if (isReady) {
        return res.send(`
            <div style="font-family: Arial, sans-serif; text-align: center; margin-top: 50px;">
                <h2 style="color: #075E54;">✅ WhatsApp Client is already connected!</h2>
                <p><a href="/">Go Back Home</a></p>
            </div>
        `);
    }
    res.send(`
        <div style="font-family: Arial, sans-serif; text-align: center; margin-top: 50px;">
            <h2 style="color: #128C7E;">Scan this QR code with your WhatsApp "Linked Devices"</h2>
            <div id="qr-container" style="margin-top: 20px; min-height: 300px; display: flex; flex-direction: column; justify-content: center; align-items: center;">
                <p id="loading-text">⏳ Generating QR Code... Please wait.</p>
                <img id="qr-image" src="" alt="WhatsApp Web QR Code" style="border: 2px solid #333; padding: 10px; display: none; max-width: 300px;">
            </div>
            <p style="color: #666; font-size: 14px; margin-top: 15px;">QR code updates automatically in real-time. Do NOT close this page.</p>
            <script>
                const qrImage = document.getElementById('qr-image');
                const loadingText = document.getElementById('loading-text');
                let currentQr = '';

                function checkStatus() {
                    fetch('/api/status')
                        .then(r => r.json())
                        .then(data => {
                            if (data.isReady) {
                                window.location.href = '/';
                                return;
                            }
                            if (data.qrCodeData && data.qrCodeData !== currentQr) {
                                currentQr = data.qrCodeData;
                                qrImage.src = currentQr;
                                qrImage.style.display = 'block';
                                loadingText.style.display = 'none';
                            } else if (!data.qrCodeData) {
                                qrImage.style.display = 'none';
                                loadingText.style.display = 'block';
                            }
                        })
                        .catch(err => console.error('Status check error:', err));
                }

                setInterval(checkStatus, 2000);
                checkStatus();
            </script>
        </div>
    `);
});

// ─── API Endpoint to send WhatsApp message ───

app.post('/api/send', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const expectedApiKey = process.env.API_KEY || 'Vikirthan@WhatsApp2026';

    if (apiKey !== expectedApiKey) {
        return res.status(403).json({ error: "Access Denied. Invalid API Key." });
    }

    if (!isReady || !sock) {
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
    const jid = cleanPhone + '@s.whatsapp.net';

    try {
        await sock.sendMessage(jid, { text: message });
        console.log(`Successfully sent WhatsApp message to: ${cleanPhone}`);
        res.json({ success: true, message: `WhatsApp message dispatched to ${cleanPhone}.` });
    } catch (err) {
        console.error(`Failed to send WhatsApp message to ${cleanPhone}:`, err.message);
        res.status(500).json({ error: `Failed to dispatch WhatsApp message: ${err.message}` });
    }
});

// ─── Start the server and WhatsApp client ───

app.listen(PORT, () => {
    console.log(`WhatsApp microservice running on port ${PORT}`);
    startWhatsApp().catch(err => {
        console.error('Error starting WhatsApp client:', err.message);
    });
});
