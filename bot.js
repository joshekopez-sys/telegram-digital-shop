require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Markup, Telegraf } = require('telegraf');

const required = ['TOKEN', 'OWNER_ID', 'ENCRYPTION_KEY'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  throw new Error(`Faltan variables obligatorias en .env: ${missing.join(', ')}`);
}

if (!/^\d+$/.test(process.env.OWNER_ID)) {
  throw new Error('OWNER_ID debe ser el ID numérico de Telegram del propietario.');
}
if (!Number.isSafeInteger(Number(process.env.OWNER_ID))) {
  throw new Error('OWNER_ID está fuera del rango numérico admitido.');
}
if (!/^[a-fA-F0-9]{64}$/.test(process.env.ENCRYPTION_KEY)) {
  throw new Error('ENCRYPTION_KEY debe contener exactamente 64 caracteres hexadecimales.');
}

const OWNER_ID = Number(process.env.OWNER_ID);
const CURRENCY = process.env.CURRENCY || 'USDT';
const STORE_NAME = process.env.STORE_NAME || 'Volcano Shop';
const WELCOME_GIF = process.env.WELCOME_GIF || '';
const SUPPORT_URL = validWebUrl(process.env.SUPPORT_URL);
const CHANNEL_URL = validWebUrl(process.env.CHANNEL_URL);
const PREMIUM_EMOJI_IDS = {
  fire: process.env.PREMIUM_EMOJI_FIRE || '',
  gem: process.env.PREMIUM_EMOJI_GEM || '',
  star: process.env.PREMIUM_EMOJI_STAR || '',
};
const PRODUCTS_PER_PAGE = 24;
const encryptionKey = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
const dbPath = path.resolve(process.env.DB_PATH || './data/shop.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL CHECK (price_cents > 0),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    encrypted_item TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS topups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(telegram_id),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    status TEXT NOT NULL DEFAULT 'awaiting_proof',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(telegram_id),
    amount_cents INTEGER NOT NULL,
    reason TEXT NOT NULL,
    reference_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(telegram_id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    stock_id INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL,
    encrypted_item TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS inventory_fingerprints (
    fingerprint TEXT PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(telegram_id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    stock_id INTEGER NOT NULL,
    encrypted_item TEXT NOT NULL,
    batch_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
  );
  CREATE TABLE IF NOT EXISTS inventory_migrations (
    name TEXT PRIMARY KEY,
    completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const reservationColumns = db.prepare('PRAGMA table_info(reservations)').all();
if (!reservationColumns.some((column) => column.name === 'batch_id')) {
  db.exec('ALTER TABLE reservations ADD COLUMN batch_id TEXT');
}

const bot = new Telegraf(process.env.TOKEN);
const userFlows = new Map();
const adminFlows = new Map();
const emojiIdChecks = new Set();
const MAX_ORDER_QUANTITY = 50;
setInterval(expirePendingReservations, 30000);

bot.use((ctx, next) => {
  if (ctx.chat && ctx.chat.type !== 'private') {
    return ctx.reply('Por seguridad, usa este bot en un chat privado.');
  }
  return next();
});

function money(cents) {
  return `${(cents / 100).toFixed(2)} ${CURRENCY}`;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function notifyUsersOfNewStock(productId, quantity) {
  const product = db.prepare('SELECT name FROM products WHERE id = ?').get(productId);
  if (!product || quantity < 1) return { sent: 0, failed: 0 };

  const users = db.prepare('SELECT telegram_id FROM users ORDER BY telegram_id').all();
  let sent = 0;
  let failed = 0;
  const message = [
    '✨ <b>¡VOLVIÓ EL STOCK!</b>',
    '━━━━━━━━━━━━━━━━━━',
    `🛍️ ${escapeHtml(product.name)}`,
    `📦 Unidades nuevas: <b>${quantity}</b>`,
    '',
    'Entra a la tienda para ver el producto.',
  ].join('\n');

  for (let index = 0; index < users.length; index++) {
    const userId = users[index].telegram_id;
    let delivered = false;
    for (let attempt = 0; attempt < 3 && !delivered; attempt++) {
      try {
        await bot.telegram.sendMessage(userId, message, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.callback('🛍️ IR A LA TIENDA', 'menu:store')]]),
        });
        sent++;
        delivered = true;
      } catch (error) {
        const retryAfter = error.response?.parameters?.retry_after;
        if (Number.isInteger(retryAfter) && attempt < 2) {
          await wait((retryAfter + 1) * 1000);
          continue;
        }
        failed++;
        console.error('No se pudo enviar el aviso de nuevo stock a un usuario:', error.description || error.message);
      }
    }
    if (index + 1 < users.length) await wait(50);
  }
  return { sent, failed };
}

function shortLabel(value, limit = 48) {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function premiumEmoji(name, fallback) {
  const emojiId = PREMIUM_EMOJI_IDS[name];
  return /^\d+$/.test(emojiId)
    ? `<tg-emoji emoji-id="${emojiId}">${fallback}</tg-emoji>`
    : fallback;
}

function validWebUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function homeMessage(ctx) {
  const username = ctx.from.username ? `@${ctx.from.username}` : 'Sin username';
  const accountType = isOwner(ctx) ? 'Propietario' : 'Cliente';
  const greeting = escapeHtml(ctx.from.first_name || 'amigo');
  return [
    `╭━━━ ${premiumEmoji('fire', '🔥')} <b>${escapeHtml(STORE_NAME)}</b>`,
    `┃ Hola, <b>${greeting}</b>`,
    '┃ Tu próxima compra empieza aquí.',
    '╰━━━━━━━━━━━━━━━━━━',
    '',
    `${premiumEmoji('gem', '💎')} <b>MI CUENTA</b>`,
    `├ Tipo: <b>${accountType}</b>`,
    `├ Usuario: ${escapeHtml(username)}`,
    `├ ID: <code>${ctx.from.id}</code>`,
    `╰ Saldo: <b>${money(getBalance(ctx.from.id))}</b>`,
    '',
    `${premiumEmoji('star', '✨')} <b>¿Qué hacemos hoy?</b>`,
    'Elige una opción del menú y disfruta.',
  ].join('\n');
}

function parseAmount(value) {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function encryptItem(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('hex')).join(':');
}

function decryptItem(value) {
  const [ivHex, tagHex, ciphertextHex] = value.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

function fingerprintItem(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function restoreReservationToStock(reservation) {
  const batchId = reservation.batch_id;
  const reservations = batchId
    ? db.prepare("SELECT * FROM reservations WHERE batch_id = ? AND status = 'pending'").all(batchId)
    : [reservation];
  const restored = runTransaction(() => {
    for (const item of reservations) {
      db.prepare('INSERT INTO stock (product_id, encrypted_item) VALUES (?, ?)')
        .run(item.product_id, item.encrypted_item);
      db.prepare('DELETE FROM reservations WHERE id = ? AND status = ?').run(item.id, 'pending');
    }
    return reservations.length;
  });
  return restored;
}

function expirePendingReservations() {
  const expired = db.prepare(`
    SELECT * FROM reservations
    WHERE status = 'pending' AND expires_at <= datetime('now')
    ORDER BY id ASC
  `).all();
  if (!expired.length) return;
  const notified = new Set();
  for (const reservation of expired) {
    try {
      const restored = restoreReservationToStock(reservation);
      const notificationKey = reservation.batch_id || String(reservation.id);
      if (!restored || notified.has(notificationKey)) continue;
      notified.add(notificationKey);
      bot.telegram.sendMessage(
        reservation.user_id,
        `⏰ <b>Reserva vencida</b>\n━━━━━━━━━━━━━━━━━━\nLas ${restored === 1 ? 'cuenta reservada volvió' : `${restored} cuentas reservadas volvieron`} al stock porque no se confirmó dentro de 5 minutos.`,
        { parse_mode: 'HTML' },
      ).catch((error) => console.error('No se pudo notificar la expiración de una reserva:', error));
    } catch (error) {
      console.error(`No se pudo restaurar la reserva #${reservation.id}:`, error);
    }
  }
}

if (!db.prepare("SELECT name FROM inventory_migrations WHERE name = 'fingerprints_v1'").get()) {
  runTransaction(() => {
    const registerFingerprint = db.prepare(
      'INSERT OR IGNORE INTO inventory_fingerprints (fingerprint, product_id) VALUES (?, ?)',
    );
    for (const item of db.prepare('SELECT product_id, encrypted_item FROM stock').all()) {
      registerFingerprint.run(fingerprintItem(decryptItem(item.encrypted_item)), item.product_id);
    }
    for (const item of db.prepare('SELECT product_id, encrypted_item FROM orders').all()) {
      registerFingerprint.run(fingerprintItem(decryptItem(item.encrypted_item)), item.product_id);
    }
    db.prepare('INSERT INTO inventory_migrations (name) VALUES (?)').run('fingerprints_v1');
  });
}

function ensureUser(from) {
  db.prepare(`
    INSERT INTO users (telegram_id, username, first_name)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name
  `).run(from.id, from.username || null, from.first_name || 'Cliente');
}

function getBalance(userId) {
  const row = db.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS balance FROM ledger WHERE user_id = ?').get(userId);
  return row.balance;
}

function isOwner(ctx) {
  return ctx.from && ctx.from.id === OWNER_ID;
}

function homeKeyboard() {
  const rows = [
    [Markup.button.callback('🔒 TIENDA', 'menu:store')],
    [
      Markup.button.callback('💸 RECARGAR', 'menu:deposit'),
      Markup.button.callback('🛒 HISTORIAL', 'menu:history'),
    ],
    [
      Markup.button.callback('💰 MI SALDO', 'menu:balance'),
    ],
  ];
  rows[2].push(
    SUPPORT_URL
      ? Markup.button.url('📢 SOPORTE', SUPPORT_URL)
      : Markup.button.callback('📢 SOPORTE', 'menu:support'),
  );
  if (CHANNEL_URL) {
    rows.push([Markup.button.url('🔎 ÚNETE A MI CANAL', CHANNEL_URL)]);
  }
  return Markup.inlineKeyboard(rows);
}

function menuButton() {
  return Markup.inlineKeyboard([[Markup.button.callback('☰ MENÚ PRINCIPAL', 'menu:home')]]);
}

function catalogPage(page) {
  const list = products();
  const pageCount = Math.max(1, Math.ceil(list.length / PRODUCTS_PER_PAGE));
  const currentPage = Math.min(Math.max(page, 0), pageCount - 1);
  const visible = list.slice(currentPage * PRODUCTS_PER_PAGE, (currentPage + 1) * PRODUCTS_PER_PAGE);
  const rows = [];
  for (let index = 0; index < visible.length; index += 3) {
    rows.push(visible.slice(index, index + 3).map((product) =>
      Markup.button.callback(shortLabel(product.name, 28), `product:${product.id}`),
    ));
  }
  rows.push([
    ...(currentPage > 0 ? [Markup.button.callback('‹', `catalog:${currentPage - 1}`)] : []),
    Markup.button.callback(`${currentPage + 1}/${pageCount}`, 'noop'),
    ...(currentPage + 1 < pageCount ? [Markup.button.callback('›', `catalog:${currentPage + 1}`)] : []),
  ]);
  rows.push([
    Markup.button.callback('🔄 ACTUALIZAR', `catalog:${currentPage}`),
    Markup.button.callback('☰ MENÚ', 'menu:home'),
  ]);
  return { keyboard: Markup.inlineKeyboard(rows), page: currentPage, pageCount };
}

async function showHome(ctx, { edit = false, animation = false } = {}) {
  const message = homeMessage(ctx);
  const options = { parse_mode: 'HTML', ...homeKeyboard() };
  if (animation && WELCOME_GIF) {
    return ctx.replyWithAnimation(WELCOME_GIF, { caption: message, ...options });
  }
  if (edit && ctx.callbackQuery?.message?.text) return ctx.editMessageText(message, options);
  if (edit && ctx.callbackQuery?.message?.caption) {
    return ctx.editMessageCaption(message, options);
  }
  return ctx.reply(message, options);
}

async function showCatalog(ctx, page = 0, { edit = false } = {}) {
  const catalog = catalogPage(page);
  if (!products().length) {
    const options = { parse_mode: 'HTML', ...menuButton() };
    if (edit && ctx.callbackQuery?.message?.text) return ctx.editMessageText('🛍️ <b>La tienda aún no tiene productos.</b>\nVuelve pronto.', options);
    return ctx.reply('🛍️ <b>La tienda aún no tiene productos.</b>\nVuelve pronto.', options);
  }
  const title = `🛍️ <b>ELIGE TU PRODUCTO</b>\n━━━━━━━━━━━━━━━━━━\n📄 Página ${catalog.page + 1} de ${catalog.pageCount}`;
  const options = { parse_mode: 'HTML', ...catalog.keyboard };
  if (edit && ctx.callbackQuery?.message?.text) return ctx.editMessageText(title, options);
  if (edit && ctx.callbackQuery?.message?.caption) return ctx.editMessageCaption(title, options);
  return ctx.reply(title, options);
}

function adminKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('➕ Crear producto', 'admin:add_product'),
      Markup.button.callback('💲 Cambiar precio', 'admin:price'),
    ],
    [
      Markup.button.callback('📥 Agregar stock', 'admin:add_stock'),
      Markup.button.callback('📊 Inventario', 'admin:inventory'),
    ],
    [
      Markup.button.callback('🗑️ Quitar stock', 'admin:remove_stock'),
      Markup.button.callback('📦 Activar / pausar', 'admin:toggle_product'),
    ],
    [
      Markup.button.callback('❌ Eliminar producto', 'admin:delete_product'),
    ],
  ]);
}

function products(activeOnly = true) {
  const query = activeOnly
    ? 'SELECT p.*, (SELECT COUNT(*) FROM stock s WHERE s.product_id = p.id) AS stock_count FROM products p WHERE p.active = 1 ORDER BY p.id'
    : 'SELECT p.*, (SELECT COUNT(*) FROM stock s WHERE s.product_id = p.id) AS stock_count FROM products p ORDER BY p.id';
  return db.prepare(query).all();
}

function productButtons(list, action) {
  const buttons = list.map((product) =>
    Markup.button.callback(
      shortLabel(`${product.active ? '✅' : '⏸️'} ${product.name} · ${money(product.price_cents)} · stock ${product.stock_count}`),
      `${action}:${product.id}`,
    ),
  );
  const rows = [];
  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(buttons.slice(index, index + 2));
  }
  return Markup.inlineKeyboard(rows);
}

function runTransaction(callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function parseInventory(text) {
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function inventoryPreview(productId, items) {
  const existing = db.prepare('SELECT fingerprint FROM inventory_fingerprints WHERE fingerprint = ?');
  const seen = new Set();
  const uniqueItems = [];
  let duplicateCount = 0;
  for (const item of items) {
    const fingerprint = fingerprintItem(item);
    if (seen.has(fingerprint) || existing.get(fingerprint)) {
      duplicateCount++;
      continue;
    }
    seen.add(fingerprint);
    uniqueItems.push(item);
  }
  return {
    productId,
    items: uniqueItems,
    receivedCount: items.length,
    duplicateCount,
  };
}

async function showInventoryPreview(ctx, productId, rawText) {
  const product = db.prepare('SELECT name FROM products WHERE id = ?').get(productId);
  if (!product) {
    adminFlows.delete(ctx.from.id);
    return ctx.reply('No se encontró el producto. Inicia la carga nuevamente desde /admin.');
  }
  const items = parseInventory(rawText);
  if (!items.length) return ctx.reply('No encontré unidades en el contenido. Envía un TXT con una unidad por línea o pega las unidades en el chat.');
  if (items.length > 5000) return ctx.reply('El archivo supera el límite de 5,000 líneas con contenido. Divídelo en varios archivos TXT.');
  const preview = inventoryPreview(productId, items);
  adminFlows.set(ctx.from.id, { step: 'stock_preview', preview });
  const keyboard = preview.items.length
    ? Markup.inlineKeyboard([[
      Markup.button.callback(`✅ Confirmar (${preview.items.length})`, 'stockimport:confirm'),
      Markup.button.callback('❌ Cancelar', 'stockimport:cancel'),
    ]])
    : Markup.inlineKeyboard([[Markup.button.callback('❌ Cancelar', 'stockimport:cancel')]]);
  await ctx.reply(
    `Vista previa para “${product.name}”\nLíneas recibidas: ${preview.receivedCount}\nUnidades nuevas: ${preview.items.length}\nDuplicados omitidos: ${preview.duplicateCount}\n\nNo se ha guardado nada todavía.`,
    keyboard,
  );
}

function stockInventoryReport() {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.active,
      (SELECT COUNT(*) FROM stock s WHERE s.product_id = p.id) AS available,
      (SELECT COUNT(*) FROM orders o WHERE o.product_id = p.id) AS sold,
      (SELECT COUNT(*) FROM inventory_fingerprints f WHERE f.product_id = p.id) AS registered
    FROM products p
    ORDER BY p.id
  `).all();
  if (!rows.length) return 'Todavía no hay productos.';
  return rows.map((row) =>
    `#${row.id} ${row.name} ${row.active ? '✅' : '⏸️'}\nDisponibles: ${row.available} · Vendidas: ${row.sold} · Registradas: ${row.registered}`,
  ).join('\n\n');
}

bot.start(async (ctx) => {
  ensureUser(ctx.from);
  const pendingTopup = db.prepare(`
    SELECT id, amount_cents FROM topups
    WHERE user_id = ? AND status = 'awaiting_proof'
    ORDER BY id DESC LIMIT 1
  `).get(ctx.from.id);
  if (pendingTopup) userFlows.set(ctx.from.id, { step: 'topup_proof', topupId: pendingTopup.id });
  const welcome = homeMessage(ctx);
  const pending = pendingTopup
    ? `\n\n⏳ Tienes una recarga pendiente <b>#${pendingTopup.id}</b> por <b>${money(pendingTopup.amount_cents)}</b>. Envía el comprobante aquí.`
    : '';
  const message = `${welcome}${pending}`;
  const options = { parse_mode: 'HTML', ...homeKeyboard() };
  if (WELCOME_GIF) {
    await ctx.replyWithAnimation(WELCOME_GIF, { caption: message, ...options });
  } else {
    await ctx.reply(message, options);
  }
});

bot.command('menu', async (ctx) => {
  ensureUser(ctx.from);
  await showHome(ctx, { animation: true });
});

bot.command('admin', async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply('No tienes permiso para usar el panel.');
  await ctx.reply('🛠️ <b>PANEL DE ADMINISTRACIÓN</b>\n━━━━━━━━━━━━━━━━━━\nElige una acción:', {
    parse_mode: 'HTML',
    ...adminKeyboard(),
  });
});

bot.command('emojiid', async (ctx) => {
  if (!isOwner(ctx)) return ctx.reply('Este comando es solo para el propietario.');
  emojiIdChecks.add(ctx.from.id);
  await ctx.reply('Envíame ahora un solo emoji personalizado de Telegram Premium. Te devolveré su ID para configurarlo en el archivo .env.');
});

bot.command('cancel', async (ctx) => {
  if (userFlows.has(ctx.from.id)) {
    userFlows.delete(ctx.from.id);
    await ctx.reply('Proceso cancelado.');
  }
  if (!isOwner(ctx)) return;
  const flow = adminFlows.get(ctx.from.id);
  if (flow?.step === 'stock_add' || flow?.step === 'stock_preview' || flow?.step === 'stock_remove_quantity' || flow?.step === 'stock_remove_confirm') {
    adminFlows.delete(ctx.from.id);
    return ctx.reply('Operación cancelada.');
  }
});

bot.action('menu:home', async (ctx) => {
  await ctx.answerCbQuery();
  await showHome(ctx, { edit: true });
});

bot.action('menu:store', async (ctx) => {
  await ctx.answerCbQuery();
  await showCatalog(ctx);
});

bot.action(/^catalog:(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await showCatalog(ctx, Number(ctx.match[1]), { edit: true });
});

bot.action('menu:balance', async (ctx) => {
  ensureUser(ctx.from);
  await ctx.answerCbQuery();
  await ctx.reply(
    `💰 <b>MI SALDO</b>\n━━━━━━━━━━━━━━━━━━\nDisponible: <b>${money(getBalance(ctx.from.id))}</b>`,
    { parse_mode: 'HTML', ...menuButton() },
  );
});

bot.action('menu:deposit', async (ctx) => {
  await ctx.answerCbQuery();
  return beginTopup(ctx);
});

async function beginTopup(ctx) {
  ensureUser(ctx.from);
  const binanceId = process.env.BINANCE_PAY_ID || process.env.BINANCE_ID;
  if (!binanceId) {
    return ctx.reply('⚠️ <b>Recargas no disponibles</b>\nEl dueño aún no configuró su Binance Pay ID.', {
      parse_mode: 'HTML',
      ...menuButton(),
    });
  }
  const pendingTopup = db.prepare(`
    SELECT id, amount_cents FROM topups
    WHERE user_id = ? AND status = 'awaiting_proof'
    ORDER BY id DESC LIMIT 1
  `).get(ctx.from.id);
  if (pendingTopup) {
    userFlows.set(ctx.from.id, { step: 'topup_proof', topupId: pendingTopup.id });
    return ctx.reply(
      `⏳ Ya tienes una recarga pendiente <b>#${pendingTopup.id}</b> por <b>${money(pendingTopup.amount_cents)}</b>.\nEnvía aquí el comprobante o espera a que se revise.`,
      { parse_mode: 'HTML', ...menuButton() },
    );
  }
  userFlows.set(ctx.from.id, { step: 'topup_amount' });
  await ctx.reply(
    `💸 <b>RECARGAR SALDO</b>\n━━━━━━━━━━━━━━━━━━\nEscribe el monto que deseas agregar en ${CURRENCY}.\n<i>Ejemplo: 10 o 10.50</i>`,
    { parse_mode: 'HTML', ...menuButton() },
  );
}

bot.action('menu:history', async (ctx) => {
  const orders = db.prepare(`
    SELECT o.id, o.amount_cents, o.created_at, p.name
    FROM orders o JOIN products p ON p.id = o.product_id
    WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 10
  `).all(ctx.from.id);
  await ctx.answerCbQuery();
  if (!orders.length) {
    return ctx.reply('🛒 <b>HISTORIAL DE COMPRAS</b>\n━━━━━━━━━━━━━━━━━━\nAún no tienes compras.', {
      parse_mode: 'HTML',
      ...menuButton(),
    });
  }
  const buttons = orders.map((order) => [
    Markup.button.callback(`📩 #${order.id} · ${shortLabel(order.name, 28)}`, `redeliver:${order.id}`),
  ]);
  const history = orders.map((order) =>
    `• <b>#${order.id}</b> ${escapeHtml(order.name)} — ${money(order.amount_cents)}`,
  ).join('\n');
  buttons.push([Markup.button.callback('☰ MENÚ PRINCIPAL', 'menu:home')]);
  await ctx.reply(`🛒 <b>HISTORIAL DE COMPRAS</b>\n━━━━━━━━━━━━━━━━━━\n${history}\n\n<i>Toca un pedido para reenviar su entrega.</i>`, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  });
});

bot.action(/^redeliver:(\d+)$/, async (ctx) => {
  const order = db.prepare(`
    SELECT o.id, o.encrypted_item, p.name
    FROM orders o JOIN products p ON p.id = o.product_id
    WHERE o.id = ? AND o.user_id = ?
  `).get(Number(ctx.match[1]), ctx.from.id);
  await ctx.answerCbQuery();
  if (!order) return ctx.reply('No se encontró esa compra en tu historial.');
  await ctx.reply(
    `📩 <b>ENTREGA · PEDIDO #${order.id}</b>\n━━━━━━━━━━━━━━━━━━\n${escapeHtml(order.name)}\n\n<code>${escapeHtml(decryptItem(order.encrypted_item))}</code>`,
    { parse_mode: 'HTML', ...menuButton() },
  );
});

bot.action('menu:help', async (ctx) => {
  await ctx.answerCbQuery();
  if (SUPPORT_URL) {
    return ctx.reply('📢 <b>SOPORTE</b>\n━━━━━━━━━━━━━━━━━━\nUsa el botón del menú para abrir el canal de soporte.', {
      parse_mode: 'HTML',
      ...menuButton(),
    });
  }
  await ctx.reply(
    '✨ <b>¿CÓMO COMPRAR?</b>\n━━━━━━━━━━━━━━━━━━\n1. Explora la tienda y elige un producto.\n2. Confirma la compra con tu saldo.\n3. Recibe tu pedido aquí mismo.\n\n💸 Para agregar saldo, toca <b>RECARGAR</b> y sigue las instrucciones.',
    { parse_mode: 'HTML', ...menuButton() },
  );
});

bot.action('menu:support', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `📢 <b>SOPORTE</b>\n━━━━━━━━━━━━━━━━━━\nPara recibir ayuda, contacta al administrador del bot: <code>${OWNER_ID}</code>`,
    { parse_mode: 'HTML', ...menuButton() },
  );
});

bot.action('noop', async (ctx) => {
  await ctx.answerCbQuery();
});

bot.action(/^product:(\d+)$/, async (ctx) => {
  const product = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM stock s WHERE s.product_id = p.id) AS stock_count
    FROM products p WHERE p.id = ? AND p.active = 1
  `).get(Number(ctx.match[1]));
  await ctx.answerCbQuery();
  if (!product) return ctx.reply('Este producto ya no está disponible.');
  const description = product.description ? `\n\n${escapeHtml(product.description)}` : '';
  const stockLabel = product.stock_count ? `✅ ${product.stock_count} disponibles` : '⏳ Agotado';
  const message = [
    `✨ <b>${escapeHtml(product.name)}</b>`,
    '━━━━━━━━━━━━━━━━━━',
    `💵 <b>Precio:</b> ${money(product.price_cents)}`,
    `📦 <b>Disponibilidad:</b> ${stockLabel}`,
    description,
  ].join('\n');
  const keyboard = product.stock_count
    ? Markup.inlineKeyboard([
      [Markup.button.callback('🛒 COMPRAR CON SALDO', `buy:${product.id}`)],
      [Markup.button.callback('⬅️ VOLVER A LA TIENDA', 'menu:store')],
      [Markup.button.callback('☰ MENÚ PRINCIPAL', 'menu:home')],
    ])
    : Markup.inlineKeyboard([
      [Markup.button.callback('⬅️ VOLVER A LA TIENDA', 'menu:store')],
      [Markup.button.callback('☰ MENÚ PRINCIPAL', 'menu:home')],
    ]);
  await ctx.reply(message, { parse_mode: 'HTML', ...keyboard });
});

bot.action(/^buy:(\d+)$/, async (ctx) => {
  const productId = Number(ctx.match[1]);
  await ctx.answerCbQuery();
  const product = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM stock s WHERE s.product_id = p.id) AS stock_count
    FROM products p WHERE p.id = ? AND p.active = 1
  `).get(productId);
  if (!product || !product.stock_count) return ctx.reply('Este producto ya no está disponible.');
  userFlows.set(ctx.from.id, { step: 'purchase_quantity', productId });
  await ctx.reply(
    `🛍️ <b>¿CUÁNTAS CUENTAS QUIERES?</b>\n━━━━━━━━━━━━━━━━━━\n✨ ${escapeHtml(product.name)}\n💵 Precio por cuenta: <b>${money(product.price_cents)}</b>\n📦 Disponibles: <b>${product.stock_count}</b>\n\nEscribe la cantidad como un número (máximo ${Math.min(product.stock_count, MAX_ORDER_QUANTITY)}).`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('✖️ CANCELAR', 'cancel')]]),
    },
  );
});

bot.action('cancel', async (ctx) => {
  userFlows.delete(ctx.from.id);
  await ctx.answerCbQuery('Compra cancelada.');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
});

bot.action(/^confirmbuy:(\d+)(?::(\d+))?$/, async (ctx) => {
  const productId = Number(ctx.match[1]);
  const quantity = Number(ctx.match[2] || 1);
  const userId = ctx.from.id;
  ensureUser(ctx.from);
  expirePendingReservations();

  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_ORDER_QUANTITY) {
    await ctx.answerCbQuery('Cantidad inválida.');
    return ctx.reply('La cantidad solicitada no es válida. Vuelve a elegir el producto.', homeKeyboard());
  }

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(productId);
  if (!product) return ctx.reply('Este producto ya no está disponible.', homeKeyboard());

  const existingReservation = db.prepare(`
    SELECT * FROM reservations
    WHERE user_id = ? AND product_id = ? AND status = 'pending' AND expires_at > datetime('now')
    ORDER BY id DESC LIMIT 1
  `).get(userId, productId);
  if (existingReservation) {
    await ctx.answerCbQuery();
    return ctx.reply(
      'Ya tienes una reserva activa para este producto. Completa el pago o cancélala antes de reservar más.',
      {
        ...Markup.inlineKeyboard([[
          Markup.button.callback('💳 PAGAR AHORA', `payreserved:${existingReservation.id}`),
          Markup.button.callback('❌ CANCELAR', `cancelreserve:${existingReservation.id}`),
        ]]),
      },
    );
  }

  const total = product.price_cents * quantity;
  if (!Number.isSafeInteger(total)) {
    await ctx.answerCbQuery();
    return ctx.reply('El total supera el monto admitido. Reduce la cantidad solicitada.');
  }
  const balance = getBalance(userId);
  if (balance < total) {
    await ctx.answerCbQuery();
    userFlows.delete(userId);
    return ctx.reply(`Tu saldo es ${money(balance)} y necesitas ${money(total)} por ${quantity} cuentas. Recarga saldo para continuar.`, homeKeyboard());
  }

  const reservation = runTransaction(() => {
    const availableItems = db.prepare('SELECT id, encrypted_item FROM stock WHERE product_id = ? ORDER BY id LIMIT ?')
      .all(productId, quantity);
    if (availableItems.length !== quantity) return { error: 'No hay suficientes cuentas disponibles para esa cantidad.' };
    const batchId = crypto.randomUUID();
    const expiresAt = db.prepare("SELECT datetime('now', '+5 minutes') AS value").get().value;
    const deleteItem = db.prepare('DELETE FROM stock WHERE id = ?');
    const addReservation = db.prepare(`
      INSERT INTO reservations (user_id, product_id, stock_id, encrypted_item, batch_id, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const item of availableItems) {
      deleteItem.run(item.id);
      addReservation.run(userId, productId, item.id, item.encrypted_item, batchId, expiresAt);
    }
    return {
      id: Number(db.prepare('SELECT id FROM reservations WHERE batch_id = ? ORDER BY id LIMIT 1').get(batchId).id),
      batchId,
      name: product.name,
      quantity,
      amount: total,
    };
  });

  await ctx.answerCbQuery();
  userFlows.delete(userId);
  if (reservation.error) {
    return ctx.reply(reservation.error, homeKeyboard());
  }
  await ctx.reply(
    `⏳ <b>RESERVA DE COMPRA</b>\n━━━━━━━━━━━━━━━━━━\n✨ ${escapeHtml(reservation.name)}\n📦 Cantidad: <b>${reservation.quantity}</b>\n💵 Total: <b>${money(reservation.amount)}</b>\n💰 Saldo: ${money(getBalance(userId))}\n\nTu reserva vence en <b>5 minutos</b>. Si no la confirmas, todas las cuentas vuelven al stock automáticamente.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[
        Markup.button.callback('💳 PAGAR AHORA', `payreserved:${reservation.id}`),
        Markup.button.callback('❌ CANCELAR', `cancelreserve:${reservation.id}`),
      ], [Markup.button.callback('☰ MENÚ', 'menu:home')]]),
    },
  );
});

bot.action(/^payreserved:(\d+)$/, async (ctx) => {
  const reservationId = Number(ctx.match[1]);
  expirePendingReservations();
  const reservation = db.prepare(`
    SELECT * FROM reservations
    WHERE id = ? AND status = 'pending' AND expires_at > datetime('now')
  `).get(reservationId);
  await ctx.answerCbQuery();
  if (!reservation) return ctx.reply('Esta reserva ya expiró o fue cancelada.', homeKeyboard());

  const userId = ctx.from.id;
  if (userId !== reservation.user_id) return ctx.reply('Esta reserva no te pertenece.', homeKeyboard());
  const batch = reservation.batch_id
    ? db.prepare("SELECT * FROM reservations WHERE batch_id = ? AND status = 'pending' AND expires_at > datetime('now') ORDER BY id").all(reservation.batch_id)
    : [reservation];
  if (!batch.length) return ctx.reply('La reserva ya expiró y las cuentas volvieron al stock.', homeKeyboard());

  const product = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(reservation.product_id);
  if (!product) return ctx.reply('Este producto ya no está disponible.', homeKeyboard());
  const total = product.price_cents * batch.length;
  if (!Number.isSafeInteger(total)) return ctx.reply('El total supera el monto admitido. Contacta al propietario.');

  const purchase = runTransaction(() => {
    const pending = reservation.batch_id
      ? db.prepare("SELECT * FROM reservations WHERE batch_id = ? AND status = 'pending' AND expires_at > datetime('now') ORDER BY id").all(reservation.batch_id)
      : [db.prepare("SELECT * FROM reservations WHERE id = ? AND status = 'pending' AND expires_at > datetime('now')").get(reservationId)].filter(Boolean);
    if (pending.length !== batch.length) return { error: 'La reserva expiró o cambió. No se realizó ningún cobro.' };
    const balance = getBalance(userId);
    if (balance < total) {
      return { error: `Tu saldo es ${money(balance)} y necesitas ${money(total)}. Recarga saldo para continuar.` };
    }

    db.prepare('INSERT INTO ledger (user_id, amount_cents, reason, reference_id) VALUES (?, ?, ?, ?)')
      .run(userId, -total, 'purchase', product.id);
    const insertOrder = db.prepare('INSERT INTO orders (user_id, product_id, stock_id, amount_cents, encrypted_item) VALUES (?, ?, ?, ?, ?)');
    const items = pending.map((item) => ({
      orderId: Number(insertOrder.run(userId, product.id, item.stock_id, product.price_cents, item.encrypted_item).lastInsertRowid),
      value: decryptItem(item.encrypted_item),
    }));
    const deletePending = reservation.batch_id
      ? db.prepare("DELETE FROM reservations WHERE batch_id = ? AND status = 'pending'")
      : db.prepare("DELETE FROM reservations WHERE id = ? AND status = 'pending'");
    deletePending.run(reservation.batch_id || reservationId);
    return { items, amount: total, name: product.name };
  });

  if (purchase.error) return ctx.reply(purchase.error, homeKeyboard());
  const deliveryEntries = [];
  purchase.items.forEach((item, index) => {
    const partSize = 400;
    const partCount = Math.ceil(item.value.length / partSize);
    for (let offset = 0; offset < item.value.length; offset += partSize) {
      const partNumber = Math.floor(offset / partSize) + 1;
      const label = partCount > 1 ? `${index + 1} · parte ${partNumber}/${partCount}` : `${index + 1}`;
      deliveryEntries.push(`<b>${label}.</b> <code>${escapeHtml(item.value.slice(offset, offset + partSize))}</code>`);
    }
  });
  const deliveryMessages = [];
  let deliveryMessage = '';
  for (const entry of deliveryEntries) {
    if (deliveryMessage && deliveryMessage.length + entry.length + 1 > 3500) {
      deliveryMessages.push(deliveryMessage);
      deliveryMessage = '';
    }
    deliveryMessage += `${deliveryMessage ? '\n' : ''}${entry}`;
  }
  if (deliveryMessage) deliveryMessages.push(deliveryMessage);
  await ctx.reply(
    `🎉 <b>COMPRA COMPLETADA</b>\n━━━━━━━━━━━━━━━━━━\n✨ ${escapeHtml(purchase.name)}\n📦 Cuentas: <b>${purchase.items.length}</b>\n💵 Total pagado: <b>${money(purchase.amount)}</b>`,
    { parse_mode: 'HTML', ...menuButton() },
  );
  for (let index = 0; index < deliveryMessages.length; index++) {
    await ctx.reply(
      `📩 <b>TUS ENTREGAS · ${index + 1}/${deliveryMessages.length}</b>\n\n${deliveryMessages[index]}`,
      { parse_mode: 'HTML' },
    );
  }
  await ctx.telegram.sendMessage(
    OWNER_ID,
    `🛒 Venta de ${purchase.items.length} cuenta(s)\nPedidos: ${purchase.items.map((item) => `#${item.orderId}`).join(', ')}\nCliente: ${ctx.from.first_name || ''} (@${ctx.from.username || 'sin-username'}, ID ${userId})\nProducto: ${purchase.name}\nMonto: ${money(purchase.amount)}`,
  );
});

bot.action(/^cancelreserve:(\d+)$/, async (ctx) => {
  const reservationId = Number(ctx.match[1]);
  const reservation = db.prepare("SELECT * FROM reservations WHERE id = ? AND status = 'pending'").get(reservationId);
  await ctx.answerCbQuery('Reserva cancelada.');
  if (!reservation) return ctx.reply('La reserva ya no existe.', homeKeyboard());
  if (ctx.from.id !== reservation.user_id) return ctx.reply('Esta reserva no te pertenece.', homeKeyboard());
  const restored = restoreReservationToStock(reservation);
  await ctx.reply(`✅ Se canceló la reserva y ${restored === 1 ? 'la cuenta volvió' : `las ${restored} cuentas volvieron`} al stock.`, homeKeyboard());
});

bot.action(/^admin:(add_product|price|add_stock|inventory|remove_stock|toggle_product|delete_product)$/, async (ctx) => {
  if (!isOwner(ctx)) {
    await ctx.answerCbQuery('Sin permiso.');
    return;
  }
  const action = ctx.match[1];
  await ctx.answerCbQuery();

  if (action === 'add_product') {
    adminFlows.set(ctx.from.id, { step: 'product_name' });
    return ctx.reply('Escribe el nombre del producto:');
  }
  if (action === 'inventory') return ctx.reply(stockInventoryReport());
  const list = products(false);
  if (!list.length) return ctx.reply('Todavía no hay productos.');
  const actionLabels = {
    price: 'Elige el producto para cambiar su precio:',
    add_stock: 'Elige el producto al que agregar inventario:',
    remove_stock: 'Elige el producto al que quieres quitar stock:',
    toggle_product: 'Elige el producto que quieres activar o pausar:',
    delete_product: 'Elige el producto duplicado que quieres eliminar permanentemente:',
  };
  await ctx.reply(actionLabels[action], productButtons(list, `adminselect:${action}`));
});

bot.action(/^adminselect:(price|add_stock|remove_stock|toggle_product|delete_product):(\d+)$/, async (ctx) => {
  if (!isOwner(ctx)) {
    await ctx.answerCbQuery('Sin permiso.');
    return;
  }
  const action = ctx.match[1];
  const productId = Number(ctx.match[2]);
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  await ctx.answerCbQuery();
  if (!product) return ctx.reply('No se encontró el producto.');

  if (action === 'price') {
    adminFlows.set(ctx.from.id, { step: 'product_price', productId });
    return ctx.reply(`Escribe el nuevo precio de “${product.name}” en ${CURRENCY}:`);
  }
  if (action === 'add_stock') {
    adminFlows.set(ctx.from.id, { step: 'stock_add', productId });
    return ctx.reply('Envía un archivo .txt (una unidad por línea) o pega varias unidades en un solo mensaje. Verás una vista previa antes de guardar; puedes cancelar con /cancel.');
  }
  if (action === 'remove_stock') {
    const stockCount = db.prepare('SELECT COUNT(*) AS count FROM stock WHERE product_id = ?').get(productId).count;
    if (!stockCount) return ctx.reply('Este producto no tiene inventario.');
    adminFlows.set(ctx.from.id, { step: 'stock_remove_quantity', productId });
    return ctx.reply(`¿Cuántas unidades quieres quitar de “${product.name}”?\n\nDisponibles: ${stockCount}. Escribe un número entre 1 y ${stockCount}, o usa /cancel.`);
  }
  if (action === 'delete_product') {
    const soldCount = db.prepare('SELECT COUNT(*) AS count FROM orders WHERE product_id = ?').get(productId).count;
    if (soldCount) {
      return ctx.reply(
        `No puedo eliminar “${product.name}” porque ya tiene ${soldCount} venta(s) registrada(s). Puedes ocultarlo desde “Activar / pausar”; así deja de aparecer en la tienda y se conserva el historial.`,
      );
    }
    expirePendingReservations();
    const pendingCount = db.prepare(`
      SELECT COUNT(*) AS count FROM reservations
      WHERE product_id = ? AND status = 'pending'
    `).get(productId).count;
    if (pendingCount) {
      return ctx.reply(`No puedo eliminar “${product.name}” todavía: tiene ${pendingCount} cuenta(s) reservada(s). Espera a que terminen o cancélalas y vuelve a intentarlo.`);
    }
    const stockCount = db.prepare('SELECT COUNT(*) AS count FROM stock WHERE product_id = ?').get(productId).count;
    return ctx.reply(
      `⚠️ <b>ELIMINAR PRODUCTO PERMANENTEMENTE</b>\n━━━━━━━━━━━━━━━━━━\nProducto: <b>${escapeHtml(product.name)}</b>\nStock que se eliminará: <b>${stockCount}</b>\n\nEsto quitará el producto de la tienda y borrará sus unidades disponibles y huellas de inventario. No se puede deshacer.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[
          Markup.button.callback('🗑️ SÍ, ELIMINAR', `adminproductdelete:confirm:${productId}`),
          Markup.button.callback('❌ CANCELAR', 'adminproductdelete:cancel'),
        ]]),
      },
    );
  }

  db.prepare('UPDATE products SET active = CASE active WHEN 1 THEN 0 ELSE 1 END WHERE id = ?').run(productId);
  const updated = db.prepare('SELECT active FROM products WHERE id = ?').get(productId);
  await ctx.reply(`Producto “${product.name}” ${updated.active ? 'activado' : 'pausado'}.`);
});

bot.action(/^stockdelete:(\d+):(\d+)$/, async (ctx) => {
  if (!isOwner(ctx)) {
    await ctx.answerCbQuery('Sin permiso.');
    return;
  }
  const result = db.prepare('DELETE FROM stock WHERE id = ? AND product_id = ?').run(Number(ctx.match[2]), Number(ctx.match[1]));
  await ctx.answerCbQuery();
  await ctx.reply(result.changes ? 'Unidad de inventario eliminada.' : 'La unidad ya no existe.');
});

bot.action('adminproductdelete:cancel', async (ctx) => {
  if (!isOwner(ctx)) {
    await ctx.answerCbQuery('Sin permiso.');
    return;
  }
  await ctx.answerCbQuery('Eliminación cancelada.');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
});

bot.action(/^adminproductdelete:confirm:(\d+)$/, async (ctx) => {
  if (!isOwner(ctx)) {
    await ctx.answerCbQuery('Sin permiso.');
    return;
  }
  const productId = Number(ctx.match[1]);
  expirePendingReservations();
  const result = runTransaction(() => {
    const product = db.prepare('SELECT name FROM products WHERE id = ?').get(productId);
    if (!product) return { error: 'El producto ya no existe.' };
    const soldCount = db.prepare('SELECT COUNT(*) AS count FROM orders WHERE product_id = ?').get(productId).count;
    if (soldCount) {
      return { error: 'El producto ya tiene ventas registradas y no se puede eliminar sin borrar el historial. Puedes ocultarlo desde “Activar / pausar”.' };
    }
    const pendingCount = db.prepare(`
      SELECT COUNT(*) AS count FROM reservations
      WHERE product_id = ? AND status = 'pending'
    `).get(productId).count;
    if (pendingCount) return { error: 'El producto tiene una reserva activa. Cancélala o espera a que expire antes de eliminarlo.' };
    const stockCount = db.prepare('SELECT COUNT(*) AS count FROM stock WHERE product_id = ?').get(productId).count;
    db.prepare('DELETE FROM stock WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM inventory_fingerprints WHERE product_id = ?').run(productId);
    db.prepare('DELETE FROM products WHERE id = ?').run(productId);
    return { name: product.name, stockCount };
  });
  await ctx.answerCbQuery(result.error ? 'No se eliminó.' : 'Producto eliminado.');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply(
    result.error
      ? result.error
      : `✅ Se eliminó permanentemente “${result.name}” y se retiraron ${result.stockCount} unidad(es) de stock.`,
  );
});

bot.action('stockremove:cancel', async (ctx) => {
  if (!isOwner(ctx)) {
    await ctx.answerCbQuery('Sin permiso.');
    return;
  }
  adminFlows.delete(ctx.from.id);
  await ctx.answerCbQuery('Eliminación cancelada.');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
});

bot.action('stockremove:confirm', async (ctx) => {
  if (!isOwner(ctx)) {
    await ctx.answerCbQuery('Sin permiso.');
    return;
  }
  const flow = adminFlows.get(ctx.from.id);
  if (flow?.step !== 'stock_remove_confirm') {
    await ctx.answerCbQuery('La confirmación ya no está activa.');
    return;
  }
  const removed = runTransaction(() => {
    const items = db.prepare('SELECT id FROM stock WHERE product_id = ? ORDER BY id LIMIT ?')
      .all(flow.productId, flow.quantity);
    const deleteItem = db.prepare('DELETE FROM stock WHERE id = ?');
    for (const item of items) deleteItem.run(item.id);
    return items.length;
  });
  adminFlows.delete(ctx.from.id);
  await ctx.answerCbQuery('Inventario actualizado.');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply(
    removed
      ? `🗑️ Se quitaron ${removed} unidad(es) del inventario.`
      : 'No quedan unidades disponibles para quitar.',
  );
});

bot.action('stockimport:cancel', async (ctx) => {
  if (!isOwner(ctx)) {
    await ctx.answerCbQuery('Sin permiso.');
    return;
  }
  adminFlows.delete(ctx.from.id);
  await ctx.answerCbQuery('Importación cancelada.');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.reply('Importación cancelada. No se guardó ninguna unidad.');
});

bot.action('stockimport:confirm', async (ctx) => {
  if (!isOwner(ctx)) {
    await ctx.answerCbQuery('Sin permiso.');
    return;
  }
  const flow = adminFlows.get(ctx.from.id);
  if (flow?.step !== 'stock_preview') {
    await ctx.answerCbQuery('La vista previa ya no está activa.');
    return;
  }
  const { preview } = flow;
  const result = runTransaction(() => {
    const reserve = db.prepare('INSERT OR IGNORE INTO inventory_fingerprints (fingerprint, product_id) VALUES (?, ?)');
    const insert = db.prepare('INSERT INTO stock (product_id, encrypted_item) VALUES (?, ?)');
    let added = 0;
    for (const item of preview.items) {
      const fingerprint = fingerprintItem(item);
      const reservation = reserve.run(fingerprint, preview.productId);
      if (!reservation.changes) continue;
      insert.run(preview.productId, encryptItem(item));
      added++;
    }
    return added;
  });
  adminFlows.delete(ctx.from.id);
  await ctx.answerCbQuery('Importación guardada.');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  const summary = `Importación completada.\nUnidades nuevas agregadas: ${result}\nDuplicados o repetidos omitidos: ${preview.receivedCount - result}.`;
  if (!result) return ctx.reply(summary);
  await ctx.reply(`${summary}\n\n📣 Enviando aviso a los clientes...`);
  const notification = await notifyUsersOfNewStock(preview.productId, result);
  await ctx.reply(
    `📣 Aviso de stock terminado.\n✅ Enviados: ${notification.sent}\n⚠️ No entregados: ${notification.failed}`,
  );
});

bot.action(/^topup:(approve|reject):(\d+)$/, async (ctx) => {
  if (!isOwner(ctx)) {
    await ctx.answerCbQuery('Sin permiso.');
    return;
  }
  const decision = ctx.match[1];
  const topupId = Number(ctx.match[2]);
  const result = runTransaction(() => {
    const topup = db.prepare('SELECT * FROM topups WHERE id = ?').get(topupId);
    if (!topup || topup.status !== 'proof_received') return null;
    const newStatus = decision === 'approve' ? 'approved' : 'rejected';
    db.prepare('UPDATE topups SET status = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, topupId);
    if (decision === 'approve') {
      db.prepare('INSERT INTO ledger (user_id, amount_cents, reason, reference_id) VALUES (?, ?, ?, ?)')
        .run(topup.user_id, topup.amount_cents, 'topup', topupId);
    }
    return topup;
  });
  await ctx.answerCbQuery(result ? 'Solicitud procesada.' : 'Ya fue procesada.');
  if (!result) return;
  const approved = decision === 'approve';
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
  await ctx.telegram.sendMessage(
    result.user_id,
    approved
      ? `Tu recarga #${topupId} fue aprobada. Se acreditaron ${money(result.amount_cents)}. Saldo actual: ${money(getBalance(result.user_id))}.`
      : `Tu recarga #${topupId} fue rechazada. Si necesitas ayuda, contacta al propietario.`,
  );
});

bot.on('text', async (ctx, next) => {
  if (ctx.message.text.startsWith('/') && ctx.message.text !== '/skip') return next();
  if (isOwner(ctx) && emojiIdChecks.has(ctx.from.id)) {
    emojiIdChecks.delete(ctx.from.id);
    const customEmojiEntities = (ctx.message.entities || [])
      .filter((entity) => entity.type === 'custom_emoji');
    if (!customEmojiEntities.length) {
      return ctx.reply('No detecté un emoji Premium personalizado. Reenvía el emoji desde Telegram Premium y ejecuta /emojiid otra vez.');
    }
    return ctx.reply(
      `IDs encontrados:\n${customEmojiEntities.map((entity) => `<code>${entity.custom_emoji_id}</code>`).join('\n')}`,
      { parse_mode: 'HTML' },
    );
  }
  ensureUser(ctx.from);
  const flow = userFlows.get(ctx.from.id);
  if (flow?.step === 'topup_amount') {
    const amount = parseAmount(ctx.message.text);
    if (!amount || amount > 100000000) return ctx.reply(`Monto no válido. Escribe una cantidad positiva en ${CURRENCY}, hasta 1,000,000.`);
    const result = db.prepare('INSERT INTO topups (user_id, amount_cents) VALUES (?, ?)').run(ctx.from.id, amount);
    const topupId = Number(result.lastInsertRowid);
    userFlows.set(ctx.from.id, { step: 'topup_proof', topupId });
    const binanceId = process.env.BINANCE_PAY_ID || process.env.BINANCE_ID;
    return ctx.reply(
      `🟡 <b>DEPÓSITO BINANCE PAY</b>\n━━━━━━━━━━━━━━━━━━\n👤 Pay ID: <code>${escapeHtml(binanceId)}</code>\n💵 Envía exactamente <b>${money(amount)}</b>.\n\n🧾 Después, envía tu comprobante o el Order ID aquí.\n🔖 Solicitud: <b>#${topupId}</b>\n\nEl saldo se acreditará cuando el propietario revise el pago.`,
      { parse_mode: 'HTML', ...menuButton() },
    );
  }
  if (flow?.step === 'purchase_quantity') {
    const quantityText = ctx.message.text.trim();
    if (!/^\d+$/.test(quantityText)) {
      return ctx.reply('Escribe solo la cantidad en números enteros (por ejemplo: 3), o usa /cancel.');
    }
    const quantity = Number(quantityText);
    const product = db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM stock s WHERE s.product_id = p.id) AS stock_count
      FROM products p WHERE p.id = ? AND p.active = 1
    `).get(flow.productId);
    if (!product || !product.stock_count) {
      userFlows.delete(ctx.from.id);
      return ctx.reply('Este producto ya no está disponible.', homeKeyboard());
    }
    const maxQuantity = Math.min(product.stock_count, MAX_ORDER_QUANTITY);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > maxQuantity) {
      return ctx.reply(`Cantidad no válida. Escribe un número entre 1 y ${maxQuantity}.`);
    }
    const total = product.price_cents * quantity;
    userFlows.delete(ctx.from.id);
    return ctx.reply(
      `🧾 <b>RESUMEN DE TU PEDIDO</b>\n━━━━━━━━━━━━━━━━━━\n✨ ${escapeHtml(product.name)}\n📦 Cantidad: <b>${quantity}</b>\n💵 Precio por cuenta: ${money(product.price_cents)}\n💰 Total: <b>${money(total)}</b>\n\n¿Reservamos estas cuentas por 5 minutos?`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[
          Markup.button.callback('✅ RESERVAR', `confirmbuy:${product.id}:${quantity}`),
          Markup.button.callback('✖️ CANCELAR', 'cancel'),
        ]]),
      },
    );
  }
  const adminFlow = adminFlows.get(ctx.from.id);
  if (!adminFlow || !isOwner(ctx)) return next();

  if (adminFlow.step === 'product_name') {
    const name = ctx.message.text.trim();
    if (!name || name.length > 80) return ctx.reply('El nombre debe tener entre 1 y 80 caracteres.');
    adminFlows.set(ctx.from.id, { ...adminFlow, step: 'product_description', name });
    return ctx.reply('Escribe una descripción breve (o /skip para dejarla vacía):');
  }
  if (adminFlow.step === 'product_description') {
    const description = ctx.message.text === '/skip' ? '' : ctx.message.text.trim();
    if (description.length > 500) return ctx.reply('La descripción no puede superar 500 caracteres.');
    adminFlows.set(ctx.from.id, { ...adminFlow, step: 'new_product_price', description });
    return ctx.reply(`Escribe el precio en ${CURRENCY}:`);
  }
  if (adminFlow.step === 'new_product_price' || adminFlow.step === 'product_price') {
    const amount = parseAmount(ctx.message.text);
    if (!amount) return ctx.reply(`Precio no válido. Escribe un monto positivo en ${CURRENCY}.`);
    if (adminFlow.step === 'new_product_price') {
      const result = db.prepare('INSERT INTO products (name, description, price_cents) VALUES (?, ?, ?)')
        .run(adminFlow.name, adminFlow.description, amount);
      adminFlows.delete(ctx.from.id);
      return ctx.reply(`Producto “${adminFlow.name}” creado con precio ${money(amount)}. Agrega inventario desde /admin.`);
    }
    db.prepare('UPDATE products SET price_cents = ? WHERE id = ?').run(amount, adminFlow.productId);
    adminFlows.delete(ctx.from.id);
    return ctx.reply(`Precio actualizado a ${money(amount)}.`);
  }
  if (adminFlow.step === 'stock_add') {
    return showInventoryPreview(ctx, adminFlow.productId, ctx.message.text);
  }
  if (adminFlow.step === 'stock_remove_quantity') {
    const quantityText = ctx.message.text.trim();
    if (!/^\d+$/.test(quantityText)) {
      return ctx.reply('Escribe solo la cantidad en números enteros, o usa /cancel.');
    }
    const quantity = Number(quantityText);
    const stockCount = db.prepare('SELECT COUNT(*) AS count FROM stock WHERE product_id = ?').get(adminFlow.productId).count;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > stockCount) {
      return ctx.reply(`Cantidad no válida. Actualmente hay ${stockCount} unidades disponibles.`);
    }
    adminFlows.set(ctx.from.id, { step: 'stock_remove_confirm', productId: adminFlow.productId, quantity });
    return ctx.reply(
      `⚠️ Vas a eliminar <b>${quantity}</b> unidad(es) del stock disponible.\nNo se puede deshacer. ¿Confirmas?`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[
          Markup.button.callback('🗑️ SÍ, QUITAR', 'stockremove:confirm'),
          Markup.button.callback('❌ CANCELAR', 'stockremove:cancel'),
        ]]),
      },
    );
  }
  return next();
});

bot.on(['photo', 'document'], async (ctx) => {
  const adminFlow = adminFlows.get(ctx.from.id);
  if (isOwner(ctx) && adminFlow?.step === 'stock_add') {
    if (!ctx.message.document) {
      return ctx.reply('Para importar un archivo, envía un .txt. También puedes pegar las unidades como texto.');
    }
    const document = ctx.message.document;
    if (!document.file_name?.toLowerCase().endsWith('.txt')) {
      return ctx.reply('El archivo debe tener extensión .txt.');
    }
    const maxFileBytes = 2 * 1024 * 1024;
    if (document.file_size && document.file_size > maxFileBytes) {
      return ctx.reply('El archivo supera el límite de 2 MB. Divídelo en varios archivos TXT.');
    }
    try {
      const fileUrl = await ctx.telegram.getFileLink(document.file_id);
      const response = await fetch(fileUrl, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        throw new Error(`Telegram devolvió HTTP ${response.status} al descargar el archivo.`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxFileBytes) {
        return ctx.reply('El archivo supera el límite de 2 MB. Divídelo en varios archivos TXT.');
      }
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return showInventoryPreview(ctx, adminFlow.productId, content);
    } catch (error) {
      console.error('No se pudo leer el archivo TXT de inventario.');
      return ctx.reply('No pude descargar o leer ese TXT. Comprueba que sea texto UTF-8 válido y vuelve a intentarlo.');
    }
  }

  const flow = userFlows.get(ctx.from.id);
  if (flow?.step !== 'topup_proof') return;
  const topup = db.prepare('SELECT * FROM topups WHERE id = ? AND user_id = ? AND status = ?')
    .get(flow.topupId, ctx.from.id, 'awaiting_proof');
  if (!topup) {
    userFlows.delete(ctx.from.id);
    return ctx.reply('Esta solicitud ya no está pendiente. Inicia una nueva recarga si lo necesitas.');
  }

  db.prepare('UPDATE topups SET status = ? WHERE id = ?').run('proof_received', topup.id);
  userFlows.delete(ctx.from.id);
  await ctx.reply(`Comprobante recibido para la solicitud #${topup.id}. Te avisaré cuando se revise.`);
  await ctx.telegram.sendMessage(
    OWNER_ID,
    `🧾 Recarga pendiente #${topup.id}\nCliente: ${ctx.from.first_name || ''} (@${ctx.from.username || 'sin-username'}, ID ${ctx.from.id})\nMonto solicitado: ${money(topup.amount_cents)}`,
    Markup.inlineKeyboard([[
      Markup.button.callback('✅ Aprobar', `topup:approve:${topup.id}`),
      Markup.button.callback('❌ Rechazar', `topup:reject:${topup.id}`),
    ]]),
  );
  await ctx.telegram.copyMessage(OWNER_ID, ctx.chat.id, ctx.message.message_id);
});

bot.on('text', async (ctx, next) => {
  const flow = userFlows.get(ctx.from.id);
  if (flow?.step === 'topup_proof') {
    if (ctx.message.text.startsWith('/')) return next();
    const topup = db.prepare('SELECT * FROM topups WHERE id = ? AND user_id = ? AND status = ?')
      .get(flow.topupId, ctx.from.id, 'awaiting_proof');
    if (!topup) {
      userFlows.delete(ctx.from.id);
      return ctx.reply('Esta solicitud ya no está pendiente. Inicia una nueva recarga si lo necesitas.');
    }
    db.prepare('UPDATE topups SET status = ? WHERE id = ?').run('proof_received', topup.id);
    userFlows.delete(ctx.from.id);
    await ctx.reply(`Comprobante recibido para la solicitud #${topup.id}. Te avisaré cuando se revise.`);
    await ctx.telegram.sendMessage(
      OWNER_ID,
      `🧾 Recarga pendiente #${topup.id}\nCliente: ${ctx.from.first_name || ''} (@${ctx.from.username || 'sin-username'}, ID ${ctx.from.id})\nMonto solicitado: ${money(topup.amount_cents)}\nComprobante: ${ctx.message.text}`,
      Markup.inlineKeyboard([[
        Markup.button.callback('✅ Aprobar', `topup:approve:${topup.id}`),
        Markup.button.callback('❌ Rechazar', `topup:reject:${topup.id}`),
      ]]),
    );
    return;
  }
  return next();
});

bot.catch((error, ctx) => {
  console.error(`Error procesando actualización ${ctx.update.update_id}:`, error);
});

bot.launch().then(() => {
  console.log('Bot iniciado. Detén con Ctrl+C.');
}).catch((error) => {
  console.error('No se pudo iniciar el bot:', error);
  process.exitCode = 1;
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
