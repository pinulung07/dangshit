# DeepSeek Wrapper for OpenClaw

OpenAI-compatible REST API wrapper untuk DeepSeek (via Android app API).
Didesain untuk dicolok ke OpenClaw sebagai custom Model Provider.

---

## Setup di VPS

### 1. Upload & Install

```bash
# Upload folder ini ke VPS, lalu:
cd deepseek-wrapper
npm install
```

### 2. Jalankan

```bash
# Set akun DeepSeek (bisa multi-akun, pisah koma)
export DEEPSEEK_ACCOUNTS="email1@gmail.com:password1,email2@gmail.com:password2"

# Optional: proteksi dengan API key
export API_SECRET="rahasia123"

# Optional: ganti port (default 3000)
export PORT=3000

# Start!
node server.mjs
```

### 3. Jalankan sebagai background process (pakai PM2)

```bash
npm install -g pm2

DEEPSEEK_ACCOUNTS="email:pass" API_SECRET="rahasia123" pm2 start server.mjs --name deepseek-wrapper
pm2 save
pm2 startup
```

### 4. Cek status

```bash
curl http://localhost:3000/health
# → {"status":"ok","accounts":1,"ready":true}
```

---

## Config di OpenClaw

Di **Settings → AI & Agents → Models → Model Providers → Add Entry**:

```json
{
  "id": "deepseek",
  "label": "DeepSeek (Wrapper)",
  "baseUrl": "http://localhost:3000/v1",
  "apiKey": "rahasia123",
  "models": [
    {
      "id": "deepseek-chat",
      "label": "DeepSeek Chat",
      "contextWindow": 64000,
      "maxTokens": 8000
    },
    {
      "id": "deepseek-reasoner",
      "label": "DeepSeek R1 (Thinking)",
      "contextWindow": 64000,
      "maxTokens": 8000
    }
  ]
}
```

> Jika OpenClaw dan wrapper jalan di VPS yang sama → pakai `http://localhost:3000/v1`
> Jika beda mesin → ganti dengan IP/domain VPS kamu

---

## Models

| Model ID | Keterangan |
|---|---|
| `deepseek-chat` | DeepSeek V3 — cepat, general purpose |
| `deepseek-reasoner` | DeepSeek R1 — mode thinking, lebih lambat tapi lebih dalam |

---

## Multi-Akun (Round-Robin)

Wrapper otomatis rotate akun yang paling jarang dipakai.
Makin banyak akun = makin besar kapasitas concurrent request.

```bash
export DEEPSEEK_ACCOUNTS="akun1@gmail.com:pass1,akun2@gmail.com:pass2,akun3@gmail.com:pass3"
```

---

## Catatan Penting

- Ini menggunakan **unofficial Android API** — bisa berubah sewaktu-waktu
- Jangan pakai akun utama yang penting
- Buat akun DeepSeek baru khusus untuk ini di: https://chat.deepseek.com
