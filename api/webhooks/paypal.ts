import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

// ── Env ──────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || '';
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'live';
const CJ_API_KEY = process.env.CJ_API_KEY || '';
const CJ_PRODUCT_VID = process.env.CJ_PRODUCT_VID || '1533362500308316160';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

const PAYPAL_BASE = PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── PayPal helpers ───────────────────────────────────────────
async function getPaypalToken(): Promise<string> {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const j = await r.json() as any;
  if (!r.ok) throw new Error('PayPal auth failed');
  return j.access_token;
}

async function verifySignature(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<boolean> {
  if (!PAYPAL_WEBHOOK_ID || PAYPAL_WEBHOOK_ID === 'PAYPAL_WEBHOOK_ID_AQUI') return true;
  try {
    const token = await getPaypalToken();
    const r = await fetch(`${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_algo: headers['paypal-auth-algo'],
        cert_url: headers['paypal-cert-url'],
        transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'],
        transmission_time: headers['paypal-transmission-time'],
        webhook_id: PAYPAL_WEBHOOK_ID,
        webhook_event: JSON.parse(rawBody),
      }),
    });
    const j = await r.json() as any;
    return j.verification_status === 'SUCCESS';
  } catch {
    return false;
  }
}

// ── Email helper ─────────────────────────────────────────────
async function sendConfirmation(order: any): Promise<void> {
  if (!RESEND_API_KEY) return;
  const resend = new Resend(RESEND_API_KEY);

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#FAFAF8;font-family:Inter,Arial,sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:40px 24px;">
  <div style="text-align:center;margin-bottom:32px;">
    <h1 style="font-family:'Bebas Neue',Arial,sans-serif;font-size:32px;color:#0D0D0D;margin:0;">CHARGLY</h1>
  </div>
  <div style="background:#fff;border:1px solid #E8E4DF;border-radius:8px;padding:32px;">
    <h2 style="color:#0D0D0D;font-size:22px;margin:0 0 8px;">¡Pedido Confirmado!</h2>
    <p style="color:#888;font-size:14px;margin:0 0 24px;">
      Hola <strong style="color:#0D0D0D;">${order.customer_name}</strong>, tu pago ha sido procesado.
    </p>
    <div style="background:#F5F2EE;border-radius:6px;padding:20px;margin-bottom:24px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;padding:4px 0;">Orden</td>
            <td style="color:#0D0D0D;font-size:14px;font-weight:600;text-align:right;padding:4px 0;">#${order.paypal_order_id}</td></tr>
        <tr><td style="color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;padding:4px 0;">Total</td>
            <td style="color:#0D0D0D;font-size:14px;font-weight:600;text-align:right;padding:4px 0;">$${Number(order.amount).toFixed(2)} ${order.currency}</td></tr>
        <tr><td style="color:#888;font-size:12px;text-transform:uppercase;letter-spacing:1px;padding:4px 0;">Cantidad</td>
            <td style="color:#0D0D0D;font-size:14px;font-weight:600;text-align:right;padding:4px 0;">${order.quantity}</td></tr>
      </table>
    </div>
    <h3 style="color:#0D0D0D;font-size:16px;margin:0 0 8px;">Envío</h3>
    <p style="color:#888;font-size:14px;margin:0 0 24px;">${order.shipping_address}<br>${order.shipping_city}, ${order.shipping_country}</p>
    <h3 style="color:#0D0D0D;font-size:16px;margin:0 0 8px;">Próximos pasos</h3>
    <p style="color:#555;font-size:14px;line-height:1.8;margin:0;">
      1. Tu pedido será enviado en 1-3 días hábiles.<br>
      2. Recibirás un email con tu número de tracking.<br>
      3. Entrega estimada: <strong>15-20 días hábiles</strong>.
    </p>
  </div>
  <div style="text-align:center;margin-top:32px;">
    <p style="color:#888;font-size:12px;margin:0 0 4px;">¿Preguntas? Escríbenos a</p>
    <a href="mailto:soporte@chargly.shop" style="color:#D4825A;font-size:14px;font-weight:600;text-decoration:none;">soporte@chargly.shop</a>
    <p style="color:#ccc;font-size:11px;margin:20px 0 0;">© ${new Date().getFullYear()} Chargly</p>
  </div>
</div></body></html>`;

  await resend.emails.send({
    from: 'Chargly <soporte@chargly.shop>',
    to: order.customer_email,
    subject: `✓ Pedido confirmado — #${order.paypal_order_id}`,
    html,
  });

  await db.from('orders').update({ confirmation_sent: true }).eq('id', order.id);
}

// ── CJ helper ────────────────────────────────────────────────
async function getCjToken(): Promise<string> {
  const r = await fetch('https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: '', password: '', apiKey: CJ_API_KEY }),
  });
  const j = await r.json() as any;
  if (!j.result) throw new Error(j.message || 'CJ auth failed');
  return j.data.accessToken;
}

async function createCjOrder(order: any): Promise<void> {
  if (!CJ_API_KEY || CJ_API_KEY === 'CJ_API_KEY_AQUI') return;
  try {
    const token = await getCjToken();
    const r = await fetch('https://developers.cjdropshipping.com/api2.0/v1/shopping/order/createOrder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CJ-Access-Token': token },
      body: JSON.stringify({
        orderNumber: order.paypal_order_id,
        shippingZip: '',
        shippingCountryCode: order.shipping_country.length === 2 ? order.shipping_country : 'US',
        shippingCountry: order.shipping_country,
        shippingProvince: order.shipping_city,
        shippingCity: order.shipping_city,
        shippingAddress: order.shipping_address,
        shippingCustomerName: order.customer_name,
        shippingPhone: order.customer_phone || '',
        remark: `Chargly order — PayPal #${order.paypal_order_id}`,
        fromCountryCode: 'CN',
        logisticName: 'CJPacket Ordinary',
        houseNumber: '',
        email: order.customer_email,
        products: [{ vid: CJ_PRODUCT_VID, quantity: order.quantity }],
      }),
    });
    const j = await r.json() as any;
    console.log('CJ createOrder response:', JSON.stringify(j));
    if (j.data?.orderId) {
      await db.from('orders').update({ cj_order_id: j.data.orderId, cj_status: 'created', status: 'processing' }).eq('id', order.id);
    }
  } catch (err) {
    console.error('CJ order error:', err);
  }
}

// ── Error alert ──────────────────────────────────────────────
async function sendErrorAlert(step: string, error: string, context: Record<string, unknown>): Promise<void> {
  if (!RESEND_API_KEY) return;
  try {
    const resend = new Resend(RESEND_API_KEY);
    await resend.emails.send({
      from: 'Chargly <soporte@chargly.shop>',
      to: 'soporte@chargly.shop',
      subject: `⚠️ Error en webhook — ${step}`,
      html: `<div style="font-family:monospace;font-size:13px;padding:20px;">
        <h2 style="color:#DC2626;">Error en: ${step}</h2>
        <p><strong>Error:</strong> ${error}</p>
        <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
        <h3>Contexto:</h3>
        <pre style="background:#f5f5f5;padding:12px;border-radius:4px;overflow-x:auto;">${JSON.stringify(context, null, 2)}</pre>
      </div>`,
    });
  } catch { /* alert itself failed — nothing we can do */ }
}

// ── Main handler ─────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const event = req.body;
  const rawBody = JSON.stringify(req.body);

  console.log('[WEBHOOK] Received:', event.event_type, '| id:', event.id);

  // Verify signature
  const valid = await verifySignature(req.headers, rawBody);
  if (!valid) {
    console.log('[WEBHOOK] Signature verification failed');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  // Only process payment events
  if (event.event_type !== 'CHECKOUT.ORDER.APPROVED' && event.event_type !== 'PAYMENT.CAPTURE.COMPLETED') {
    console.log('[WEBHOOK] Ignoring event type:', event.event_type);
    res.status(200).json({ status: 'ignored' });
    return;
  }

  try {
    const resource = event.resource;
    let paypalOrderId: string;
    let amount: number;
    let currency: string;
    let customerName: string;
    let customerEmail: string;
    let customerPhone = '';
    let shippingAddress = '';
    let shippingCity = '';
    let shippingCountry = 'US';
    let items: unknown[] = [];
    let quantity = 1;

    if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      paypalOrderId = resource.supplementary_data?.related_ids?.order_id || resource.id;
      amount = parseFloat(resource.amount?.value || '0');
      currency = resource.amount?.currency_code || 'USD';
      customerName = resource.shipping?.name?.full_name || 'Cliente';
      customerEmail = resource.payer?.email_address || '';
      customerPhone = resource.payer?.phone?.phone_number?.national_number || '';
      const addr = resource.shipping?.address || {};
      shippingAddress = addr.address_line_1 || '';
      shippingCity = addr.admin_area_2 || addr.admin_area_1 || '';
      shippingCountry = addr.country_code || 'US';
    } else {
      paypalOrderId = resource.id;
      const unit = resource.purchase_units?.[0] || {};
      amount = parseFloat(unit.amount?.value || '0');
      currency = unit.amount?.currency_code || 'USD';
      customerName = unit.shipping?.name?.full_name || resource.payer?.name?.given_name || 'Cliente';
      customerEmail = resource.payer?.email_address || '';
      customerPhone = resource.payer?.phone?.phone_number?.national_number || '';
      const addr = unit.shipping?.address || {};
      shippingAddress = addr.address_line_1 || '';
      shippingCity = addr.admin_area_2 || addr.admin_area_1 || '';
      shippingCountry = addr.country_code || 'US';
      if (unit.items) {
        items = unit.items.map((i: any) => ({ name: i.name, quantity: parseInt(i.quantity || '1'), price: i.unit_amount?.value }));
        quantity = items.reduce((s: number, i: any) => s + (i.quantity || 1), 0);
      }
    }

    if (items.length === 0) {
      items = [{ name: 'Chargly Mini Magnetic Power Bank 10000mAh', quantity, price: amount }];
    }

    console.log('[WEBHOOK] Parsed order:', paypalOrderId, '|', customerName, '|', amount, currency);

    // Duplicate check
    const { data: existing } = await db.from('orders').select('id').eq('paypal_order_id', paypalOrderId).maybeSingle();
    if (existing) {
      console.log('[WEBHOOK] Duplicate order, skipping:', paypalOrderId);
      res.status(200).json({ status: 'duplicate' });
      return;
    }

    // Create order
    console.log('[SUPABASE] Creating order...');
    const { data: order, error } = await db.from('orders').insert({
      paypal_order_id: paypalOrderId,
      paypal_status: event.event_type === 'PAYMENT.CAPTURE.COMPLETED' ? 'COMPLETED' : 'APPROVED',
      customer_name: customerName,
      customer_email: customerEmail,
      customer_phone: customerPhone,
      shipping_address: shippingAddress,
      shipping_city: shippingCity,
      shipping_country: shippingCountry,
      items, quantity, amount, currency,
    }).select().single();

    if (error) {
      console.error('[SUPABASE] Insert failed:', error);
      await sendErrorAlert('Supabase insert', error.message, { paypalOrderId, customerName, customerEmail, amount });
      throw error;
    }
    console.log('[SUPABASE] Order created:', order.id);

    // Send confirmation email
    console.log('[RESEND] Sending confirmation email to:', customerEmail);
    try {
      await sendConfirmation(order);
      console.log('[RESEND] Email sent successfully');
    } catch (emailErr: any) {
      console.error('[RESEND] Email failed:', emailErr);
      await sendErrorAlert('Resend email', emailErr?.message || 'Unknown', { orderId: order.id, customerEmail });
    }

    // Create CJ order
    console.log('[CJ] Creating supplier order...');
    try {
      await createCjOrder(order);
      console.log('[CJ] Order creation attempted');
    } catch (cjErr: any) {
      console.error('[CJ] Order failed:', cjErr);
      await sendErrorAlert('CJ order', cjErr?.message || 'Unknown', { orderId: order.id, paypalOrderId });
    }

    console.log('[WEBHOOK] Complete:', order.id);
    res.status(200).json({ status: 'ok', orderId: order.id });
  } catch (err: any) {
    console.error('[WEBHOOK] Fatal error:', err);
    const context = { eventType: event.event_type, resourceId: event.resource?.id };
    await sendErrorAlert('Webhook handler', err?.message || String(err), context);
    res.status(500).json({ error: 'Internal error' });
  }
}
