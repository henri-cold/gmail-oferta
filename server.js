import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  SAFIPAY_CLIENT_ID: CI,
  SAFIPAY_CLIENT_SECRET: CS,
  SAFIPAY_WEBHOOK_SECRET: WEBHOOK_SECRET = '',
  PORT = 3000,
  PRODUCT_PRICE = '47.00',
  CAPI_ACCESS_TOKEN = '',
  CAPI_PIXEL_ID = '1514561190722182',
  UPSTASH_REDIS_REST_URL: REDIS_URL = '',
  UPSTASH_REDIS_REST_TOKEN: REDIS_TOKEN = '',
} = process.env;

// ---- Redis helpers (Upstash REST API) ----
async function redisCmd(command, ...args) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const r = await fetch(`${REDIS_URL}/${[command, ...args].map(encodeURIComponent).join('/')}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const j = await r.json();
    return j.result ?? null;
  } catch { return null; }
}

async function redisPipeline(commands) {
  if (!REDIS_URL || !REDIS_TOKEN) return [];
  try {
    const r = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    });
    const j = await r.json();
    return Array.isArray(j) ? j.map(x => x.result ?? null) : [];
  } catch { return []; }
}

function hgetallToObj(arr) {
  if (!Array.isArray(arr)) return {};
  const obj = {};
  for (let i = 0; i < arr.length - 1; i += 2) obj[arr[i]] = arr[i + 1];
  return obj;
}

const SAFIPAY_BASE = 'https://www.safipaybr.com';

const PRODUCT = {
  name: 'Produto Digital',
  price: Number(PRODUCT_PRICE), // reais
};

if (!CI || !CS) {
  console.error('ERRO: defina SAFIPAY_CLIENT_ID e SAFIPAY_CLIENT_SECRET no arquivo .env');
  process.exit(1);
}

const orders = new Map();

// ---- Admin + Tracking ----
const adminTokens = new Set();
const ADMIN_USER = 'adm.henri';
// sha256('IsaG00gle#2024!X' + '__srv9k2m')
const ADMIN_PASS_HASH = crypto.createHash('sha256').update('IsaG00gle#2024!X__srv9k2m').digest('hex');

async function sendCapiPurchase({ transactionId, amount, email, name }) {
  if (!CAPI_ACCESS_TOKEN) return;
  const userData = {};
  if (email) userData.em = [crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex')];
  if (name) {
    const parts = name.trim().toLowerCase().split(/\s+/);
    userData.fn = [crypto.createHash('sha256').update(parts[0]).digest('hex')];
    if (parts.length > 1) userData.ln = [crypto.createHash('sha256').update(parts[parts.length - 1]).digest('hex')];
  }
  const payload = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_id: transactionId,
      user_data: userData,
      custom_data: { value: amount, currency: 'BRL' },
    }],
  };
  try {
    const r = await fetch(`https://graph.facebook.com/v18.0/${CAPI_PIXEL_ID}/events?access_token=${CAPI_ACCESS_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await r.json().catch(() => ({}));
    console.log(`[capi] Purchase enviado: ${transactionId}`, json.events_received ?? json);
  } catch (err) {
    console.error('[capi] erro ao enviar Purchase:', err);
  }
} // transactionId -> { status, amount, fee, netAmount, email, name, createdAt, paidAt }

const app = express();

// ---- Webhook: precisa do corpo BRUTO para validar a assinatura. Registrar ANTES do express.json. ----
app.post('/webhooks/safipay', express.raw({ type: '*/*' }), (req, res) => {
  const header = req.get('X-SafiPay-Signature-V2') || '';
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  const v1 = parts.v1 || '';

  // Em teste local sem segredo configurado, aceitamos sem validar (NÃO faça isso em produção).
  if (WEBHOOK_SECRET) {
    if (!t || Math.abs(Date.now() / 1000 - t) > 300) return res.sendStatus(400);
    const expected = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(`${t}.`)
      .update(req.body)
      .digest('hex');
    const ok =
      v1.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
    if (!ok) return res.sendStatus(401);
  }

  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.sendStatus(400);
  }

  // Responda rápido; o trabalho pode ser feito depois.
  res.sendStatus(200);

  const { event, data } = payload;
  if (!data || !data.transactionId) return;

  const order = orders.get(data.transactionId);

  if (event === 'pix.paid') {
    // Manda CAPI independente de ter o pedido na memória desta instância Vercel.
    sendCapiPurchase({
      transactionId: data.transactionId,
      amount: order?.amount ?? data.amount ?? Number(PRODUCT_PRICE),
      email: order?.email,
      name: order?.name,
    });
    if (order) {
      order.status = 'paid';
      order.paidAt = data.paidAt || new Date().toISOString();
    }
    console.log(`[webhook] Pedido PAGO: ${data.transactionId}`);
  } else if (order) {
    // Idempotente por transactionId + event (só para eventos com pedido na memória)
    const key = `${data.transactionId}:${event}`;
    if (order._processed?.has(key)) return;
    order._processed = order._processed || new Set();
    order._processed.add(key);

    if (event === 'pix.expired') {
      if (order.status !== 'paid') order.status = 'expired';
    } else if (event === 'pix.failed') {
      if (order.status !== 'paid') order.status = 'failed';
    }
  }
});

app.use(express.json());

// ---- Criar cobrança Pix ----
app.post('/api/create-pix', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 120);
  const email = String(req.body?.email || '').trim().slice(0, 120);

  if (!email) {
    return res.status(400).json({ error: 'Digite sua chave PIX.' });
  }

  const ref = `ebook_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  try {
    const r = await fetch(`${SAFIPAY_BASE}/api/gateway/pix-create`, {
      method: 'POST',
      headers: {
        ci: CI,
        cs: CS,
        'Content-Type': 'application/json',
        'Idempotency-Key': ref,
      },
      body: JSON.stringify({
        amount: PRODUCT.price,
        description: PRODUCT.name,
        payerName: name || undefined,
        externalReference: ref,
      }),
    });

    const json = await r.json().catch(() => ({}));

    if (!r.ok || !json.success) {
      console.error('[pix-create] erro', r.status, json);
      return res.status(502).json({ error: json.error || 'Falha ao gerar o Pix. Tente novamente.' });
    }

    const d = json.data;
    orders.set(d.transactionId, {
      status: d.status || 'pending',
      amount: d.amount,
      fee: d.fee,
      netAmount: d.netAmount,
      email,
      name,
      ref,
      createdAt: new Date().toISOString(),
      paidAt: null,
    });

    // Nunca devolvemos credenciais ao front. Só o necessário para mostrar o Pix.
    res.json({
      transactionId: d.transactionId,
      amount: d.amount,
      qrCodeBase64: d.qrCodeBase64 || null,
      copyPaste: d.copyPaste || null,
      paymentLink: d.paymentLink || null,
      expiresAt: d.expiresAt || null,
    });
  } catch (err) {
    console.error('[pix-create] exceção', err);
    res.status(500).json({ error: 'Erro de conexão com o gateway. Tente novamente.' });
  }
});

// ---- Consultar status (fallback do webhook) ----
app.get('/api/status', async (req, res) => {
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: 'Falta o id.' });

  const order = orders.get(id);

  // Se o webhook já marcou como pago na memória, retorna direto.
  if (order?.status === 'paid') {
    return res.json({ status: 'paid', paidAt: order.paidAt });
  }

  // Consulta sempre a Safipay (memória pode ser de outra instância no Vercel).
  try {
    const r = await fetch(`${SAFIPAY_BASE}/api/gateway/pix-status?transactionId=${encodeURIComponent(id)}`, {
      headers: { ci: CI, cs: CS },
    });
    const json = await r.json().catch(() => ({}));
    if (r.ok && json.success) {
      const status = json.data.status;
      const paidAt = json.data.paidAt || new Date().toISOString();
      if (status === 'paid') {
        console.log(`[status] Pedido PAGO (via consulta): ${id}`);
        if (!order?._capiSent) {
          if (order) order._capiSent = true;
          sendCapiPurchase({ transactionId: id, amount: order?.amount ?? json.data.amount, email: order?.email, name: order?.name });
        }
      }
      return res.json({ status, paidAt: status === 'paid' ? paidAt : null });
    }
    // Safipay falhou: retorna o que tiver na memória ou pending.
    return res.json({ status: order?.status || 'pending', paidAt: order?.paidAt || null });
  } catch (err) {
    console.error('[status] exceção', err);
    return res.json({ status: order?.status || 'pending', paidAt: order?.paidAt || null });
  }
});

// ---- Tracking endpoint ----
app.post('/api/track', express.json(), async (req, res) => {
  res.sendStatus(204); // responde rápido, processa async
  const { sid, ev, ts, step, ...data } = req.body || {};
  if (!sid || !ev) return;
  const now = ts || Date.now();
  const eventJson = JSON.stringify({ ev, ts: now, step: step ?? -1, ...data });
  const metaKey = `session:${sid}:meta`;
  const evtsKey = `session:${sid}:evts`;
  const EXP = 2592000; // 30 dias

  const pipeline = [
    ['ZADD', 'sessions_index', now, sid],
    ['RPUSH', evtsKey, eventJson],
    ['EXPIRE', evtsKey, EXP],
    ['EXPIRE', metaKey, EXP],
  ];

  // Atualiza campos de meta conforme o evento
  const meta = [];
  if (ev === 'page_load') meta.push('ua', data.ua||'', 'mobile', String(data.mobile||false), 'ref', data.ref||'direct', 'screen', data.screen||'', 'createdAt', new Date(now).toISOString());
  if (ev === 'name_submit' && data.name) meta.push('name', data.name);
  if (ev === 'cpf_submit' && data.cpf_masked) meta.push('cpf_masked', data.cpf_masked);
  if (ev === 'pix_type_select' && data.type) meta.push('pixType', data.type);
  if (ev === 'pix_key_submit' && data.key_masked) meta.push('pixKey', data.key_masked);
  if (ev === 'cta_click') meta.push('converted', 'true');

  if (meta.length) pipeline.push(['HSET', metaKey, ...meta]);

  await redisPipeline(pipeline);
});

// ---- Admin login ----
app.post('/api/admin/login', express.json(), (req, res) => {
  const { user, pass } = req.body || {};
  const passHash = crypto.createHash('sha256').update((pass || '') + '__srv9k2m').digest('hex');
  if (user !== ADMIN_USER || passHash !== ADMIN_PASS_HASH) {
    return res.status(401).json({ error: 'Credenciais inválidas.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  adminTokens.add(token);
  res.json({ token });
});

// ---- Admin data ----
app.get('/api/admin/sessions', async (req, res) => {
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (!adminTokens.has(auth)) return res.status(401).json({ error: 'Não autorizado.' });

  const sids = await redisCmd('ZREVRANGE', 'sessions_index', '0', '299') || [];
  if (!sids.length) return res.json({ total: 0, sessions: [] });

  // Para cada sid: HGETALL meta + LRANGE evts — tudo em 1 pipeline
  const cmds = sids.flatMap(sid => [
    ['HGETALL', `session:${sid}:meta`],
    ['LRANGE', `session:${sid}:evts`, '0', '-1'],
  ]);
  const results = await redisPipeline(cmds);

  const sessions = sids.map((sid, i) => {
    const meta = hgetallToObj(results[i * 2] || []);
    const evtsRaw = results[i * 2 + 1] || [];
    const events = evtsRaw.map(e => { try { return JSON.parse(e); } catch { return {}; } });
    return {
      sid,
      ...meta,
      mobile: meta.mobile === 'true',
      converted: meta.converted === 'true',
      events,
    };
  });

  res.json({ total: sessions.length, sessions });
});

// ---- Admin panel ----
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Preço público (para a página montar o valor sem hardcode)
app.get('/api/product', (_req, res) => {
  res.json({ name: PRODUCT.name, price: PRODUCT.price });
});

// ---- Arquivos estáticos ----
app.use(express.static(path.join(__dirname)));
app.get('/logozuda.webp', (_req, res) => {
  res.sendFile(path.join(__dirname, 'logozuda.webp'));
});
app.get('/favicon.svg', (_req, res) => {
  res.sendFile(path.join(__dirname, 'favicon.svg'));
});
app.get('/instagram.png', (_req, res) => {
  res.sendFile(path.join(__dirname, 'instagram.png'));
});
app.get('/piximage.jpg', (_req, res) => {
  res.sendFile(path.join(__dirname, 'piximage.jpg'));
});
app.get('/videos/vsl.mp4', (_req, res) => {
  res.sendFile(path.join(__dirname, 'videos', 'vsl.mp4'));
});
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/index2', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index2.html'));
});
app.get('/index3', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index3.html'));
});
app.get('/checkout', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkout.html'));
});
app.get('/itau', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'itau.html'));
});
app.get('/loading', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'loading.html'));
});
app.get('/chatbot', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chatbot.html'));
});
app.get('/atendente.png', (_req, res) => {
  res.sendFile(path.join(__dirname, 'atendente.png'));
});
app.get('/atendente_voz.mp3', (_req, res) => {
  res.sendFile(path.join(__dirname, 'atendente_voz.mp3'));
});
app.get('/atendente_voz2.mp3', (_req, res) => {
  res.sendFile(path.join(__dirname, 'atendente_voz2.mp3'));
});
app.get('/atendente_voz3.mp3', (_req, res) => {
  res.sendFile(path.join(__dirname, 'atendente_voz3.mp3'));
});
app.get('/atendente_voz4.mp3', (_req, res) => {
  res.sendFile(path.join(__dirname, 'atendente_voz4.mp3'));
});
app.get('/atendente_voz5.mp3', (_req, res) => {
  res.sendFile(path.join(__dirname, 'atendente_voz5.mp3'));
});
app.get('/atendente_voz6.mp3', (_req, res) => {
  res.sendFile(path.join(__dirname, 'atendente_voz6.mp3'));
});
app.get('/atendente_voz7.mp3', (_req, res) => {
  res.sendFile(path.join(__dirname, 'atendente_voz7.mp3'));
});
app.get('/banner.webp', (_req, res) => {
  res.sendFile(path.join(__dirname, 'banner.webp'));
});
app.get('/itau-logo.png', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'itau-logo.png'));
});

// ---- Comprovante como PNG (puppeteer screenshot) ----
let _puppBrowser = null;
app.get('/api/comprovante-png', async (req, res) => {
  const nome = req.query.nome || 'CLIENTE';
  const cpf  = req.query.cpf  || '';
  try {
    const { default: puppeteer } = await import('puppeteer');
    if (!_puppBrowser) {
      _puppBrowser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
    }
    const page = await _puppBrowser.newPage();
    await page.setViewport({ width: 460, height: 900, deviceScaleFactor: 2 });
    const url = `http://localhost:${PORT}/itau?nome=${encodeURIComponent(nome)}&cpf=${encodeURIComponent(cpf)}`;
    await page.goto(url, { waitUntil: 'networkidle0' });
    const card = await page.$('.card');
    const box  = await card.boundingBox();
    const raw  = await page.screenshot({
      type: 'png',
      clip: { x: box.x, y: box.y, width: box.width, height: box.height }
    });
    await page.close();
    const png = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.end(png);
  } catch(e) {
    console.error('comprovante-png error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  console.log(`  Landing:  http://localhost:${PORT}/`);
  console.log(`  Checkout: http://localhost:${PORT}/checkout`);
  if (!WEBHOOK_SECRET) {
    console.log('  [aviso] SAFIPAY_WEBHOOK_SECRET vazio: webhook sem validação de assinatura (ok só em teste local).');
  }
});
