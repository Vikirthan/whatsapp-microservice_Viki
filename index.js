import express from 'express';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import pino from 'pino';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5001;
const AUTH_DIR = './auth_info';

app.use(express.json());

let qrCodeData = '';
let isReady = false;
let sock = null;
let retryCount = 0;
const MAX_RETRIES = 5;

const logger = pino({ level: 'silent' });

// Clear corrupted auth session
function clearAuthState() {
    console.log('Clearing auth state to start fresh...');
    try {
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            console.log('Auth state cleared successfully.');
        }
    } catch (err) {
        console.error('Error clearing auth state:', err.message);
    }
}

async function connectWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
        auth: state,
        logger,
        printQRInTerminal: false,
        browser: ['Sreshta', 'Chrome', '1.0.0'],
        markOnlineOnConnect: false,
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('New QR Code generated. Visit /qr to scan.');
            retryCount = 0; // Reset retry count when we get a fresh QR
            try {
                qrCodeData = await qrcode.toDataURL(qr);
            } catch (err) {
                console.error('QR generation error:', err);
            }
        }

        if (connection === 'open') {
            console.log('SUCCESS: WhatsApp is fully connected and ready!');
            isReady = true;
            qrCodeData = '';
            retryCount = 0;
        }

        if (connection === 'close') {
            isReady = false;
            qrCodeData = '';
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.warn('Connection closed. Status code:', statusCode);

            // 401 = logged out, 405 = bad session/method not allowed
            // For these, clear auth and start completely fresh
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 405) {
                console.log('Session invalid (code ' + statusCode + '). Clearing auth and restarting...');
                clearAuthState();
                retryCount = 0;
                setTimeout(() => connectWhatsApp(), 2000);
                return;
            }

            // For other errors, retry with a limit
            retryCount++;
            if (retryCount <= MAX_RETRIES) {
                const delay = Math.min(retryCount * 3000, 15000); // 3s, 6s, 9s, 12s, 15s
                console.log(`Reconnecting in ${delay / 1000}s... (attempt ${retryCount}/${MAX_RETRIES})`);
                setTimeout(() => connectWhatsApp(), delay);
            } else {
                console.error(`Max retries (${MAX_RETRIES}) reached. Clearing auth and restarting fresh...`);
                clearAuthState();
                retryCount = 0;
                setTimeout(() => connectWhatsApp(), 5000);
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
                <h2 style="color: #075E54;">✅ WhatsApp is already connected!</h2>
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

// ─── Send Message API ───

app.post('/api/send', async (req, res) => {
    const apiKey = req.headers['x-api-key'];
    const expectedKey = process.env.API_KEY || 'Vikirthan@WhatsApp2026';

    if (apiKey !== expectedKey) {
        return res.status(403).json({ error: 'Access Denied. Invalid API Key.' });
    }
    if (!isReady || !sock) {
        return res.status(503).json({ error: 'WhatsApp not connected. Scan QR at /qr first.' });
    }

    const { phone, message } = req.body;
    if (!phone || !message) {
        return res.status(400).json({ error: "Missing 'phone' or 'message'." });
    }

    let cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone;
    const jid = cleanPhone + '@s.whatsapp.net';

    try {
        await sock.sendMessage(jid, { text: message });
        console.log(`Sent WhatsApp to: ${cleanPhone}`);
        res.json({ success: true, message: `Message sent to ${cleanPhone}.` });
    } catch (err) {
        console.error(`Failed to send to ${cleanPhone}:`, err.message);
        res.status(500).json({ error: `Send failed: ${err.message}` });
    }
});

// ─── Start ───

app.listen(PORT, () => {
    console.log(`WhatsApp microservice running on port ${PORT}`);
    connectWhatsApp().catch(err => console.error('Startup error:', err.message));
});
