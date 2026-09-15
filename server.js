const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = Number(process.env.PORT || 3000);
const BASE = (process.env.SELLERCHAMP_BASE_URL || 'https://app.sellerchamp.com').replace(/\/$/, '');
const TOKEN = process.env.SELLERCHAMP_TOKEN || '';
const ORDER_STATUS = process.env.QUALIFYING_ORDER_STATUS || 'unshipped';
const APP_PIN = process.env.APP_PIN || '';
const DELETE_BATCH_PIN = process.env.DELETE_BATCH_PIN || '8880';
const ORDER_LOOKBACK_DAYS = Math.max(1, Number(process.env.ORDER_LOOKBACK_DAYS || 30));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'pick-batches.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ batches: [] }, null, 2));

function readDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { batches: [] }; }
}
function writeDb(db) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function uid() { return crypto.randomBytes(10).toString('hex'); }
function nowIso() { return new Date().toISOString(); }
function n(v, fallback=0) { const x = Number(v); return Number.isFinite(x) ? x : fallback; }
function str(v, fallback='') { return v == null ? fallback : String(v); }
function naturalCompare(a,b) { return str(a).localeCompare(str(b), undefined, { numeric:true, sensitivity:'base' }); }

function requirePin(req, res, next) {
  if (!APP_PIN) return next();
  const pin = req.header('x-app-pin') || req.query.pin || '';
  if (pin !== APP_PIN) return res.status(401).json({ error: 'PIN required' });
  next();
}
app.use('/api', requirePin);

async function scGet(endpoint, params={}) {
  if (!TOKEN) throw new Error('SELLERCHAMP_TOKEN is not configured.');
  const url = new URL(BASE + endpoint);
  for (const [k,v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const r = await fetch(url, { headers: { Token: TOKEN, Accept: 'application/json' } });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!r.ok) throw new Error(`SellerChamp ${r.status}: ${body.error || body.errors || body.message || text || r.statusText}`);
  return body;
}

async function scWrite(method, endpoint, payload) {
  if (!TOKEN) throw new Error('SELLERCHAMP_TOKEN is not configured.');
  const url = new URL(BASE + endpoint);
  const r = await fetch(url, {
    method,
    headers: { Token: TOKEN, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!r.ok) throw new Error(`SellerChamp ${r.status}: ${body.error || body.errors || body.message || text || r.statusText}`);
  return body;
}

function orderTimestamp(order) {
  const candidates = [order?.order_date, order?.created_at, order?.ordered_at, order?.purchase_date, order?.date_created];
  for (const value of candidates) {
    if (!value) continue;
    const t = new Date(value).getTime();
    if (Number.isFinite(t)) return t;
  }
  return null;
}

async function fetchAllQualifyingOrders() {
  const all = [];
  let page = 1;
  const pageSize = 250;
  while (true) {
    const body = await scGet('/api/orders', { order_status: ORDER_STATUS, page, page_size: pageSize, sort: 'created_at', direction: 'DESC' });
    const rows = Array.isArray(body.orders) ? body.orders : [];
    all.push(...rows);
    if (rows.length < pageSize) break;
    page += 1;
    if (page > 100) throw new Error('Stopped after 100 order pages for safety.');
  }
  const cutoff = Date.now() - ORDER_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  // Only recent, paid, seller-fulfilled, non-hold orders are pickable by default.
  return all.filter(o => {
    if (!o || o.paid === false || o.on_hold || String(o.fulfilled_by || 'seller').toLowerCase() === 'marketplace') return false;
    const ts = orderTimestamp(o);
    return ts !== null && ts >= cutoff;
  });
}

const productCache = new Map();
async function lookupProduct(order, item) {
  const effectiveSku = str(item.variant_sku || item.sku).trim();
  const cacheKey = `${order.marketplace_account_id || ''}|${item.product_id || ''}|${effectiveSku}`;
  if (productCache.has(cacheKey)) return productCache.get(cacheKey);
  let product = null;
  if (item.product_id) {
    try {
      const body = await scGet(`/api/products/${encodeURIComponent(item.product_id)}`);
      product = body.product || (Array.isArray(body.products) ? body.products[0] : null);
    } catch (_) {}
  }
  if (!product && effectiveSku) {
    try {
      const body = await scGet('/api/products', { sku: effectiveSku, marketplace_account_id: order.marketplace_account_id, page:1, page_size:50 });
      const products = Array.isArray(body.products) ? body.products : [];
      product = products.find(p => p.sku === effectiveSku) || products.find(p => (p.variants || []).some(v => v.sku === effectiveSku)) || products[0] || null;
    } catch (_) {}
  }
  productCache.set(cacheKey, product);
  return product;
}

function firstImage(product, effectiveSku) {
  if (!product) return '';
  const variant = (product.variants || []).find(v => v.sku === effectiveSku);
  const vi = variant?.images?.[0]?.product_image;
  if (vi) return vi.large_image_url || vi.medium_image_url || vi.original_image_url || '';
  const pi = product.product_images?.[0];
  if (pi) return pi.large_image_url || pi.medium_image_url || pi.original_image_url || pi.small_image_url || '';
  if (Array.isArray(product.image_urls) && product.image_urls[0]) return product.image_urls[0];
  return '';
}

function productFacts(product, item) {
  const effectiveSku = str(item.variant_sku || item.sku).trim();
  const variant = product?.variants?.find(v => v.sku === effectiveSku);
  const locations = [];
  const rawLocations = variant?.inventory_locations?.length ? variant.inventory_locations : product?.inventory_locations || [];
  for (const l of rawLocations) {
    if (!l) continue;
    locations.push({ id: str(l.id), location: str(l.location || l.name || 'Unassigned').trim() || 'Unassigned', quantity_available: n(l.quantity_available), priority: n(l.priority, 999999), delete_if_empty: l.delete_if_empty !== false });
  }
  if (!locations.length) {
    const loc = str(item.warehouse_location || variant?.item_location || product?.item_location || product?.bin_location || 'Unassigned').trim() || 'Unassigned';
    locations.push({ id: '', location: loc, quantity_available: n(variant?.quantity_available ?? product?.quantity_available), priority: 1, delete_if_empty: false });
  }
  locations.sort((a,b) => (a.priority-b.priority) || naturalCompare(a.location,b.location));
  return {
    sku: effectiveSku || str(item.sku),
    title: str(item.title || variant?.title || product?.title || effectiveSku || 'Untitled item'),
    condition: (() => {
      const ebayCondition = str(
        product?.ebay_condition_name ||
        product?.ebay_condition ||
        variant?.ebay_condition_name ||
        variant?.ebay_condition ||
        item?.ebay_condition_name ||
        item?.ebay_condition ||
        product?.item_condition ||
        'Unknown'
      ).trim() || 'Unknown';
      const remarks = str(
        product?.item_remarks_description ||
        variant?.item_remarks_description ||
        item?.item_remarks_description ||
        product?.remarks_description ||
        variant?.remarks_description ||
        item?.remarks_description ||
        product?.item_remarks ||
        ''
      ).trim();
      return remarks ? `${ebayCondition} - ${remarks}` : ebayCondition;
    })(),
    qtyOnHand: n(variant?.quantity_available ?? product?.quantity_available),
    image: firstImage(product, effectiveSku),
    productId: str(product?.id),
    variantId: str(variant?.id),
    marketplaceUrl: str(product?.marketplace_url || product?.url || ''),
    marketplaceId: str(product?.marketplace_id || product?.ebay_item_id || ''),
    sellerChampUrl: sku ? `https://app2.sellerchamp.com/products?utf8=%E2%9C%93&listings_filter=all&product%5Bmarketplace_manually_removed%5D=false&product%5Bquery%5D=${encodeURIComponent(sku)}&product%5Bitem_condition%5D=all&per_page=50` : 'https://app2.sellerchamp.com/products',
    locations
  };
}

function allocateOrdersToLocations(orderBreakdown, locations) {
  const totalNeeded = orderBreakdown.reduce((s,o)=>s+n(o.quantity),0);
  const locs = locations.map(x => ({...x, remaining: Math.max(0,n(x.quantity_available))}));
  if (!locs.length) locs.push({location:'Unassigned', quantity_available:0, remaining:Infinity, priority:1});
  let locIndex = 0;
  const stops = [];
  function getStop(loc) {
    let s = stops.find(x=>x.location===loc.location);
    if (!s) { s = { location: loc.location, inventoryLocationId: str(loc.id), locationQuantityOnHand: n(loc.quantity_available), locationPriority: n(loc.priority, 999999), deleteIfEmpty: loc.delete_if_empty !== false, quantity:0, orderBreakdown:[] }; stops.push(s); }
    return s;
  }
  for (const ob of orderBreakdown) {
    let left = n(ob.quantity);
    while (left > 0) {
      while (locIndex < locs.length-1 && locs[locIndex].remaining <= 0) locIndex++;
      const loc = locs[locIndex];
      let take = loc.remaining > 0 ? Math.min(left, loc.remaining) : (locIndex === locs.length-1 ? left : 0);
      if (take <= 0) { locIndex++; continue; }
      const stop = getStop(loc);
      stop.quantity += take;
      const existing = stop.orderBreakdown.find(x=>x.orderNumber===ob.orderNumber);
      if (existing) existing.quantity += take; else stop.orderBreakdown.push({ ...ob, quantity: take });
      left -= take;
      if (Number.isFinite(loc.remaining)) loc.remaining -= take;
    }
  }
  if (!stops.length && totalNeeded) { const loc=locations[0]||{}; stops.push({location:loc.location||'Unassigned', inventoryLocationId:str(loc.id), locationQuantityOnHand:n(loc.quantity_available), locationPriority:n(loc.priority,999999), deleteIfEmpty:loc.delete_if_empty!==false, quantity:totalNeeded, orderBreakdown}); }
  return stops;
}

async function buildSnapshot(orders) {
  const groups = new Map();
  for (const order of orders) {
    for (const item of (order.items || [])) {
      const qty = n(item.quantity);
      if (qty <= 0) continue;
      const sku = str(item.variant_sku || item.sku).trim();
      if (!sku) continue;
      const key = sku;
      let g = groups.get(key);
      if (!g) { g = { sku, orders: [], sampleOrder: order, sampleItem: item }; groups.set(key,g); }
      g.orders.push({ orderId: str(order.id), orderNumber: str(order.order_number || order.purchase_number || order.id), quantity: qty });
    }
  }
  const lines = [];
  for (const g of groups.values()) {
    const product = await lookupProduct(g.sampleOrder, g.sampleItem);
    const facts = productFacts(product, g.sampleItem);
    const stops = allocateOrdersToLocations(g.orders, facts.locations);
    for (const stop of stops) {
      lines.push({
        id: uid(), sku: facts.sku, title: facts.title, condition: facts.condition,
        image: facts.image,
        quantityOnHand: stop.locationQuantityOnHand,
        productQuantityOnHand: facts.qtyOnHand,
        productId: facts.productId,
        variantId: facts.variantId,
        ebayListingUrl: facts.marketplaceUrl || (facts.marketplaceId ? `https://www.ebay.com/itm/${encodeURIComponent(facts.marketplaceId)}` : ''),
        sellerChampProductUrl: facts.sellerChampUrl,
        inventoryLocationId: stop.inventoryLocationId,
        inventoryLocationPriority: stop.locationPriority,
        inventoryLocationDeleteIfEmpty: stop.deleteIfEmpty,
        location: stop.location, quantityToPick: stop.quantity,
        orders: stop.orderBreakdown,
        picked: false, pickedAt: null, onHandVerified: false,
        inventoryCorrections: []
      });
    }
  }
  lines.sort((a,b) => naturalCompare(a.location,b.location) || naturalCompare(a.sku,b.sku));
  return lines;
}

function summarize(batch) {
  return {
    id: batch.id, name: batch.name, createdAt: batch.createdAt, status: batch.status,
    orderCount: batch.orderIds.length,
    uniqueStops: batch.lines.length,
    totalUnits: batch.lines.reduce((s,l)=>s+n(l.quantityToPick),0),
    pickedStops: batch.lines.filter(l=>l.picked).length,
    currentIndex: batch.currentIndex || 0
  };
}

app.get('/api/health', (req,res)=>res.json({ ok:true, sellerChampConfigured:!!TOKEN, storage:DB_FILE, orderStatus:ORDER_STATUS, orderLookbackDays:ORDER_LOOKBACK_DAYS }));

app.get('/api/preview', async (req,res) => {
  try {
    const db = readDb();
    const used = new Set(db.batches.flatMap(b => b.orderIds || []));
    const orders = await fetchAllQualifyingOrders();
    const fresh = orders.filter(o => !used.has(str(o.id)));
    res.json({ qualifyingOrders: orders.length, newOrders: fresh.length, excludedAlreadyBatched: orders.length-fresh.length, totalUnits: fresh.reduce((s,o)=>s+(o.items||[]).reduce((x,i)=>x+n(i.quantity),0),0) });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.post('/api/batches', async (req,res) => {
  try {
    productCache.clear();
    const db = readDb();
    const used = new Set(db.batches.flatMap(b => b.orderIds || []));
    const orders = (await fetchAllQualifyingOrders()).filter(o => !used.has(str(o.id)));
    if (!orders.length) return res.status(409).json({ error:'There are no new qualifying orders to add to a pick batch.' });
    const lines = await buildSnapshot(orders);
    const createdAt = nowIso();
    const localLabel = new Date(createdAt).toLocaleString('en-US', { timeZone:'America/Chicago', month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' });
    const batch = {
      id:uid(), name:str(req.body?.name).trim() || localLabel,
      createdAt, status:'not_started', currentIndex:0,
      orderIds: orders.map(o=>str(o.id)),
      orderNumbers: orders.map(o=>str(o.order_number || o.purchase_number || o.id)),
      lines
    };
    db.batches.unshift(batch); writeDb(db);
    res.status(201).json({ batch:summarize(batch), lines:batch.lines });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/batches', (req,res)=> {
  const db=readDb(); res.json({ batches: db.batches.map(summarize) });
});
app.get('/api/batches/:id', (req,res)=> {
  const b=readDb().batches.find(x=>x.id===req.params.id);
  if(!b) return res.status(404).json({error:'Batch not found'});
  res.json({batch:summarize(b), lines:b.lines, orderNumbers:b.orderNumbers});
});
app.patch('/api/batches/:id', (req,res)=> {
  const db=readDb(); const b=db.batches.find(x=>x.id===req.params.id);
  if(!b) return res.status(404).json({error:'Batch not found'});
  if (req.body?.name !== undefined) b.name=str(req.body.name).trim() || b.name;
  if (req.body?.status && ['not_started','in_progress','completed'].includes(req.body.status)) b.status=req.body.status;
  if (Number.isInteger(req.body?.currentIndex)) b.currentIndex=Math.max(0,Math.min(req.body.currentIndex, Math.max(0,b.lines.length-1)));
  writeDb(db); res.json({batch:summarize(b)});
});
app.patch('/api/batches/:id/lines/:lineId', (req,res)=> {
  const db=readDb(); const b=db.batches.find(x=>x.id===req.params.id);
  if(!b) return res.status(404).json({error:'Batch not found'});
  const line=b.lines.find(x=>x.id===req.params.lineId); if(!line) return res.status(404).json({error:'Line not found'});
  if (typeof req.body?.picked === 'boolean') { line.picked=req.body.picked; line.pickedAt=line.picked?nowIso():null; }
  if (typeof req.body?.onHandVerified === 'boolean') line.onHandVerified=req.body.onHandVerified;
  if (b.lines.every(x=>x.picked)) b.status='completed'; else if (b.lines.some(x=>x.picked)) b.status='in_progress';
  writeDb(db); res.json({line,batch:summarize(b)});
});
app.post('/api/batches/:id/lines/:lineId/correct-inventory', async (req,res)=> {
  try {
    const actual = Number(req.body?.quantity);
    if (!Number.isInteger(actual) || actual < 0) return res.status(400).json({ error:'Enter a whole-number quantity of 0 or greater.' });
    const db=readDb(); const b=db.batches.find(x=>x.id===req.params.id);
    if(!b) return res.status(404).json({error:'Batch not found'});
    const line=b.lines.find(x=>x.id===req.params.lineId); if(!line) return res.status(404).json({error:'Line not found'});

    let productId=str(line.productId), variantId=str(line.variantId), inventoryLocationId=str(line.inventoryLocationId);
    let locationPriority=n(line.inventoryLocationPriority, 1);
    let deleteIfEmpty=line.inventoryLocationDeleteIfEmpty !== false;

    // Backward compatibility for batches created before inventory write-back was added.
    if (!productId) {
      const body=await scGet('/api/products', { sku: line.sku, page:1, page_size:50 });
      const products=(body.products||[]).filter(p => p && (p.sku===line.sku || (p.variants||[]).some(v=>v.sku===line.sku)));
      if (products.length !== 1) throw new Error(`Could not safely identify one SellerChamp product for SKU ${line.sku}. Create a new pick batch before correcting this SKU.`);
      const product=products[0]; productId=str(product.id);
      const variant=(product.variants||[]).find(v=>v.sku===line.sku); variantId=str(variant?.id);
      const rawLocations=variant?.inventory_locations?.length ? variant.inventory_locations : product.inventory_locations || [];
      const loc=rawLocations.find(x=>str(x.location||x.name).trim()===str(line.location).trim());
      if (loc) { inventoryLocationId=str(loc.id); locationPriority=n(loc.priority,1); deleteIfEmpty=loc.delete_if_empty!==false; }
      line.productId=productId; line.variantId=variantId; line.inventoryLocationId=inventoryLocationId;
      line.inventoryLocationPriority=locationPriority; line.inventoryLocationDeleteIfEmpty=deleteIfEmpty;
    }

    const before=n(line.quantityOnHand);
    let updateMode='product';
    if (inventoryLocationId) {
      await scWrite('PUT', `/api/products/${encodeURIComponent(productId)}/inventory_locations/${encodeURIComponent(inventoryLocationId)}`, {
        inventory_location: { location: line.location, quantity_available: actual, delete_if_empty: deleteIfEmpty, priority: locationPriority }
      });
      updateMode='location';
    } else if (variantId) {
      await scWrite('PUT', `/api/variants/${encodeURIComponent(variantId)}`, { variant: { quantity_available: actual } });
      updateMode='variant';
    } else if (productId) {
      await scWrite('PUT', `/api/products/${encodeURIComponent(productId)}`, { product: { quantity_available: actual } });
      updateMode='product';
    } else {
      throw new Error('SellerChamp product information is missing for this pick stop.');
    }

    line.quantityOnHand=actual;
    line.onHandVerified=true;
    line.inventoryCorrections=Array.isArray(line.inventoryCorrections)?line.inventoryCorrections:[];
    line.inventoryCorrections.push({ from:before, to:actual, at:nowIso(), mode:updateMode });
    writeDb(db);
    res.json({ ok:true, line, updateMode, message:`SellerChamp quantity updated from ${before} to ${actual}.` });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

app.delete('/api/batches/:id', (req,res)=> {
  const deletePin = str(req.header('x-delete-pin') || req.body?.pin).trim();
  if (deletePin !== DELETE_BATCH_PIN) return res.status(403).json({ error:'Incorrect delete PIN.' });
  const db=readDb(); const idx=db.batches.findIndex(x=>x.id===req.params.id);
  if(idx<0) return res.status(404).json({error:'Batch not found'});
  db.batches.splice(idx,1); writeDb(db); res.json({ok:true});
});

app.get('*', (req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT, ()=>console.log(`SellerChamp Pick Batch listening on ${PORT}`));
