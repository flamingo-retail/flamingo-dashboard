const https = require('https');

const STORE_LF  = 'f95fc2ba-ac61-45f8-877e-255f48e5c88d';
const STORE_STM = 'e15a7958-adbe-4879-a856-3fa727475ddf';

exports.handler = async function(event) {
  const apiKey = process.env.SHOPCAISSE_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  const store    = event.queryStringParameters?.store || 'all';
  const now      = new Date();
  const dateFrom = event.queryStringParameters?.from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const dateTo   = event.queryStringParameters?.to   || now.toISOString().split('T')[0];

  async function fetchSales(storeId) {
    return new Promise((resolve) => {
      const path = `/v1/stores/${storeId}/sales?limit=500&date_from=${dateFrom}T00:00:00&date_to=${dateTo}T23:59:59`;
      const req  = https.request('https://api.shop-caisse.com' + path, {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type':  'application/json',
          'Accept':        'application/json',
        },
      }, (res) => {
        res.setEncoding('utf8');
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json.items || []);
          } catch(e) {
            resolve([]);
          }
        });
      });
      req.on('error', () => resolve([]));
      req.end();
    });
  }

  let sales = [];
  if (store === 'lf'  || store === 'all') {
    const lf  = await fetchSales(STORE_LF);
    sales = sales.concat(lf.map(s => ({ ...s, store: 'LF' })));
  }
  if (store === 'stm' || store === 'all') {
    const stm = await fetchSales(STORE_STM);
    sales = sales.concat(stm.map(s => ({ ...s, store: 'STM' })));
  }

  const byProduct = {};

  for (const sale of sales) {
    if (!sale.lines) continue;
    for (const line of sale.lines) {
      const rawName = line.item?.name || line.item?.label || line.description || line.label || 'Inconnu';

      const baseName = rawName
        .replace(/\s+\d{1,3}\s*[A-Z]{0,3}$/, '')
        .replace(/\s+(XS|S|M|L|XL|XXL|XXXL)\s*$/, '')
        .replace(/\s+TU\s*$/, '')
        .trim();

      const unitPrice = line.price?.vatExcluded
        ?? line.unitPriceExcludingTax
        ?? line.unitPrice
        ?? line.price?.vatIncluded
        ?? line.totalPrice
        ?? 0;

      const qty = line.quantity || 1;
      const ht  = unitPrice * qty;
      const ttc = (line.unitPrice ?? line.price?.vatIncluded ?? unitPrice) * qty;

      const couleur     = line.item?.color || line.color || line.variant?.color || '';
      const fournisseur = line.item?.supplier || line.supplier || '';

      if (!byProduct[baseName]) {
        byProduct[baseName] = {
          ref:         baseName,
          qty:         0,
          total_ht:    0,
          total_ttc:   0,
          fournisseur: fournisseur,
          couleurs:    {},
        };
      }

      byProduct[baseName].qty       += qty;
      byProduct[baseName].total_ht  += ht;
      byProduct[baseName].total_ttc += ttc;

      const clé = couleur || 'Sans couleur';
      if (!byProduct[baseName].couleurs[clé]) {
        byProduct[baseName].couleurs[clé] = { couleur: clé, qty: 0, total_ht: 0, tailles: [] };
      }
      byProduct[baseName].couleurs[clé].qty      += qty;
      byProduct[baseName].couleurs[clé].total_ht += ht;
    }
  }

  const result = Object.values(byProduct)
    .map(p => ({
      ...p,
      total_ht:  Math.round(p.total_ht  * 100) / 100,
      total_ttc: Math.round(p.total_ttc * 100) / 100,
      couleurs:  Object.values(p.couleurs),
    }))
    .sort((a, b) => b.qty - a.qty);

  return {
    statusCode: 200,
    headers: {
      'Content-Type':                'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({ data: result, from: dateFrom, to: dateTo }),
  };
};
