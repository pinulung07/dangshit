/**
 * DeepSeek → OpenAI-Compatible API Wrapper
 * For use with OpenClaw Model Providers
 */

import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import https from 'https';
import vm from 'vm';

const PORT       = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || null;

// Format: "email1:pass1,email2:pass2"
const ACCOUNTS = (process.env.DEEPSEEK_ACCOUNTS || '')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(e => { const [email, password] = e.split(':'); return { email, password }; });

// ─── DeepSeek internals ───────────────────────────────────────────────────────

const DS_BASE    = 'https://chat.deepseek.com/api/v0';
const DS_HEADERS = {
  'User-Agent': 'DeepSeek/1.6.4 Android/35',
  'Accept': 'application/json',
  'x-client-platform': 'android',
  'x-client-version': '1.6.4',
  'x-client-locale': 'id',
  'x-client-bundle-id': 'com.deepseek.chat',
  'x-rangers-id': '7392079989945982465',
  'accept-charset': 'UTF-8'
};

const WORKER_URL = 'https://static.deepseek.com/chat/static/33614.25c7f8f220.js';
const WASM_URL   = 'https://static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
let workerCache  = null;
let wasmCache    = null;

const dlBuf = url => new Promise((res, rej) => {
  https.get(url, r => { const d=[]; r.on('data',c=>d.push(c)); r.on('end',()=>res(Buffer.concat(d))); r.on('error',rej); }).on('error',rej);
});

async function loadAssets() {
  if (!workerCache) workerCache = (await dlBuf(WORKER_URL)).toString();
  if (!wasmCache)   wasmCache   = await dlBuf(WASM_URL);
  return { workerScript: workerCache, wasmBuffer: wasmCache };
}

function genDeviceId() {
  const base = 'BUelgEoBdkHyhwE8q/4YOodITQ1Ef99t7Y5KAR4CyHwdApr+lf4LJ+QAKXEUJ2lLtPQ+mmFtt6MpbWxpRmnWITA==';
  const chars = base.split('');
  const pool  = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < Math.floor(Math.random()*3)+2; i++) {
    chars[Math.floor(Math.random()*20)+50] = pool[Math.floor(Math.random()*pool.length)];
  }
  return chars.join('');
}

async function solvePow(payload) {
  const clean = { algorithm: payload.algorithm, challenge: payload.challenge, salt: payload.salt, difficulty: payload.difficulty, signature: payload.signature, expireAt: payload.expire_at || payload.expireAt };
  const { workerScript, wasmBuffer } = await loadAssets();
  return new Promise((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error('PoW timeout')), 60000);
    class MockResp { constructor(b){this.buffer=b;this.ok=true;this.status=200;this.headers={get:()=>'application/wasm'};} async arrayBuffer(){return this.buffer;} }
    const sb = { console:{log:()=>{}}, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, TextDecoder, URL, Response: MockResp,
      location:{href:WORKER_URL,origin:'https://static.deepseek.com',pathname:'/chat/static/33614.25c7f8f220.js',toString:()=>WORKER_URL},
      WebAssembly, fetch: async(input)=>{ if(input.toString().includes('wasm')) return new MockResp(wasmBuffer); throw new Error('Blocked'); },
      postMessage: (msg) => { if(msg?.type==='pow-answer'){clearTimeout(tid);resolve(Buffer.from(JSON.stringify({algorithm:payload.algorithm,challenge:payload.challenge,salt:payload.salt,answer:msg.answer.answer,signature:payload.signature,target_path:payload.target_path})).toString('base64'));}
        else if(msg?.type==='pow-error'){clearTimeout(tid);reject(new Error('PoW error'));} }
    };
    sb.self=sb; sb.window=sb; sb.globalThis=sb;
    const ctx = vm.createContext(sb);
    try {
      vm.runInContext(workerScript, ctx);
      setTimeout(() => { const h=sb.onmessage||sb.self?.onmessage; if(h) h({data:{type:'pow-challenge',challenge:clean}}); else reject(new Error('No handler')); }, 1000);
    } catch(e) { clearTimeout(tid); reject(e); }
  });
}

async function getPowToken(token, targetPath) {
  try {
    const r = await axios.post(`${DS_BASE}/chat/create_pow_challenge`, {target_path:targetPath}, {headers:{...DS_HEADERS,Authorization:`Bearer ${token}`}});
    return await solvePow(r.data.data.biz_data.challenge);
  } catch { return null; }
}

function parseSSE(chunk) {
  const lines=chunk.toString().split('\n'); const events=[]; let cur={event:'message',data:''};
  for (const line of lines) {
    if(line.startsWith('event:')){if(cur.data)events.push({...cur});cur={event:line.substring(6).trim(),data:''};}
    else if(line.startsWith('data:')){cur.data+=line.substring(5).trim();}
    else if(line===''&&cur.data){events.push({...cur});cur={event:'message',data:''};}
  }
  if(cur.data)events.push(cur);
  return events;
}

function findFragType(obj) {
  if(['THINK','SEARCH','RESPONSE'].includes(obj.type)) return obj.type;
  if(Array.isArray(obj.v)){for(const i of obj.v){const f=findFragType(i);if(f)return f;}}
  return null;
}

function extractText(o) {
  if(o.content&&typeof o.content==='string') return o.content;
  if(Array.isArray(o.v)) return o.v.map(extractText).join('');
  return '';
}

function buildPrompt(messages) {
  return messages.map(m => {
    const r = m.role==='assistant'?'Assistant':m.role==='system'?'System':'User';
    return `${r}: ${typeof m.content==='string'?m.content:JSON.stringify(m.content)}`;
  }).join('\n') + '\nAssistant:';
}

// ─── Account Pool ─────────────────────────────────────────────────────────────

const pool = [];
let poolReady = false;

async function initPool() {
  if (!ACCOUNTS.length) { console.warn('[WARN] No DEEPSEEK_ACCOUNTS set.'); poolReady=true; return; }
  console.log(`[INIT] Logging in ${ACCOUNTS.length} account(s)...`);
  for (const acc of ACCOUNTS) {
    try {
      const r = await axios.post(`${DS_BASE}/users/login`, {email:acc.email,password:acc.password,device_id:genDeviceId(),os:'android'}, {headers:DS_HEADERS});
      if(r.data.code!==0) throw new Error(r.data.msg);
      const token = r.data.data.biz_data.user.token;
      const sr    = await axios.post(`${DS_BASE}/chat_session/create`,{},{headers:{...DS_HEADERS,Authorization:`Bearer ${token}`}});
      const sessionId = sr.data.data.biz_data.id;
      pool.push({email:acc.email,token,sessionId,busy:false,lastUsed:0});
      console.log(`[OK] ${acc.email}`);
    } catch(e) { console.error(`[FAIL] ${acc.email}: ${e.message}`); }
  }
  poolReady = true;
  console.log(`[READY] ${pool.length}/${ACCOUNTS.length} accounts active\n`);
}

const getAccount = () => pool.filter(a=>!a.busy).sort((a,b)=>a.lastUsed-b.lastUsed)[0] || null;

// ─── Chat helpers ─────────────────────────────────────────────────────────────

async function chatNonStream(acc, messages, opts={}) {
  const powToken = await getPowToken(acc.token, '/api/v0/chat/completion');
  if (!powToken) throw new Error('PoW failed');
  const resp = await axios.post(`${DS_BASE}/chat/completion`,
    {chat_session_id:acc.sessionId,parent_message_id:null,prompt:buildPrompt(messages),ref_file_ids:[],thinking_enabled:opts.thinking||false,search_enabled:opts.search||false,audio_id:null},
    {headers:{...DS_HEADERS,'Content-Type':'application/json',Authorization:`Bearer ${acc.token}`,'x-ds-pow-response':powToken},responseType:'stream'}
  );
  return new Promise((resolve, reject) => {
    let full=''; let buf=''; let frag=null;
    resp.data.on('data', chunk => {
      buf+=chunk.toString();
      const lines=buf.split('\n\n'); buf=lines.pop()||'';
      for(const line of lines){
        for(const ev of parseSSE(line+'\n\n')){
          if(!ev.data||ev.data===':'||ev.event==='keep-alive') continue;
          try{const p=JSON.parse(ev.data);const t=findFragType(p);if(t)frag=t;let txt=extractText(p);if(!txt&&typeof p.v==='string')txt=p.v;if(txt&&(!frag||frag==='RESPONSE'))full+=txt;}catch{}
        }
      }
    });
    resp.data.on('end',   ()=>resolve(full.trim()||'No response'));
    resp.data.on('error', reject);
  });
}

async function chatStream(acc, messages, opts={}, onChunk, onDone, onError) {
  const powToken = await getPowToken(acc.token, '/api/v0/chat/completion');
  if (!powToken) { onError(new Error('PoW failed')); return; }
  let resp;
  try {
    resp = await axios.post(`${DS_BASE}/chat/completion`,
      {chat_session_id:acc.sessionId,parent_message_id:null,prompt:buildPrompt(messages),ref_file_ids:[],thinking_enabled:opts.thinking||false,search_enabled:opts.search||false,audio_id:null},
      {headers:{...DS_HEADERS,'Content-Type':'application/json',Authorization:`Bearer ${acc.token}`,'x-ds-pow-response':powToken},responseType:'stream'}
    );
  } catch(e) { onError(e); return; }
  let buf=''; let frag=null;
  resp.data.on('data', chunk => {
    buf+=chunk.toString();
    const lines=buf.split('\n\n'); buf=lines.pop()||'';
    for(const line of lines){
      for(const ev of parseSSE(line+'\n\n')){
        if(!ev.data||ev.data===':'||ev.event==='keep-alive') continue;
        try{const p=JSON.parse(ev.data);const t=findFragType(p);if(t)frag=t;let txt=extractText(p);if(!txt&&typeof p.v==='string')txt=p.v;if(txt&&(!frag||frag==='RESPONSE'))onChunk(txt);}catch{}
      }
    }
  });
  resp.data.on('end',   onDone);
  resp.data.on('error', onError);
}

// ─── Express ──────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({limit:'4mb'}));

app.use((req, res, next) => {
  if (!API_SECRET) return next();
  if ((req.headers.authorization||'')==`Bearer ${API_SECRET}`) return next();
  res.status(401).json({error:{message:'Unauthorized',type:'auth_error'}});
});

app.get('/health', (_, res) => res.json({status:'ok',accounts:pool.length,ready:poolReady}));

app.get('/v1/models', (_, res) => res.json({object:'list',data:[
  {id:'deepseek-chat',    object:'model',owned_by:'deepseek'},
  {id:'deepseek-reasoner',object:'model',owned_by:'deepseek'}
]}));

app.post('/v1/chat/completions', async (req, res) => {
  if (!poolReady) return res.status(503).json({error:{message:'Initializing',type:'server_error'}});
  const acc = getAccount();
  if (!acc)     return res.status(429).json({error:{message:'All accounts busy',type:'rate_limit_error'}});

  acc.busy=true; acc.lastUsed=Date.now();
  const {messages=[],stream=false,model='deepseek-chat'} = req.body;
  const thinking = model==='deepseek-reasoner';
  const msgId    = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;

  try {
    if (stream) {
      res.setHeader('Content-Type','text/event-stream');
      res.setHeader('Cache-Control','no-cache');
      res.setHeader('Connection','keep-alive');
      const send = delta => res.write(`data: ${JSON.stringify({id:msgId,object:'chat.completion.chunk',model,choices:[{index:0,delta:{content:delta},finish_reason:null}]})}\n\n`);
      await chatStream(acc, messages, {thinking}, send,
        () => { res.write(`data: ${JSON.stringify({id:msgId,object:'chat.completion.chunk',model,choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`); res.end(); acc.busy=false; },
        (e) => { console.error('[STREAM ERR]',e.message); res.end(); acc.busy=false; }
      );
    } else {
      const text = await chatNonStream(acc, messages, {thinking});
      res.json({id:msgId,object:'chat.completion',model,choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}});
      acc.busy=false;
    }
  } catch(e) {
    acc.busy=false;
    console.error('[ERR]',e.message);
    res.status(500).json({error:{message:e.message,type:'api_error'}});
  }
});

app.listen(PORT, async () => {
  console.log(`\n🦀 DeepSeek Wrapper — port ${PORT}`);
  console.log(`   /health               → status`);
  console.log(`   /v1/models            → model list`);
  console.log(`   /v1/chat/completions  → chat\n`);
  await initPool();
});
