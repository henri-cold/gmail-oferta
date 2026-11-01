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
} = process.env;

const SAFIPAY_BASE = 'https://www.safipaybr.com';

const PRODUCT = {
  name: 'Produto Digital',
  price: Number(PRODUCT_PRICE), // reais
};

if (!CI || !CS) {
  console.error('ERRO: defina SAFIPAY_CLIENT_ID e SAFIPAY_CLIENT_SECRET no arquivo .env');
  process.exit(1);
}

// Armazenamento simples em memória. Em produção, use um banco de dados
// e grave transactionId + status junto de cada pedido.
const orders = new Map(); // transactionId -> { status, amount, fee, netAmount, email, name, createdAt, paidAt }

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
  if (!order) return; // webhook de pedido que não é nosso

  // Idempotente por transactionId + event
  const key = `${data.transactionId}:${event}`;
  if (order._processed?.has(key)) return;
  order._processed = order._processed || new Set();
  order._processed.add(key);

  if (event === 'pix.paid') {
    order.status = 'paid';
    order.paidAt = data.paidAt || new Date().toISOString();
    console.log(`[webhook] Pedido PAGO: ${data.transactionId}`);
    // Aqui você libera o produto (envia o ebook por e-mail, etc.)
  } else if (event === 'pix.expired') {
    if (order.status !== 'paid') order.status = 'expired';
  } else if (event === 'pix.failed') {
    if (order.status !== 'paid') order.status = 'failed';
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
      if (status === 'paid') console.log(`[status] Pedido PAGO (via consulta): ${id}`);
      return res.json({ status, paidAt: status === 'paid' ? paidAt : null });
    }
    // Safipay falhou: retorna o que tiver na memória ou pending.
    return res.json({ status: order?.status || 'pending', paidAt: order?.paidAt || null });
  } catch (err) {
    console.error('[status] exceção', err);
    return res.json({ status: order?.status || 'pending', paidAt: order?.paidAt || null });
  }
});

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
app.get('/checkout', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkout.html'));
});
app.get('/itau', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'itau.html'));
});
app.get('/loading', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'loading.html'));
});
app.get('/itau-logo.png', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'itau-logo.png'));
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  console.log(`  Landing:  http://localhost:${PORT}/`);
  console.log(`  Checkout: http://localhost:${PORT}/checkout`);
  if (!WEBHOOK_SECRET) {
    console.log('  [aviso] SAFIPAY_WEBHOOK_SECRET vazio: webhook sem validação de assinatura (ok só em teste local).');
  }
});
