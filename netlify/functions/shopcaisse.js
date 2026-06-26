const https = require('https');

const STORE_LF = 'f95fc2ba-ac61-45f8-877e-255f48e5c88d';
const STORE_STM = 'e15a7958-adbe-4879-a856-3fa727475ddf';

exports.handler = async function(event) {
  const apiKey = process.env.SHOPCAISSE_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  const store = event.queryStringParameters?.store || 'all';
  const now = new Date();
  const dateFrom = event.queryStringParameters?.from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const dateTo = event.queryStringParameters?.to || now.toISOString().split('T')[0];

  async function fetchSales(storeId) {
    return new Promise((resolve) => {
      const path = `/v1/stores/${storeId}/sales?limit=500&date_from=${dateFrom}T00:00:00&date_to=${dateTo}T23:59:59`;
      const req = https.request('https://api.shop-caisse.com' + path, {
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + apiKey,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      }, (res) => {
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
  if (store === 'lf' || store === 'all') {
    const lf = await fetchSales(STORE_LF);
    sales = sales.concat(lf.map(s => ({...s, store: 'LF'})));
  }
  if (store === 'stm' || store === 'all') {
    const stm = await fetchSales(STORE_STM);
    sales = sales.concat(stm.map(s => ({...s, store: 'STM'})));
  }

  const byProduct = {};
  for (const sale of sales) {
    if (!sale.lines) continue;
    for (const line of sale.lines) {
      const name = line.item?.name || line.description || 'Inconnu';
      const qty = line.quantity || 1;
      const ht = (line.price?.vatExcluded || 0) * qty;
      const ttc = (line.unitPrice || 0) * qty;
      if (!byProduct[name]) byProduct[name] = { ref: name, qty: 0, total_ht: 0, total_ttc: 0, fournisseur: '', couleurs: [] };
      byProduct[name].qty += qty;
      byProduct[name].total_ht += ht;
      byProduct[name].total_ttc += ttc;
    }
  }

  const result = Object.values(byProduct)
    .map(p => ({ ...p, total_ht: Math.round(p.total_ht * 100) / 100, total_ttc: Math.round(p.total_ttc * 100) / 100, couleurs: [{ couleur: 'Sans couleur', qty: p.qty, total_ht: p.total_ht, tailles: [] }] }))
    .sort((a, b) => b.qty - a.qty);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ data: result, from: dateFrom, to: dateTo })
  };
};
