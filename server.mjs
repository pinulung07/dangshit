/**
 * DeepSeek → OpenAI-Compatible API Wrapper
 * Uses original deepseek.mjs logic verbatim
 */

import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import https from 'https';
import vm from 'vm';
import FormData from 'form-data';

const PORT       = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || null;

// Format: "email1:pass1,email2:pass2"
const ACCOUNTS = (process.env.DEEPSEEK_ACCOUNTS || '')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(e => { const [email, ...rest] = e.split(':'); return { email, password: rest.join(':') }; });

// ─── Original deepseek.mjs code ───────────────────────────────────────────────

const CONFIG = {
    BASE_URL: "https://chat.deepseek.com/api/v0",
    HEADERS: {
        'User-Agent': 'DeepSeek/1.6.4 Android/35',
        'Accept': 'application/json',
        'x-client-platform': 'android',
        'x-client-version': '1.6.4',
        'x-client-locale': 'id',
        'x-client-bundle-id': 'com.deepseek.chat',
        'x-rangers-id': '7392079989945982465',
        'accept-charset': 'UTF-8'
    }
};

const utils = {
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),

    generateDeviceId: () => {
        const baseId = "BUelgEoBdkHyhwE8q/4YOodITQ1Ef99t7Y5KAR4CyHwdApr+lf4LJ+QAKXEUJ2lLtPQ+mmFtt6MpbWxpRmnWITA==";
        let chars = baseId.split('');
        const start = 50;
        const end = 70;
        const changes = Math.floor(Math.random() * 3) + 2;
        const possibleChars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        for (let i = 0; i < changes; i++) {
            const randomIndex = Math.floor(Math.random() * (end - start)) + start;
            chars[randomIndex] = possibleChars.charAt(Math.floor(Math.random() * possibleChars.length));
        }
        return chars.join('');
    },

    parseSSE: (chunk) => {
        const lines = chunk.toString().split('\n');
        const events = [];
        let currentEvent = { event: 'message', data: '' };
        for (const line of lines) {
            if (line.startsWith('event:')) {
                if (currentEvent.data) events.push({ ...currentEvent });
                currentEvent = { event: line.substring(6).trim(), data: '' };
            } else if (line.startsWith('data:')) {
                currentEvent.data += line.substring(5).trim();
            } else if (line === '' && currentEvent.data) {
                events.push({ ...currentEvent });
                currentEvent = { event: 'message', data: '' };
            }
        }
        if (currentEvent.data) events.push(currentEvent);
        return events;
    }
};

const WORKER_URL = 'https://static.deepseek.com/chat/static/33614.25c7f8f220.js';
const WASM_URL = 'https://static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
let workerCache = null;
let wasmCache = null;

function download(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            const data = [];
            res.on('data', chunk => data.push(chunk));
            res.on('end', () => resolve(Buffer.concat(data)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function loadAssets() {
    if (!workerCache) workerCache = (await download(WORKER_URL)).toString();
    if (!wasmCache) wasmCache = await download(WASM_URL);
    return { workerScript: workerCache, wasmBuffer: wasmCache };
}

function generateFinalToken(originalPayload, answer) {
    const jsonBody = {
        algorithm: originalPayload.algorithm,
        challenge: originalPayload.challenge,
        salt: originalPayload.salt,
        answer: answer,
        signature: originalPayload.signature,
        target_path: originalPayload.target_path
    };
    return Buffer.from(JSON.stringify(jsonBody)).toString('base64');
}

async function solvePow(payload) {
    const cleanPayload = {
        algorithm: payload.algorithm,
        challenge: payload.challenge,
        salt: payload.salt,
        difficulty: payload.difficulty,
        signature: payload.signature,
        expireAt: payload.expire_at || payload.expireAt
    };

    const { workerScript, wasmBuffer } = await loadAssets();

    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error('PoW timeout'));
        }, 60000);

        class MockResponse {
            constructor(buffer) {
                this.buffer = buffer;
                this.ok = true;
                this.status = 200;
                this.headers = { get: () => 'application/wasm' };
            }
            async arrayBuffer() { return this.buffer; }
        }

        const sandbox = {
            console: { log: () => {} },
            setTimeout, clearTimeout, setInterval, clearInterval,
            TextEncoder, TextDecoder, URL,
            Response: MockResponse,
            location: {
                href: WORKER_URL,
                origin: 'https://static.deepseek.com',
                pathname: '/chat/static/33614.25c7f8f220.js',
                toString: () => WORKER_URL
            },
            WebAssembly: {
                Module: WebAssembly.Module,
                Instance: WebAssembly.Instance,
                instantiate: WebAssembly.instantiate,
                validate: WebAssembly.validate,
                Memory: WebAssembly.Memory,
                Table: WebAssembly.Table,
                Global: WebAssembly.Global,
                CompileError: WebAssembly.CompileError,
                LinkError: WebAssembly.LinkError,
                RuntimeError: WebAssembly.RuntimeError
            },
            fetch: async (input) => {
                if (input.toString().includes('wasm')) return new MockResponse(wasmBuffer);
                throw new Error("Blocked");
            },
            postMessage: (msg) => {
                if (msg && msg.type === 'pow-answer') {
                    clearTimeout(timeoutId);
                    resolve(generateFinalToken(payload, msg.answer.answer));
                } else if (msg && msg.type === 'pow-error') {
                    clearTimeout(timeoutId);
                    reject(new Error('POW worker error: ' + JSON.stringify(msg.error)));
                }
            }
        };

        sandbox.self = sandbox;
        sandbox.window = sandbox;
        sandbox.globalThis = sandbox;

        const context = vm.createContext(sandbox);

        try {
            vm.runInContext(workerScript, context);
            setTimeout(() => {
                if (sandbox.onmessage) {
                    sandbox.onmessage({ data: { type: "pow-challenge", challenge: cleanPayload } });
                } else if (sandbox.self && sandbox.self.onmessage) {
                    sandbox.self.onmessage({ data: { type: "pow-challenge", challenge: cleanPayload } });
                } else {
                    reject(new Error('Worker tidak memiliki handler onmessage'));
                }
            }, 1000);
        } catch (e) {
            clearTimeout(timeoutId);
            reject(e);
        }
    });
}

async function getPowToken(token, targetPath) {
    try {
        const response = await axios.post(`${CONFIG.BASE_URL}/chat/create_pow_challenge`,
            { target_path: targetPath },
            { headers: { ...CONFIG.HEADERS, 'Authorization': `Bearer ${token}` } }
        );
        const challengeData = response.data.data.biz_data.challenge;
        return await solvePow(challengeData);
    } catch (e) {
        return null;
    }
}

const deepseek = {
    login: async (email, password) => {
        try {
            const deviceId = utils.generateDeviceId();
            const response = await axios.post(`${CONFIG.BASE_URL}/users/login`, {
                email, password, device_id: deviceId, os: 'android'
            }, { headers: CONFIG.HEADERS });

            if (response.data.code !== 0) throw new Error(response.data.msg);

            return {
                token: response.data.data.biz_data.user.token,
                user: response.data.data.biz_data.user
            };
        } catch (error) {
            console.error(`Login error: ${error.message}`);
            return null;
        }
    },

    createSession: async (token) => {
        try {
            const response = await axios.post(`${CONFIG.BASE_URL}/chat_session/create`, {}, {
                headers: { ...CONFIG.HEADERS, 'Authorization': `Bearer ${token}` }
            });
            if (response.data.code !== 0) throw new Error('Failed to create session');
            return response.data.data.biz_data.id;
        } catch (error) {
            console.error(`Create session error: ${error.message}`);
            return null;
        }
    },

    chat: async (token, sessionId, prompt, options = {}) => {
        try {
            const powToken = await getPowToken(token, '/api/v0/chat/completion');
            if (!powToken) throw new Error('Failed to solve PoW');

            const payload = {
                chat_session_id: sessionId,
                parent_message_id: options.parentMessageId || null,
                prompt: prompt,
                ref_file_ids: options.fileIds || [],
                thinking_enabled: options.thinkingEnabled || false,
                search_enabled: options.searchEnabled || false,
                audio_id: null
            };

            const response = await axios.post(`${CONFIG.BASE_URL}/chat/completion`, payload, {
                headers: {
                    ...CONFIG.HEADERS,
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                    'x-ds-pow-response': powToken
                },
                responseType: 'stream'
            });

            let fullText = '';
            let currentFragment = null;
            let buffer = '';

            const findFragmentType = (obj) => {
                if (obj.type === 'THINK' || obj.type === 'SEARCH' || obj.type === 'RESPONSE') return obj.type;
                if (Array.isArray(obj.v)) {
                    for (const item of obj.v) {
                        const found = findFragmentType(item);
                        if (found) return found;
                    }
                }
                return null;
            };

            const extractText = (obj) => {
                if (obj.content && typeof obj.content === 'string') return obj.content;
                if (Array.isArray(obj.v)) return obj.v.map(extractText).join('');
                return '';
            };

            return new Promise((resolve, reject) => {
                response.data.on('data', (chunk) => {
                    buffer += chunk.toString();
                    const lines = buffer.split('\n\n');
                    buffer = lines.pop() || '';
                    for (const line of lines) {
                        const events = utils.parseSSE(line + '\n\n');
                        for (const event of events) {
                            if (!event.data || event.data === ':' || event.event === 'keep-alive') continue;
                            try {
                                const parsed = JSON.parse(event.data);
                                const newType = findFragmentType(parsed);
                                if (newType) currentFragment = newType;
                                let contentToAdd = extractText(parsed);
                                if (!contentToAdd && typeof parsed.v === 'string') {
                                    if (!parsed.p || parsed.p.endsWith('content')) contentToAdd = parsed.v;
                                }
                                if (contentToAdd && (!currentFragment || currentFragment === 'RESPONSE')) {
                                    fullText += contentToAdd;
                                }
                            } catch (e) {}
                        }
                    }
                });
                response.data.on('end', () => resolve(fullText.trim() || 'No response'));
                response.data.on('error', reject);
            });

        } catch (error) {
            console.error(`Chat error: ${error.message}`);
            return null;
        }
    },

    chatStream: async (token, sessionId, prompt, options = {}, onChunk, onDone, onError) => {
        try {
            const powToken = await getPowToken(token, '/api/v0/chat/completion');
            if (!powToken) { onError(new Error('Failed to solve PoW')); return; }

            const payload = {
                chat_session_id: sessionId,
                parent_message_id: null,
                prompt,
                ref_file_ids: [],
                thinking_enabled: options.thinkingEnabled || false,
                search_enabled: options.searchEnabled || false,
                audio_id: null
            };

            const response = await axios.post(`${CONFIG.BASE_URL}/chat/completion`, payload, {
                headers: {
                    ...CONFIG.HEADERS,
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                    'x-ds-pow-response': powToken
                },
                responseType: 'stream'
            });

            let buffer = '';
            let currentFragment = null;

            const findFragmentType = (obj) => {
                if (obj.type === 'THINK' || obj.type === 'SEARCH' || obj.type === 'RESPONSE') return obj.type;
                if (Array.isArray(obj.v)) {
                    for (const item of obj.v) { const found = findFragmentType(item); if (found) return found; }
                }
                return null;
            };

            const extractText = (obj) => {
                if (obj.content && typeof obj.content === 'string') return obj.content;
                if (Array.isArray(obj.v)) return obj.v.map(extractText).join('');
                return '';
            };

            response.data.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    const events = utils.parseSSE(line + '\n\n');
                    for (const event of events) {
                        if (!event.data || event.data === ':' || event.event === 'keep-alive') continue;
                        try {
                            const parsed = JSON.parse(event.data);
                            const newType = findFragmentType(parsed);
                            if (newType) currentFragment = newType;
                            let txt = extractText(parsed);
                            if (!txt && typeof parsed.v === 'string') txt = parsed.v;
                            if (txt && (!currentFragment || currentFragment === 'RESPONSE')) onChunk(txt);
                        } catch (e) {}
                    }
                }
            });
            response.data.on('end', onDone);
            response.data.on('error', onError);

        } catch (error) {
            onError(error);
        }
    }
};

// ─── Account Pool ─────────────────────────────────────────────────────────────

const pool = []; // { email, token, sessionId, busy, lastUsed }
let poolReady = false;

async function initPool() {
    if (!ACCOUNTS.length) {
        console.warn('[WARN] No DEEPSEEK_ACCOUNTS set. Format: email:pass,email2:pass2');
        poolReady = true;
        return;
    }
    console.log(`[INIT] Logging in ${ACCOUNTS.length} account(s)...`);
    for (const acc of ACCOUNTS) {
        try {
            const auth = await deepseek.login(acc.email, acc.password);
            if (!auth) throw new Error('Login returned null');
            const sessionId = await deepseek.createSession(auth.token);
            if (!sessionId) throw new Error('Session creation returned null');
            pool.push({ email: acc.email, token: auth.token, sessionId, busy: false, lastUsed: 0 });
            console.log(`[OK] ${acc.email}`);
        } catch (e) {
            console.error(`[FAIL] ${acc.email}: ${e.message}`);
        }
    }
    poolReady = true;
    console.log(`[READY] ${pool.length}/${ACCOUNTS.length} accounts active\n`);
}

const getAccount = () => pool.filter(a => !a.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0] || null;

function buildPrompt(messages) {
    return messages.map(m => {
        const role = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User';
        return `${role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`;
    }).join('\n') + '\nAssistant:';
}

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '4mb' }));

app.use((req, res, next) => {
    if (!API_SECRET) return next();
    if ((req.headers.authorization || '') === `Bearer ${API_SECRET}`) return next();
    res.status(401).json({ error: { message: 'Unauthorized', type: 'auth_error' } });
});

app.get('/health', (_, res) => res.json({ status: 'ok', accounts: pool.length, ready: poolReady }));

app.get('/v1/models', (_, res) => res.json({
    object: 'list',
    data: [
        { id: 'deepseek-chat',     object: 'model', owned_by: 'deepseek' },
        { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek' }
    ]
}));

app.post('/v1/chat/completions', async (req, res) => {
    if (!poolReady) return res.status(503).json({ error: { message: 'Initializing', type: 'server_error' } });
    const acc = getAccount();
    if (!acc) return res.status(429).json({ error: { message: 'All accounts busy', type: 'rate_limit_error' } });

    acc.busy = true;
    acc.lastUsed = Date.now();

    const { messages = [], stream = false, model = 'deepseek-chat' } = req.body;
    const thinking = model === 'deepseek-reasoner';
    const prompt   = buildPrompt(messages);
    const msgId    = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;

    try {
        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            const send = delta => res.write(`data: ${JSON.stringify({
                id: msgId, object: 'chat.completion.chunk', model,
                choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
            })}\n\n`);

            await deepseek.chatStream(acc.token, acc.sessionId, prompt, { thinkingEnabled: thinking },
                send,
                () => {
                    res.write(`data: ${JSON.stringify({ id: msgId, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                    acc.busy = false;
                },
                (e) => { console.error('[STREAM ERR]', e.message); res.end(); acc.busy = false; }
            );
        } else {
            const text = await deepseek.chat(acc.token, acc.sessionId, prompt, { thinkingEnabled: thinking });
            res.json({
                id: msgId, object: 'chat.completion', model,
                choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
            });
            acc.busy = false;
        }
    } catch (e) {
        acc.busy = false;
        console.error('[ERR]', e.message);
        res.status(500).json({ error: { message: e.message, type: 'api_error' } });
    }
});

app.listen(PORT, async () => {
    console.log(`\n🦀 DeepSeek Wrapper — port ${PORT}`);
    console.log(`   /health               → status`);
    console.log(`   /v1/models            → model list`);
    console.log(`   /v1/chat/completions  → chat\n`);
    await initPool();
});
