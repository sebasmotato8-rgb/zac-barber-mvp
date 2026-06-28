import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'chargly2026';

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── Auth ─────────────────────────────────────────────────────
function authenticate(req: VercelRequest): boolean {
  const auth = req.headers.authorization;
  const queryPass = req.query.password as string | undefined;

  if (auth?.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const [, password] = decoded.split(':');
    return password === ADMIN_PASSWORD;
  }
  if (auth?.startsWith('Bearer ')) return auth.slice(7) === ADMIN_PASSWORD;
  if (queryPass) return queryPass === ADMIN_PASSWORD;
  return false;
}

// ── Render HTML ──────────────────────────────────────────────
function renderPage(orders: any[], total: number, page: number, error?: string): string {
  const totalPages = Math.ceil(total / 50);
  const colors: Record<string, string> = {
    paid: '#D4825A', processing: '#3B82F6', shipped: '#8B5CF6',
    delivered: '#10B981', cancelled: '#EF4444', refunded: '#6B7280',
  };

  const rows = orders.map(o => `
    <tr>
      <td>${new Date(o.created_at).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
      <td><strong>${o.customer_name}</strong><br><span class="muted">${o.customer_email}</span></td>
      <td>#${o.paypal_order_id.slice(0, 12)}…</td>
      <td>$${Number(o.amount).toFixed(2)} ${o.currency}</td>
      <td>${o.quantity}</td>
      <td><span class="badge" style="background:${colors[o.status] || '#888'}">${o.status.toUpperCase()}</span></td>
      <td>${o.tracking_number || '<span class="muted">—</span>'}</td>
      <td class="muted" style="font-size:12px">${o.shipping_city}, ${o.shipping_country}</td>
      <td>${o.confirmation_sent ? '✓' : '<span class="muted">✕</span>'}</td>
      <td>${o.cj_order_id ? `<span class="badge" style="background:#3B82F6">${o.cj_status}</span>` : '<span class="muted">—</span>'}</td>
    </tr>`).join('');

  const pagination = totalPages > 1 ? `<div class="pagination">${
    Array.from({ length: totalPages }, (_, i) => i + 1)
      .map(p => `<a href="?password=${ADMIN_PASSWORD}&page=${p}" class="${p === page ? 'active' : ''}">${p}</a>`)
      .join('')
  }</div>` : '';

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Chargly Admin — Pedidos</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Inter,-apple-system,sans-serif;background:#FAFAF8;color:#1a1a1a}
.header{background:#0D0D0D;color:#fff;padding:20px 32px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px}
.header h1{font-size:28px;letter-spacing:3px;font-weight:400}
.stats{display:flex;gap:24px;font-size:13px;color:#888}
.stats strong{color:#D4825A;font-size:18px;display:block}
.container{max-width:1400px;margin:0 auto;padding:24px;overflow-x:auto}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #E8E4DF;border-radius:8px;overflow:hidden;min-width:900px}
th{background:#F5F2EE;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px;padding:12px 14px;text-align:left;font-weight:600;white-space:nowrap}
td{padding:12px 14px;border-top:1px solid #F0EDE8;font-size:13px;vertical-align:top}
tr:hover{background:#FAFAF8}
.badge{color:#fff;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:600;white-space:nowrap}
.muted{color:#ccc}
.pagination{display:flex;justify-content:center;gap:8px;margin-top:20px}
.pagination a{padding:8px 16px;border:1px solid #E8E4DF;border-radius:4px;text-decoration:none;color:#1a1a1a;font-size:13px}
.pagination a.active{background:#D4825A;color:#fff;border-color:#D4825A}
.error{background:#FEE2E2;color:#DC2626;padding:12px 20px;border-radius:6px;margin-bottom:16px;font-size:14px}
.empty{text-align:center;padding:60px;color:#888}
</style></head><body>
<div class="header">
  <h1>CHARGLY ADMIN</h1>
  <div class="stats">
    <div><strong>${total}</strong>Pedidos totales</div>
    <div><strong>$${orders.reduce((s, o) => s + Number(o.amount), 0).toFixed(2)}</strong>Ingresos (página)</div>
  </div>
</div>
<div class="container">
  ${error ? `<div class="error">${error}</div>` : ''}
  ${orders.length === 0 ? '<div class="empty"><p>No hay pedidos todavía.</p><p style="margin-top:8px;font-size:13px;">Los pedidos aparecerán aquí automáticamente.</p></div>' : `
  <table><thead><tr>
    <th>Fecha</th><th>Cliente</th><th>Orden PayPal</th><th>Monto</th><th>Cant.</th><th>Estado</th><th>Tracking</th><th>Destino</th><th>Email</th><th>CJ</th>
  </tr></thead><tbody>${rows}</tbody></table>${pagination}`}
</div></body></html>`;
}

// ── Handler ──────────────────────────────────────────────────
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Auth
  if (!authenticate(req)) {
    if (req.headers.accept?.includes('text/html')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Chargly Admin"');
      res.status(401).send('<!DOCTYPE html><html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;background:#0D0D0D;color:#fff"><div style="text-align:center"><h1 style="font-size:32px;letter-spacing:3px">CHARGLY</h1><p style="color:#888;margin-top:8px">Ingresa tus credenciales de administrador</p></div></body></html>');
      return;
    }
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const page = parseInt(req.query.page as string) || 1;
      const format = req.query.format as string;
      const from = (page - 1) * 50;

      const { data, count, error } = await db
        .from('orders')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, from + 49);

      if (error) throw error;
      const orders = data ?? [];
      const total = count ?? 0;

      if (format === 'json') {
        res.status(200).json({ success: true, data: orders, meta: { total, page, limit: 50, hasMore: page * 50 < total } });
      } else {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(renderPage(orders, total, page));
      }
      return;
    }

    if (req.method === 'PATCH') {
      const { id, action } = req.query as { id?: string; action?: string };
      if (!id) { res.status(400).json({ error: 'id query param required' }); return; }

      if (action === 'tracking') {
        const { tracking_number, tracking_url } = req.body;
        if (!tracking_number) { res.status(422).json({ error: 'tracking_number required' }); return; }
        await db.from('orders').update({
          tracking_number,
          tracking_url: tracking_url || `https://t.17track.net/en#nums=${tracking_number}`,
          status: 'shipped',
        }).eq('id', id);
        res.status(200).json({ success: true, message: 'Tracking updated' });
        return;
      }

      const { status } = req.body;
      const valid = ['paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'];
      if (!valid.includes(status)) { res.status(422).json({ error: `Invalid status. Valid: ${valid.join(', ')}` }); return; }
      const { data, error } = await db.from('orders').update({ status }).eq('id', id).select().single();
      if (error) throw error;
      res.status(200).json({ success: true, data });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err: any) {
    console.error('Admin error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
}
