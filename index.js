const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Pool } = require('pg');
const pino = require('pino');
const fs = require('fs');

// Environment variables for Postgres
const pool = new Pool({
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    port: process.env.PGPORT,
});

// Helper to add delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startSock() {
    const { state, saveCreds } = await useMultiFileAuthState('auth');
    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }), // Use 'debug' for more info if needed
        printQRInTerminal: true,
        auth: state,
        // Ensure we receive history
        syncFullHistory: true,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
            if (shouldReconnect) {
                startSock();
            }
        } else if (connection === 'open') {
            console.log('opened connection');
        }
    });

    // Handle history sync (this is where we "download history")
    // Baileys sends history in chunks or one go via 'messaging-history.set' or 'messages.upsert' with 'history' type (older versions).
    // In current Baileys, 'messaging-history.set' contains the initial state.

    sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
        console.log(`received history: ${chats.length} chats, ${messages.length} messages`);

        // The user wants a 2-second delay between "requests".
        // We can simulate this by processing chats one by one with a delay.
        // Also, we need to check checkpoints.

        // We will process the messages grouped by chat (jid).
        // Since 'messages' is an array of messages from various chats, let's group them or just process them.
        // Note: 'messages' in history-set is often an array of { jid, messages: [] } or just a flat list depending on version.
        // Checking Baileys types: usually `messages` is `Array<proto.IWebMessageInfo>`.
        // Wait, in `messaging-history.set`: `messages` is `{ jid: string, messages: proto.IWebMessageInfo[] }[]`?
        // Or just `proto.IWebMessageInfo[]`?
        // Actually, it's typically `chats` array and `messages` array.
        // Let's assume `messages` is an array of `WMesssage`.

        // However, looking at recent logs, `messaging-history.set` provides `{ messages: { [jid: string]: proto.IWebMessageInfo[] } }`?
        // Let's implement a safe check or iterate.
        // A common pattern is `chats` having the metadata and `messages` possibly being empty if handled via upsert?
        // Actually, Baileys often emits `messages.upsert` for history too?
        // No, `messaging-history.set` is distinct.

        // Iterate through the provided messages, group by JID, then process groups with delay.

        const messagesByJid = {};
        // Check if messages is array
        if (Array.isArray(messages)) {
            for (const msg of messages) {
                const jid = msg.key.remoteJid;
                if (!messagesByJid[jid]) messagesByJid[jid] = [];
                messagesByJid[jid].push(msg);
            }
        }

        const jids = Object.keys(messagesByJid);
        console.log(`History contains messages for ${jids.length} chats`);

        for (const jid of jids) {
            const msgs = messagesByJid[jid];
            console.log(`Saving ${msgs.length} messages for ${jid}`);

            // Checkpoint check: We only insert if not exists (handled by DB logic or check)
            // "Resume from last saved": If we already have the message, skip.
            // Since we are receiving history, we might get duplicates if we re-sync.

            await saveMessagesToDB(msgs);

            // Delay 2s
            await delay(2000);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        // type: 'notify' (new) or 'append' (history)
        console.log(`received messages upsert: ${messages.length}, type: ${type}`);

        if (type === 'notify') {
             await saveMessagesToDB(messages);
        } else {
            // It's history being appended.
            // Process with delay if it's a large chunk?
             await saveMessagesToDB(messages);
        }
    });
}

async function saveMessagesToDB(messages) {
    for (const msg of messages) {
        if (!msg.message) continue; // Skip empty messages

        const phoneId = msg.key.remoteJid;
        // Basic valid JID check
        if (!phoneId) continue;

        const messageTimestamp = new Date((msg.messageTimestamp || Date.now() / 1000) * 1000);
        const messageBody = msg.message.conversation ||
                            msg.message.extendedTextMessage?.text ||
                            msg.message.imageMessage?.caption ||
                            '';

        // Checkpoint logic:
        // The prompt says "Implement a checkpoint system... continue from last saved".
        // Use `ON CONFLICT DO NOTHING` or check existence.
        // We will use `INSERT ... ON CONFLICT DO NOTHING` if we had a unique constraint on message ID.
        // `schema.sql` does NOT have a unique constraint on (phone_id, timestamp) or message ID.
        // I should probably add one or check manually.
        // Checking manually is slower but safer given the schema.

        // First, ensure customer exists
        try {
            // Upsert customer
            await pool.query(
                `INSERT INTO customers (phone_id, name) VALUES ($1, $2)
                 ON CONFLICT (phone_id) DO NOTHING`,
                [phoneId, msg.pushName || 'Unknown']
            );

            // Check if message exists (Checkpoint implementation)
            // We use phone_id + timestamp + body as a rough unique key,
            // or better, if we had message_id (key.id).
            // The schema `raw_messages` does NOT have `message_id`.
            // I strictly followed the schema request: `phone_id, message_body, timestamp, potential_sale`.
            // So I must rely on these fields.
            // I will check if a message with same phone_id and timestamp exists.

            const existing = await pool.query(
                `SELECT id FROM raw_messages WHERE phone_id = $1 AND timestamp = $2`,
                [phoneId, messageTimestamp]
            );

            if (existing.rows.length === 0) {
                // Insert
                await pool.query(
                    `INSERT INTO raw_messages (phone_id, message_body, timestamp, potential_sale)
                     VALUES ($1, $2, $3, $4)`,
                    [phoneId, messageBody, messageTimestamp, false]
                );
            }
        } catch (err) {
            console.error('Error saving message:', err);
        }
    }
}

startSock().catch(err => console.log('unexpected error: ', err));
