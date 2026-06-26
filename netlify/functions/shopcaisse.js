const https = require('https');

const STORE_LF  = 'f95fc2ba-ac61-45f8-877e-255f48e5c88d';
const STORE_STM = 'e15a7958-adbe-4879-a856-3fa727475ddf';
const COMPANY   = '44a373b0-4cee-481b-82c8-1992b2c3882c';

// Generic GET helper
function apiGet(path, apiKey) {
  return new Promise((resolve) => {
    const req = https.request('https://api.shop-caisse.com' + path, {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

exports.handler = async function(event) {
  const apiKey = process.env.SHOPCAISSE_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  const store    = event.queryStringParameters?.store || 'all';
  const now      = new Date();
  const dateFrom = event.queryStringParameters?.from || new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const dateTo   = event.queryStringParameters?.to   || now.toISOString().split('T')[0];

  // 1) Build item -> family map (paginated)
  const itemFamily = {};
  let skipItems = 0;
  let itemsPage = 0;
  while (true) {
    const resp = await apiGet(`/v1/companies/${COMPANY}/items?limit=500&skip=${skipItems}`, apiKey);
    const items = (resp && resp.items) || [];
    for (const it of items) {
      if (it.id && it.family && it.family.name) {
        itemFamily[it.id] = it.family.name;
      }
    }
    if (!resp || !resp.hasNextPage || items.length === 0) break;
    skipItems += items.length;
    if (++itemsPage > 40) break; // safety cap (20000 items)
  }

  // 2) Fetch all sales for a store (paginated)
  async function fetchSales(storeId) {
    let all = [];
    let skip = 0;
    let page = 0;
    while (true) {
      const path = `/v1/stores/${storeId}/sales?limit=500&skip=${skip}&date_from=${dateFrom}T00:00:00&date_to=${dateTo}T23:59:59`;
      const resp = await apiGet(path, apiKey);
      const items = (resp && resp.items) || [];
      all = all.concat(items);
      if (!resp || !resp.hasNextPage || items.length === 0) break;
      skip += items.length;
      if (++page > 100) break; // safety cap (50000 sales)
    }
    return all;
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

  // 3) Aggregate by product, attaching family as fournisseur
  const byProduct = {};
  for (const sale of sales) {
    if (!sale.lines) continue;
    for (const line of sale.lines) {
      const itemId = line.item?.id;
      const name = line.item?.name || line.description || 'Inconnu';
      const qty = line.quantity || 0;
      const ht  = (line.price?.vatExcluded || 0);   // already total for the line (qty included in price)
      const ttc = (line.price?.vatIncluded || 0);

      // family (fournisseur) — skip the "Pas de famille" default
      let famName = itemFamily[itemId] || '';
      if (famName === 'Pas de famille') famName = '';

      if (!byProduct[name]) {
        byProduct[name] = { ref: name, qty: 0, total_ht: 0, total_ttc: 0, fournisseur: famName, couleurs: {} };
      }
      if (!byProduct[name].fournisseur && famName) byProduct[name].fournisseur = famName;
      byProduct[name].qty       += qty;
      byProduct[name].total_ht  += ht;
      byProduct[name].total_ttc += ttc;

      const clé = 'Sans couleur';
      if (!byProduct[name].couleurs[clé]) {
        byProduct[name].couleurs[clé] = { couleur: clé, qty: 0, total_ht: 0, tailles: [] };
      }
      byProduct[name].couleurs[clé].qty      += qty;
      byProduct[name].couleurs[clé].total_ht += ht;
    }
  }

  const result = Object.values(byProduct)
    .map(p => ({
      ...p,
      total_ht:  Math.round(p.total_ht  * 100) / 100,
      total_ttc: Math.round(p.total_ttc * 100) / 100,
      couleurs:  Object.values(p.couleurs),
    }))
    .filter(p => p.qty !== 0)
    .sort((a, b) => b.qty - a.qty);

  return {
    statusCode: 200,
    headers: {
      'Content-Type':                'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({ data: result, from: dateFrom, to: dateTo, salesCount: sales.length, itemsIndexed: Object.keys(itemFamily).length }),
  };
};
