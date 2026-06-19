import express from 'express';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import pino from 'pino';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;
const AUTH_DIR = './auth_info';

app.use(express.json());

let qrCodeData = '';
let isReady = false;
let sock = null;
let retryCount = 0;
const MAX_RETRIES = 3;

const logger = pino({ level: 'silent' });

function clearAuthState() {
    try {
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            console.log('Auth state cleared.');
        }
    } catch (err) {
        console.error('Error clearing auth:', err.message);
    }
}

async function connectWhatsApp() {
    // Fetch the latest WhatsApp Web version to avoid 405 errors
    let version;
    try {
        const versionInfo = await fetchLatestBaileysVersion();
        version = versionInfo.version;
        console.log('Using WhatsApp Web version:', version);
    } catch (err) {
        console.warn('Could not fetch latest version, using default:', err.message);
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const socketConfig = {
        auth: state,
        logger,
        printQRInTerminal: false,
        browser: ['Sreshta', 'Chrome', '1.0.0'],
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
    };

    // Only add version if we successfully fetched it
    if (version) {
        socketConfig.version = version;
    }

    sock = makeWASocket(socketConfig);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('QR Code generated. Visit /qr to scan.');
            retryCount = 0;
            try {
                qrCodeData = await qrcode.toDataURL(qr);
            } catch (err) {
                console.error('QR error:', err);
            }
        }

        if (connection === 'open') {
            console.log('SUCCESS: WhatsApp connected!');
            isReady = true;
            qrCodeData = '';
            retryCount = 0;
        }

        if (connection === 'close') {
            isReady = false;
            qrCodeData = '';
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.warn('Connection closed. Code:', statusCode);

            // Logged out — clear auth, start fresh
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
                console.log('Logged out. Clearing auth...');
                clearAuthState();
                retryCount = 0;
                setTimeout(() => connectWhatsApp(), 3000);
                return;
            }

            // 405 = version mismatch — clear auth AND re-fetch version
            if (statusCode === 405) {
                retryCount++;
                if (retryCount <= MAX_RETRIES) {
                    console.log(`Version mismatch (405). Clearing auth, retry ${retryCount}/${MAX_RETRIES}...`);
                    clearAuthState();
                    setTimeout(() => connectWhatsApp(), 5000);
                } else {
                    console.error('Max 405 retries reached. Waiting 60s before next attempt...');
                    retryCount = 0;
                    clearAuthState();
                    setTimeout(() => connectWhatsApp(), 60000);
                }
                return;
            }

            // Other errors — reconnect with backoff
            retryCount++;
            if (retryCount <= MAX_RETRIES) {
                const wait = Math.min(retryCount * 3000, 15000);
                console.log(`Reconnecting in ${wait / 1000}s (attempt ${retryCount}/${MAX_RETRIES})...`);
                setTimeout(() => connectWhatsApp(), wait);
            } else {
                console.error('Max retries reached. Waiting 60s...');
                retryCount = 0;
                setTimeout(() => connectWhatsApp(), 60000);
            }
        }
    });
}

// ─── Routes ───

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
                <h2 style="color: #075E54;">✅ WhatsApp is connected!</h2>
                <p><a href="/">Go Back Home</a></p>
            </div>
        `);
    }
    res.send(`
        <div style="font-family: Arial, sans-serif; text-align: center; margin-top: 50px;">
            <h2 style="color: #128C7E;">Scan this QR code with WhatsApp → Linked Devices</h2>
            <div id="qr-box" style="margin-top: 20px; min-height: 300px; display: flex; flex-direction: column; justify-content: center; align-items: center;">
                <p id="msg">⏳ Generating QR Code... Please wait.</p>
                <img id="qr" src="" alt="QR" style="border: 2px solid #333; padding: 10px; display: none; max-width: 300px;">
            </div>
            <p style="color: #666; font-size: 14px; margin-top: 15px;">QR updates automatically. Do NOT close this page.</p>
            <script>
                const img = document.getElementById('qr');
                const msg = document.getElementById('msg');
                let prev = '';
                setInterval(() => {
                    fetch('/api/status').then(r => r.json()).then(d => {
                        if (d.isReady) { window.location.href = '/'; return; }
                        if (d.qrCodeData && d.qrCodeData !== prev) {
                            prev = d.qrCodeData;
                            img.src = prev;
                            img.style.display = 'block';
                            msg.style.display = 'none';
                        }
                    }).catch(() => {});
                }, 2000);
            </script>
        </div>
    `);
});

app.post('/api/send', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const expectedKey = process.env.API_KEY || 'Vikirthan@WhatsApp2026';

    if (apiKey !== expectedKey) return res.status(403).json({ error: 'Invalid API Key.' });
    if (!isReady || !sock) return res.status(503).json({ error: 'WhatsApp not connected. Scan QR at /qr.' });

    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: "Missing 'phone' or 'message'." });

    let cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone;

    try {
        await sock.sendMessage(cleanPhone + '@s.whatsapp.net', { text: message });
        console.log(`Sent to: ${cleanPhone}`);
        res.json({ success: true, message: `Sent to ${cleanPhone}.` });
    } catch (err) {
        console.error(`Send failed (${cleanPhone}):`, err.message);
        res.status(500).json({ error: `Send failed: ${err.message}` });
    }
});

// ─── Start ───

app.listen(PORT, () => {
    console.log(`WhatsApp microservice on port ${PORT}`);
    connectWhatsApp().catch(err => console.error('Startup error:', err.message));
});
