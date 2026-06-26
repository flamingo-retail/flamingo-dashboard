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

  // Récupère les ventes d'un magasin — retourne les items bruts
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
        // Forcer le décodage UTF-8
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

  // Collecte les ventes des magasins demandés
  let sales = [];
  if (store === 'lf'  || store === 'all') {
    const lf  = await fetchSales('f95fc2ba-ac61-45f8-877e-255f48e5c88d');
    sales = sales.concat(lf.map(s => ({ ...s, store: 'LF' })));
  }
  if (store === 'stm' || store === 'all') {
    const stm = await fetchSales('f95fc2ba-ac61-45f8-877e-255f48e5c88d');
    sales = sales.concat(stm.map(s => ({ ...s, store: 'STM' })));
  }

  // Agrégation par référence produit (nom de base, sans taille/couleur)
  const byProduct = {};

  for (const sale of sales) {
    if (!sale.lines) continue;
    for (const line of sale.lines) {
      // Nom brut : préférer item.name, sinon description, sinon label
      const rawName = line.item?.name || line.item?.label || line.description || line.label || 'Inconnu';

      // Extraire le nom de base : supprimer la taille finale (ex: "Noir 36", "Bleu S", "38 M …")
      // et normaliser les espaces
      const baseName = rawName
        .replace(/\s+\d{1,3}\s*[A-Z]{0,3}$/, '')   // taille numérique + lettre optionnelle en fin
        .replace(/\s+(XS|S|M|L|XL|XXL|XXXL)\s*$/, '') // taille texte seule en fin
        .replace(/\s+TU\s*$/, '')                     // TU (Taille Unique)
        .trim();

      // Prix HT : chercher dans plusieurs champs possibles de ShopCaisse
      const unitPrice = line.price?.vatExcluded
        ?? line.unitPriceExcludingTax
        ?? line.unitPrice
        ?? line.price?.vatIncluded
        ?? line.totalPrice
        ?? 0;

      const qty = line.quantity || 1;
      const ht  = unitPrice * qty;
      const ttc = (line.unitPrice ?? line.price?.vatIncluded ?? unitPrice) * qty;

      // Couleur
      const couleur = line.item?.color || line.color || line.variant?.color || '';

      // Fournisseur (souvent vide depuis l'API)
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

      // Agrégation par couleur
      const clé = couleur || 'Sans couleur';
      if (!byProduct[baseName].couleurs[clé]) {
        byProduct[baseName].couleurs[clé] = { couleur: clé, qty: 0, total_ht: 0, tailles: [] };
      }
      byProduct[baseName].couleurs[clé].qty      += qty;
      byProduct[baseName].couleurs[clé].total_ht += ht;
    }
  }

  // Formatage final
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
