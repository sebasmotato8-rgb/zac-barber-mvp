import { env } from '../../config/env';
import { logger } from '../../config/logger';
import type { OrderRow } from './orders.repository';

const CJ_BASE = 'https://developers.cjdropshipping.com/api2.0/v1';

async function getAccessToken(): Promise<string> {
  const res = await fetch(`${CJ_BASE}/authentication/getAccessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: '', password: '', apiKey: env.CJ_API_KEY }),
  });
  const json = await res.json() as any;
  if (!json.result) throw new Error(json.message || 'CJ auth failed');
  return json.data.accessToken;
}

async function cjFetch(token: string, path: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(`${CJ_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'CJ-Access-Token': token,
      ...options.headers,
    },
  });

  const json = await res.json() as any;

  if (!res.ok || json.result === false) {
    logger.error({ status: res.status, path, body: json }, 'CJ API error');
    throw new Error(json.message || `CJ API error: ${res.status}`);
  }

  return json;
}

export async function createCjOrder(order: OrderRow): Promise<{ orderId: string } | null> {
  if (!env.CJ_API_KEY || env.CJ_API_KEY === 'CJ_API_KEY_AQUI') {
    logger.warn({ orderId: order.id }, 'CJ API key not configured — skipping CJ order');
    return null;
  }

  try {
    const token = await getAccessToken();

    const body = {
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
      products: [
        {
          vid: env.CJ_PRODUCT_VID,
          quantity: order.quantity,
        },
      ],
    };

    const result = await cjFetch(token, '/shopping/order/createOrder', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const cjOrderId = result.data?.orderId || result.data?.orderNum || String(result.data);
    logger.info({ orderId: order.id, cjOrderId }, 'CJ order created');
    return { orderId: cjOrderId };
  } catch (err) {
    logger.error({ err, orderId: order.id }, 'Failed to create CJ order');
    return null;
  }
}

export async function getCjOrderTracking(cjOrderId: string): Promise<{ trackingNumber: string; trackingUrl: string } | null> {
  if (!env.CJ_API_KEY || env.CJ_API_KEY === 'CJ_API_KEY_AQUI') {
    return null;
  }

  try {
    const token = await getAccessToken();
    const result = await cjFetch(token, `/shopping/order/getOrderDetail?orderId=${cjOrderId}`);
    const tracking = result.data?.trackNumber;
    if (!tracking) return null;

    return {
      trackingNumber: tracking,
      trackingUrl: `https://t.17track.net/en#nums=${tracking}`,
    };
  } catch {
    return null;
  }
}
