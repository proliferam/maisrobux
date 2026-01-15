import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  Events,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  SectionBuilder,
  ThumbnailBuilder,
  TextDisplayBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
} from "discord.js";
import fetch from "node-fetch";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import mercadopago from "mercadopago";

import { criarPagamento } from "./mercadopago.js";


// ================================================================
// 🔵 CONFIGURAÇÕES DO BANCO DE DADOS
// ================================================================
let db = null;

async function initDatabase() {
    db = await open({
        filename: './database.sqlite',
        driver: sqlite3.Database
    });

    // Tabela de compras
    await db.exec(`
        CREATE TABLE IF NOT EXISTS purchases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            discord_id TEXT NOT NULL,
            roblox_username TEXT,
            roblox_id TEXT,
            gamepass_ids TEXT,
            total_robux INTEGER,
            total_brl REAL,
            status TEXT DEFAULT 'pending',
            payment_id TEXT,
            payment_method TEXT,
            coupon_code TEXT,
            discount_amount REAL DEFAULT 0,
            net_value REAL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Tabela de cupons
    await db.exec(`
        CREATE TABLE IF NOT EXISTS coupons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL,
            discount_type TEXT CHECK(discount_type IN ('percentage', 'fixed')),
            discount_value REAL,
            max_uses INTEGER,
            used_count INTEGER DEFAULT 0,
            valid_until DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            is_active BOOLEAN DEFAULT 1
        )
    `);

    // Tabela de estatísticas de vendas
    await db.exec(`
        CREATE TABLE IF NOT EXISTS sales_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            discord_id TEXT,
            total_purchases INTEGER DEFAULT 0,
            total_spent REAL DEFAULT 0,
            last_purchase DATETIME,
            month_year TEXT,
            commission_earned REAL DEFAULT 0
        )
    `);

    // Tabela de cargos e permissões
    await db.exec(`
        CREATE TABLE IF NOT EXISTS role_permissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role_id TEXT UNIQUE NOT NULL,
            role_name TEXT,
            can_view_stats BOOLEAN DEFAULT 0,
            can_view_all_stats BOOLEAN DEFAULT 0,
            can_manage_coupons BOOLEAN DEFAULT 0,
            can_manage_roles BOOLEAN DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    console.log('✅ Banco de dados inicializado');
    return db;
}

async function getDatabase() {
    if (!db) await initDatabase();
    return db;
}

async function savePurchase(data) {
    const db = await getDatabase();
    const result = await db.run(`
        INSERT INTO purchases (
            user_id, discord_id, roblox_username, roblox_id,
            gamepass_ids, total_robux, total_brl, status,
            payment_id, coupon_code, discount_amount, net_value
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
        data.userId,
        data.discordId,
        data.robloxUsername,
        data.robloxId,
        JSON.stringify(data.gamepassIds),
        data.totalRobux,
        data.totalBRL,
        data.status || 'pending',
        data.paymentId || null,
        data.couponCode || null,
        data.discountAmount || 0,
        data.netValue || data.totalBRL
    ]);
    
    return result.lastID;
}

async function updatePurchaseStatus(purchaseId, status, paymentId = null) {
    const db = await getDatabase();
    await db.run(`
        UPDATE purchases 
        SET status = ?, payment_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `, [status, paymentId, purchaseId]);
    
    // Atualizar estatísticas se o status for "paid"
    if (status === 'paid' || status === 'approved') {
        const purchase = await db.get('SELECT * FROM purchases WHERE id = ?', [purchaseId]);
        if (purchase) {
            await updateSalesStats(purchase);
        }
    }
}

async function getCoupon(code) {
    const db = await getDatabase();
    return await db.get('SELECT * FROM coupons WHERE code = ? AND is_active = 1', [code]);
}

async function useCoupon(code) {
    const db = await getDatabase();
    const coupon = await getCoupon(code);
    
    if (!coupon) return false;
    
    if (coupon.max_uses && coupon.used_count >= coupon.max_uses) {
        await db.run('UPDATE coupons SET is_active = 0 WHERE code = ?', [code]);
        return false;
    }
    
    if (coupon.valid_until && new Date(coupon.valid_until) < new Date()) {
        await db.run('UPDATE coupons SET is_active = 0 WHERE code = ?', [code]);
        return false;
    }
    
    await db.run(`
        UPDATE coupons 
        SET used_count = used_count + 1 
        WHERE code = ?
    `, [code]);
    
    return coupon;
}

async function createCoupon(data) {
    const db = await getDatabase();
    try {
        const result = await db.run(`
            INSERT INTO coupons (code, discount_type, discount_value, max_uses, valid_until)
            VALUES (?, ?, ?, ?, ?)
        `, [
            data.code,
            data.discountType,
            data.discountValue,
            data.maxUses || null,
            data.validUntil || null
        ]);
        return result.lastID;
    } catch (error) {
        console.error('Erro ao criar cupom:', error);
        return null;
    }
}

async function updateSalesStats(purchase) {
    const db = await getDatabase();
    const monthYear = new Date().toISOString().slice(0, 7); // YYYY-MM
    
    // Verificar se já existe estatística para este mês
    const existingStat = await db.get(`
        SELECT * FROM sales_stats 
        WHERE discord_id = ? AND month_year = ?
    `, [purchase.discord_id, monthYear]);
    
    const commission = purchase.net_value * 0.15;
    
    if (existingStat) {
        await db.run(`
            UPDATE sales_stats 
            SET total_purchases = total_purchases + 1,
                total_spent = total_spent + ?,
                commission_earned = commission_earned + ?,
                last_purchase = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [purchase.net_value, commission, existingStat.id]);
    } else {
        await db.run(`
            INSERT INTO sales_stats (user_id, discord_id, total_purchases, total_spent, month_year, commission_earned)
            VALUES (?, ?, 1, ?, ?, ?)
        `, [
            purchase.user_id,
            purchase.discord_id,
            purchase.net_value,
            monthYear,
            commission
        ]);
    }
}

async function getUserStats(discordId) {
    const db = await getDatabase();
    return await db.get(`
        SELECT 
            SUM(total_purchases) as total_purchases,
            SUM(total_spent) as total_spent,
            SUM(commission_earned) as total_commission,
            COUNT(DISTINCT month_year) as active_months
        FROM sales_stats 
        WHERE discord_id = ?
    `, [discordId]);
}

async function getAllStats(monthYear = null) {
    const db = await getDatabase();
    let query = `
        SELECT 
            discord_id,
            SUM(total_purchases) as total_purchases,
            SUM(total_spent) as total_spent,
            SUM(commission_earned) as total_commission
        FROM sales_stats 
    `;
    
    const params = [];
    if (monthYear) {
        query += ' WHERE month_year = ?';
        params.push(monthYear);
    }
    
    query += ' GROUP BY discord_id ORDER BY total_spent DESC';
    
    return await db.all(query, params);
}

async function getRolePermissions(roleId) {
    const db = await getDatabase();
    return await db.get('SELECT * FROM role_permissions WHERE role_id = ?', [roleId]);
}

async function addRolePermission(roleData) {
    const db = await getDatabase();
    try {
        const result = await db.run(`
            INSERT INTO role_permissions (role_id, role_name, can_view_stats, can_view_all_stats, can_manage_coupons, can_manage_roles)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [
            roleData.roleId,
            roleData.roleName,
            roleData.canViewStats ? 1 : 0,
            roleData.canViewAllStats ? 1 : 0,
            roleData.canManageCoupons ? 1 : 0,
            roleData.canManageRoles ? 1 : 0
        ]);
        return result.lastID;
    } catch (error) {
        console.error('Erro ao adicionar permissão:', error);
        return null;
    }
}

async function updateRolePermission(roleId, roleData) {
    const db = await getDatabase();
    await db.run(`
        UPDATE role_permissions 
        SET can_view_stats = ?,
            can_view_all_stats = ?,
            can_manage_coupons = ?,
            can_manage_roles = ?,
            role_name = ?
        WHERE role_id = ?
    `, [
        roleData.canViewStats ? 1 : 0,
        roleData.canViewAllStats ? 1 : 0,
        roleData.canManageCoupons ? 1 : 0,
        roleData.canManageRoles ? 1 : 0,
        roleData.roleName,
        roleId
    ]);
}

async function deleteRolePermission(roleId) {
    const db = await getDatabase();
    await db.run('DELETE FROM role_permissions WHERE role_id = ?', [roleId]);
}

async function getAllRolePermissions() {
    const db = await getDatabase();
    return await db.all('SELECT * FROM role_permissions ORDER BY created_at');
}

async function buscarGamepasses(userId) {
  const url = `https://catalog.roblox.com/v1/search/items/details?Category=GamePass&CreatorTargetId=${userId}&CreatorType=User&limit=50`;

  const res = await fetch(url);
  const data = await res.json();

  return data.data || [];
}

function encontrarGamepassPorValor(gamepasses, valorDesejado) {
  return gamepasses.find(gp => gp.price === valorDesejado);
}

// ================================================================
// 🎨 CONFIGURAÇÕES
// ================================================================
const UI_THEME = {
    GREEN: 0x57F287,
    RED: 0xED4245,
    ORANGE: 0xFFA500,
    GRAY: 0x2B2D31,
    BLUE: 0x5865F2,
    LOGO: "https://media.discordapp.net/attachments/1397917461336035471/1439417508955426846/INICIAR.png?format=webp",
    BANNER_CART: "https://media.discordapp.net/attachments/1397917461336035471/1439417508955426846/INICIAR.png?format=webp"
};

const ECONOMY = {
    PRICE_PER_ROBUX: 0.048
};

// ================================================================
// 🔵 CONFIGURAÇÕES MERCADO PAGO
// ================================================================
const MERCADO_PAGO = {
    ACCESS_TOKEN: process.env.MERCADO_PAGO_ACCESS_TOKEN,
    WEBHOOK_SECRET: process.env.MERCADO_PAGO_WEBHOOK_SECRET
};

// Configurações de categorias
const CATEGORIES = {
    PENDING: "1446674527345184952",
    PAID: "1446674549193179348"
};

// Inicializar Mercado Pago
if (MERCADO_PAGO.ACCESS_TOKEN) {
    mercadopago.configure({
        access_token: MERCADO_PAGO.ACCESS_TOKEN
    });
    console.log('✅ Mercado Pago configurado');
}

let IS_SHOP_OPEN = true; 

let MAIN_PANEL_DATA = {
    channelId: "1424199624822100010", 
    messageId: "1443818839073751162" 
};

const userPurchaseData = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

const TOKEN = process.env.DISCORD_TOKEN;
const ROBLOX_SECURITY = process.env.ROBLOSECURITY;
let CSRF_TOKEN = null;

const THREAD_AUTO_DELETE_MS = 30 * 60 * 1000;

// ================================================================
// 🧮 CALCULADORA DE PREÇOS
// ================================================================
function calculatePrice(robuxAmount, coupon = null) {
    // Base: R$40 = 1000 Robux (com acréscimo do Roblox: 1429 Robux)
    const baseRate = 40 / 1429; // Preço por Robux considerando acréscimo
    let basePrice = robuxAmount * baseRate;
    
    let discount = 0;
    let finalPrice = basePrice;
    
    if (coupon) {
        if (coupon.discount_type === 'percentage') {
            discount = basePrice * (coupon.discount_value / 100);
        } else if (coupon.discount_type === 'fixed') {
            discount = coupon.discount_value;
        }
        finalPrice = basePrice - discount;
        if (finalPrice < 0) finalPrice = 0;
    }
    
    return {
        robuxAmount,
        basePrice: parseFloat(basePrice.toFixed(2)),
        discount: parseFloat(discount.toFixed(2)),
        finalPrice: parseFloat(finalPrice.toFixed(2)),
        gamepassValue: Math.ceil(robuxAmount / 0.7) // Valor da gamepass considerando 30% do Roblox
    };
}

// ================================================================
// 💰 FUNÇÕES MERCADO PAGO
// ================================================================
async function createMercadoPagoPayment(purchaseData, discordUserId, threadId, purchaseId) {
    try {
        const preference = {
            items: [
                {
                    title: `Compra de ${purchaseData.totalRobux} Robux`,
                    description: `Roblox: ${purchaseData.robloxUsername}`,
                    quantity: 1,
                    currency_id: 'BRL',
                    unit_price: purchaseData.finalPrice
                }
            ],
            notification_url: `${process.env.WEBHOOK_URL || 'https://seu-webhook.com'}/mercadopago-webhook`,
            external_reference: JSON.stringify({
                discordUserId,
                threadId,
                purchaseId
            }),
            back_urls: {
                success: process.env.SUCCESS_URL || 'https://discord.com/channels/',
                failure: process.env.FAILURE_URL || 'https://discord.com/channels/',
                pending: process.env.PENDING_URL || 'https://discord.com/channels/'
            },
            auto_return: 'approved',
            statement_descriptor: 'ROBUX STORE'
        };

        const response = await mercadopago.preferences.create(preference);
        return response.body;
    } catch (error) {
        console.error('Erro ao criar pagamento Mercado Pago:', error);
        return null;
    }
}

// ================================================================
// 📁 FUNÇÕES DE CATEGORIAS
// ================================================================
async function moveThreadToCategory(threadId, categoryId) {
    try {
        const thread = await client.channels.fetch(threadId);
        if (thread && thread.parentId !== categoryId) {
            await thread.setParent(categoryId);
            console.log(`✅ Thread ${threadId} movida para categoria ${categoryId}`);
            return true;
        }
        return false;
    } catch (error) {
        console.error('Erro ao mover thread:', error);
        return false;
    }
}

// ================================================================
// 🔒 FUNÇÕES DE PERMISSÃO
// ================================================================
async function checkAdminPermissions(member, requiredPermission = 'can_view_stats') {
    // Verificar se o usuário tem permissão através do banco de dados
    for (const role of member.roles.cache.values()) {
        const permissions = await getRolePermissions(role.id);
        if (permissions && permissions[requiredPermission]) {
            return true;
        }
    }
    return false;
}

// ================================================================
// 🔵 FUNÇÕES DE AUTENTICAÇÃO & ROBLOX
// ================================================================
async function getCsrfToken() {
  if (CSRF_TOKEN) return CSRF_TOKEN;
  try {
    const res = await fetch("https://auth.roblox.com/v2/logout", {
      method: "POST",
      headers: { Cookie: `.ROBLOSECURITY=${ROBLOX_SECURITY}`, "Content-Type": "application/json" },
    });
    const token = res.headers.get("x-csrf-token");
    if (token) { CSRF_TOKEN = token; return token; }
    return null;
  } catch (error) { console.error("Erro CSRF:", error); return null; }
}

async function buildRobloxHeaders(method = "GET") {
  const headers = { "Content-Type": "application/json", Cookie: `.ROBLOSECURITY=${ROBLOX_SECURITY}` };
  const csrfToken = await getCsrfToken();
  if (csrfToken) headers["X-CSRF-TOKEN"] = csrfToken;
  return headers;
}

async function getRobloxUser(username) {
  try {
    const body = { usernames: [username], excludeBannedUsers: false };
    const headers = await buildRobloxHeaders("POST");
    const res = await fetch("https://users.roblox.com/v1/usernames/users", {
      method: "POST", headers, body: JSON.stringify(body),
    });
    const data = await res.json();
    return data.data?.[0] || null;
  } catch (err) { return null; }
}

async function getRobloxAvatar(userId) {
  const fallback = UI_THEME.LOGO;
  try {
    const headers = await buildRobloxHeaders("GET");
    const res = await fetch(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=420x420&format=Png&isCircular=false`,
      { headers }
    );
    const data = await res.json();
    return data.data?.[0]?.imageUrl || fallback;
  } catch (err) { return fallback; }
}

async function getUserGames(userId) {
  try {
    const headers = await buildRobloxHeaders("GET");
    const res = await fetch(`https://games.roblox.com/v2/users/${userId}/games?accessFilter=Public&limit=10&sortOrder=Desc`, { headers });
    const data = await res.json();
    return data.data || [];
  } catch (err) { return []; }
}

async function getUserGamepasses(userId) {
  try {
    const res = await fetch(`https://apis.roblox.com/game-passes/v1/users/${userId}/game-passes?count=100`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.gamePasses || [];
  } catch (err) { return null; }
}

async function getGamepassInfo(gamePassId) {
  try {
    const res = await fetch(`https://apis.roblox.com/game-passes/v1/game-passes/${gamePassId}/product-info`);
    if (!res.ok) return null;
    const data = await res.json();
    return data;
  } catch (err) { return null; }
}

// ================================================================
// 🔵 FUNÇÕES AUXILIARES
// ================================================================
function scheduleThreadAutoDelete(userId, thread) {
  const timeout = setTimeout(async () => {
    try {
      await thread.send("⏰ Esta compra ficou inativa por muito tempo. A thread será encerrada.");
      await thread.delete().catch(() => {});
    } catch (e) {} finally {
      const data = userPurchaseData.get(userId);
      if (data) {
        if (data.threadDeleteTimeout) clearTimeout(data.threadDeleteTimeout);
        userPurchaseData.delete(userId);
      }
    }
  }, THREAD_AUTO_DELETE_MS);
  const current = userPurchaseData.get(userId) || {};
  userPurchaseData.set(userId, { ...current, threadId: thread.id, threadDeleteTimeout: timeout });
}

function clearThreadAutoDelete(userId) {
  const data = userPurchaseData.get(userId);
  if (!data) return;
  if (data.threadDeleteTimeout) { clearTimeout(data.threadDeleteTimeout); data.threadDeleteTimeout = null; }
  userPurchaseData.set(userId, data);
}

const formatBRL = (val) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(val);

// ================================================================
// 🎨 UI BUILDERS
// ================================================================

function buildMainPanelComponents() {
    const statusText = IS_SHOP_OPEN ? "🟢 Aberta - anúncios." : "🔴 Fechada - Não aceitamos pedidos.";
    const statusColor = IS_SHOP_OPEN ? UI_THEME.GREEN : UI_THEME.RED;

    return [
      new ContainerBuilder()
        .setAccentColor(statusColor)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("## Painel de compras 🛒\n▎ Primeira vez aqui? Veja as [avaliações](https://discord.gg/seu-link)")
        )
        .addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(UI_THEME.LOGO))
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "\n**1. Como comprar**\n" +
              "Acesse o [tutorial](https://discord.gg/seu-link).\n" +
              "Faça o seu pedido clicando no botão abaixo.\n\n" +
              "**2. Informações**\n" +
              "Dúvidas ou erros, contate o [suporte](https://discord.gg/seu-link).\n" +
              "Valores e Limites veja [clicando aqui](https://discord.gg/seu-link).\n\n" +
              "**3. Estado da Loja**\n" +
              statusText
            )
        )
        .addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel("🛒 Criar carrinho").setCustomId("criar_thread_privada").setDisabled(!IS_SHOP_OPEN)
          )
        )
    ];
}

function buildCartWelcomeContainer(user) {
    return new ContainerBuilder()
      .setAccentColor(UI_THEME.GREEN)
      .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("## Carrinho De Compras\n▎ Compre seus robux aqui!")
      )
      .addMediaGalleryComponents(
          new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(UI_THEME.BANNER_CART))
      )
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
      .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
              `Olá **${user.username}**, bem-vindo(a) ao seu carrinho de compras.\n` +
              `Clique em "Continuar" para prosseguir.\n\n` +
              `⚠️ **O carrinho fechará automaticamente dentro de 30 minutos.**`
          )
      )
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`• **ID:** ${user.id}\n• Guarde esse ID com cuidado!`))
      .addActionRowComponents(
          new ActionRowBuilder().addComponents(
              new ButtonBuilder().setStyle(ButtonStyle.Success).setLabel("Continuar").setCustomId("btn_continuar"),
              new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel("Encerrar").setCustomId("btn_cancelar_compra"),
              new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Ajuda").setCustomId("btn_ajuda"),
              new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel("🧮 Calculadora").setCustomId("btn_calculadora")
          )
      );
}

function buildConfirmUserContainer({ usuarioDigitado, robloxUserId, robloxUsername, avatarURL, gameName }) {
    const safeAvatar = avatarURL || UI_THEME.LOGO;
    const safeUser = robloxUsername || "Desconhecido";

    const container = new ContainerBuilder()
      .setAccentColor(UI_THEME.GREEN)
      .addSectionComponents(
        new SectionBuilder()
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(safeAvatar))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent("## Confirme seu usuário"))
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**Usuário digitado:** ${usuarioDigitado}\n**Usuário encontrado:** ${safeUser} (ID: ${robloxUserId})`)
      );
  
    if (gameName) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**🎮 Jogo detectado:** ${gameName}`));
    }

    container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Ver Perfil no Roblox").setURL(`https://www.roblox.com/users/${robloxUserId}/profile`)
        )
    );
    
    container
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Success).setLabel("Sim, sou eu").setCustomId("confirmar_usuario_sim"),
          new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel("Não, alterar").setCustomId("confirmar_usuario_nao"),
          new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Início").setCustomId("btn_voltar_inicio")
        )
      );
    return container;
}

function buildGamepassSelectionContainer({ robloxUsername, robloxUserId, avatarURL, gamepassesAVenda, fallbackManual }) {
    const qtd = gamepassesAVenda ? gamepassesAVenda.length : 0;
    const safeAvatar = avatarURL || UI_THEME.LOGO;
  
    const container = new ContainerBuilder()
      .setAccentColor(UI_THEME.GREEN)
      .addSectionComponents(
          new SectionBuilder()
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(safeAvatar))
          .addTextDisplayComponents(
              new TextDisplayBuilder().setContent("## Adicionar gamepass")
          )
      )
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(`Ver Perfil de ${robloxUsername}`).setURL(`https://www.roblox.com/users/${robloxUserId}/profile`)
        )
      )
      .addTextDisplayComponents(
          new TextDisplayBuilder().setContent("**Requisitos:**\n• Place publica e disponível\n• À venda\n• Preço entre **286 e 2858** Robux\n• Preço regional desativado")
      )
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`Foram encontradas **${qtd} gamepasses**.`));
  
    const select = gamepassesAVenda?.length
      ? new StringSelectMenuBuilder().setCustomId("selecionar_gamepass").setPlaceholder("Selecione...").setMinValues(1).setMaxValues(Math.min(5, gamepassesAVenda.length))
          .addOptions(gamepassesAVenda.slice(0, 25).map((gp) => ({
                label: gp.name.slice(0, 100) || "Sem nome",
                description: `Valor: ${gp.price || 0} | Recebe: ${Math.floor((gp.price || 0) * 0.7)}`,
                value: String(gp.gamePassId),
            })))
      : null;
  
    if (select && !fallbackManual) container.addActionRowComponents(new ActionRowBuilder().addComponents(select));

    const rowButtons = new ActionRowBuilder();
    rowButtons.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel("Atualizar").setCustomId("confirmar_usuario_sim"));
    
    if (select && !fallbackManual) rowButtons.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Success).setLabel("Confirmar Seleção").setCustomId("confirmar_gamepasses"));
    
    rowButtons.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Voltar").setCustomId("voltar_confirmacao_usuario"));
  
    if (fallbackManual) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent("❌ Nenhuma gamepass válida encontrada."));
      container.addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel("Inserir Manualmente").setCustomId("enviar_gamepass_manual")));
    }
    container.addActionRowComponents(rowButtons);
    return container;
}

function buildFinalSummaryContainer({ robloxUsername, robloxUserId, avatarURL, selectedGamepasses, couponCode = null, discountAmount = 0 }) {
    const safeAvatar = avatarURL || UI_THEME.LOGO;
    let totalPriceRobux = 0;
    let totalReceber = 0;
    const linhas = selectedGamepasses.map((gp, idx) => {
      const preco = gp.price ?? gp.priceInRobux ?? 0;
      const receber = Math.floor(preco * 0.7);
      totalPriceRobux += preco;
      totalReceber += receber;
      return `**${idx + 1}. ${gp.name}**\n— Valor: ${preco} | Recebe: ${receber}`;
    });
    
    const valorBase = totalReceber * ECONOMY.PRICE_PER_ROBUX;
    const valorFinal = valorBase - discountAmount;
    const valorReais = valorFinal > 0 ? valorFinal : 0;

    const container = new ContainerBuilder().setAccentColor(UI_THEME.GREEN)
      .addSectionComponents(new SectionBuilder().setThumbnailAccessory(new ThumbnailBuilder().setURL(safeAvatar)).addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Detalhes finais\nUsuário: **${robloxUsername}**`)))
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Ver Perfil no Roblox").setURL(`https://www.roblox.com/users/${robloxUserId}/profile`)
        )
      )
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(linhas.join("\n\n")))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
    
    if (couponCode) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`🎫 **Cupom Aplicado:** ${couponCode}\n💰 **Desconto:** ${formatBRL(discountAmount)}`));
    }
    
    container
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`💰 **Total em Robux:** ${totalPriceRobux}\n💵 **Valor a Receber:** ${totalReceber} Robux\n💳 **Valor a Pagar:** ${formatBRL(valorReais)}`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent("✅ **Pronto!** Clique em Finalizar para gerar pagamento."))
      .addActionRowComponents(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("⬅ Voltar").setCustomId("voltar_para_selecao_gamepasses"),
          new ButtonBuilder().setStyle(ButtonStyle.Success).setLabel("💳 Finalizar Compra").setCustomId("finalizar_compra"),
          new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel("Cancelar").setCustomId("btn_cancelar_compra")
      ));
    
    return container;
}

function buildManualGamepassContainer({ robloxUsername, avatarURL, gamepass }) {
    const safeAvatar = avatarURL || UI_THEME.LOGO;
    const receber = Math.floor((gamepass.priceInRobux || 0) * 0.7);
    return new ContainerBuilder().setAccentColor(UI_THEME.GREEN)
      .addSectionComponents(new SectionBuilder().setThumbnailAccessory(new ThumbnailBuilder().setURL(safeAvatar)).addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Gamepass Manual\n**Usuário:** ${robloxUsername}`)))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Nome:** ${gamepass.name}\n**ID:** ${gamepass.id}\n**Preço:** ${gamepass.priceInRobux}\n**Receber:** ${receber}`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`🔗 [Abrir no Roblox](https://www.roblox.com/game-pass/${gamepass.id}/-)`))
      .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("⬅ Voltar").setCustomId("voltar_para_selecao_gamepasses"), new ButtonBuilder().setStyle(ButtonStyle.Success).setLabel("✅ Confirmar").setCustomId("confirmar_gamepasses"), new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel("Cancelar").setCustomId("btn_cancelar_compra")));
}

function buildGamepassMismatchContainer({ robloxUsername, avatarURL, gamepass, creatorName }) {
    const safeAvatar = avatarURL || UI_THEME.LOGO;
    return new ContainerBuilder().setAccentColor(UI_THEME.ORANGE)
      .addSectionComponents(new SectionBuilder().setThumbnailAccessory(new ThumbnailBuilder().setURL(safeAvatar)).addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ⚠️ Dono Diferente`)))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`A gamepass pertence a **${creatorName}**.\nUsuário confirmado: **${robloxUsername}**.\n\n**Gamepass:** ${gamepass.name}`))
      .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("⬅ Voltar").setCustomId("voltar_para_selecao_gamepasses"), new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel("Forçar confirmar").setCustomId("confirmar_gamepasses_force"), new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Cancelar").setCustomId("btn_cancelar_compra")));
}

function buildCancelConfirmContainer() {
  return new ContainerBuilder().setAccentColor(UI_THEME.RED).addTextDisplayComponents(new TextDisplayBuilder().setContent("## Cancelar Compra?\n⚠️ **Tem certeza?** A thread será encerrada."))
    .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel("Sim, cancelar").setCustomId("btn_cancelar_confirmado"), new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Não, voltar").setCustomId("btn_cancelar_voltar")));
}

function buildCanceledContainer() {
  return new ContainerBuilder().setAccentColor(UI_THEME.GRAY).addTextDisplayComponents(new TextDisplayBuilder().setContent("## ❌ Compra Cancelada\nVocê pode iniciar uma nova compra a qualquer momento."));
}

function buildErrorContainer(msg) {
    return new ContainerBuilder().setAccentColor(UI_THEME.RED).addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ❌ Erro\n${msg}`))
      .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Primary).setLabel("Tentar Novamente").setCustomId("btn_continuar")));
}

function buildPaymentContainer(paymentUrl, totalAmount) {
    return new ContainerBuilder().setAccentColor(UI_THEME.GREEN)
      .addTextDisplayComponents(new TextDisplayBuilder().setContent("## 💰 Pagamento\nClique no botão abaixo para pagar:"))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Valor:** ${formatBRL(totalAmount)}\n\nApós o pagamento, sua compra será processada automaticamente.`))
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Pagar com Mercado Pago").setURL(paymentUrl),
            new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Voltar").setCustomId("voltar_resumo_compra")
        )
      );
}

// ================================================================
// 🔵 CLIENTE DISCORD
// ================================================================
client.once(Events.ClientReady, async () => {
  console.log(`Logado como ${client.user.tag}`);
  
  // Inicializar banco de dados
  await initDatabase();
  
  const commands = [
    { name: "sendcomponents", description: "Envia o painel de compra de Robux" },
    { name: "abrirloja", description: "Abre a loja e permite carrinhos" },
    { name: "fecharloja", description: "Fecha a loja e bloqueia carrinhos" },
    { name: "calculadora", description: "Calcula preço baseado em Robux desejado" },
    { name: "paineladm", description: "Painel administrativo de estatísticas" },
    { name: "adicionarcupom", description: "Adiciona um novo cupom de desconto" },
    { name: "gerenciarcargos", description: "Gerencia permissões de cargos" },
    { name: "minhascompras", description: "Veja suas compras anteriores" }
  ];
  
  try {
      console.log("Registrando comandos slash...");
      await client.application.commands.set(commands);
      console.log("✅ Comandos registrados!");
  } catch (error) { console.error("Erro ao registrar comandos:", error); }
});

// SLASH COMMANDS
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "sendcomponents") {
      const components = buildMainPanelComponents();
      // SALVA O LOCAL DO PAINEL PARA EDITAR DEPOIS
      const reply = await interaction.reply({ flags: MessageFlags.IsComponentsV2, components, fetchReply: true });
      MAIN_PANEL_DATA = { channelId: reply.channelId, messageId: reply.id };
      console.log(`Painel registrado em Canal: ${reply.channelId}, Msg: ${reply.id}`);
  }

  if (interaction.commandName === "abrirloja") {
      IS_SHOP_OPEN = true;
      
      // Atualiza painel existente
      if (MAIN_PANEL_DATA && MAIN_PANEL_DATA.channelId) {
          try {
              const channel = await client.channels.fetch(MAIN_PANEL_DATA.channelId);
              const message = await channel.messages.fetch(MAIN_PANEL_DATA.messageId);
              await message.edit({ components: buildMainPanelComponents() });
              await interaction.reply({ content: "✅ Loja aberta e painel atualizado.", flags: MessageFlags.Ephemeral });
          } catch (e) {
              console.error("Erro ao atualizar:", e);
              await interaction.reply({ content: "✅ Loja aberta (não consegui atualizar o painel automaticamente).", flags: MessageFlags.Ephemeral });
          }
      } else {
          await interaction.reply({ content: "✅ Loja aberta. (Painel não encontrado para atualizar)", flags: MessageFlags.Ephemeral });
      }
  }

  if (interaction.commandName === "fecharloja") {
      IS_SHOP_OPEN = false;
      
      if (MAIN_PANEL_DATA && MAIN_PANEL_DATA.channelId) {
          try {
              const channel = await client.channels.fetch(MAIN_PANEL_DATA.channelId);
              const message = await channel.messages.fetch(MAIN_PANEL_DATA.messageId);
              await message.edit({ components: buildMainPanelComponents() });
              await interaction.reply({ content: "⛔ Loja fechada e painel atualizado.", flags: MessageFlags.Ephemeral });
          } catch (e) {
              console.error("Erro ao atualizar:", e);
              await interaction.reply({ content: "⛔ Loja fechada (erro ao atualizar painel).", flags: MessageFlags.Ephemeral });
          }
      } else {
          await interaction.reply({ content: "⛔ Loja fechada.", flags: MessageFlags.Ephemeral });
      }
  }

  if (interaction.commandName === "calculadora") {
    const modal = new ModalBuilder()
        .setCustomId("modal_calculadora")
        .setTitle("Calculadora de Preços");
    
    const robuxInput = new TextInputBuilder()
        .setCustomId("robux_amount")
        .setLabel("Quantidade de Robux desejada")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
    
    const cupomInput = new TextInputBuilder()
        .setCustomId("cupom_code")
        .setLabel("Código do cupom (opcional)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);
    
    modal.addComponents(
        new ActionRowBuilder().addComponents(robuxInput),
        new ActionRowBuilder().addComponents(cupomInput)
    );
    
    await interaction.showModal(modal);
  }

  if (interaction.commandName === "paineladm") {
    // Verificar permissões
    const hasPermission = await checkAdminPermissions(interaction.member, 'can_view_stats');
    
    if (!hasPermission) {
        return interaction.reply({ 
            content: "⛔ Você não tem permissão para acessar o painel administrativo.", 
            flags: MessageFlags.Ephemeral 
        });
    }
    
    // Mostrar painel administrativo
    await showAdminPanel(interaction);
  }

  if (interaction.commandName === "adicionarcupom") {
    const hasPermission = await checkAdminPermissions(interaction.member, 'can_manage_coupons');
    
    if (!hasPermission) {
        return interaction.reply({ 
            content: "⛔ Você não tem permissão para gerenciar cupons.", 
            flags: MessageFlags.Ephemeral 
        });
    }
    
    const modal = new ModalBuilder()
        .setCustomId("modal_adicionar_cupom")
        .setTitle("Adicionar Cupom");
    
    const codeInput = new TextInputBuilder()
        .setCustomId("cupom_code")
        .setLabel("Código do Cupom")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
    
    const typeInput = new TextInputBuilder()
        .setCustomId("discount_type")
        .setLabel("Tipo (percentage ou fixed)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
    
    const valueInput = new TextInputBuilder()
        .setCustomId("discount_value")
        .setLabel("Valor do desconto")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
    
    const maxUsesInput = new TextInputBuilder()
        .setCustomId("max_uses")
        .setLabel("Usos máximos (deixe vazio para ilimitado)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);
    
    const validUntilInput = new TextInputBuilder()
        .setCustomId("valid_until")
        .setLabel("Válido até (YYYY-MM-DD, opcional)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);
    
    modal.addComponents(
        new ActionRowBuilder().addComponents(codeInput),
        new ActionRowBuilder().addComponents(typeInput),
        new ActionRowBuilder().addComponents(valueInput),
        new ActionRowBuilder().addComponents(maxUsesInput),
        new ActionRowBuilder().addComponents(validUntilInput)
    );
    
    await interaction.showModal(modal);
  }

  if (interaction.commandName === "gerenciarcargos") {
    const hasPermission = await checkAdminPermissions(interaction.member, 'can_manage_roles');
    
    if (!hasPermission) {
        return interaction.reply({ 
            content: "⛔ Você não tem permissão para gerenciar cargos.", 
            flags: MessageFlags.Ephemeral 
        });
    }
    
    await showRoleManagementPanel(interaction);
  }

  if (interaction.commandName === "minhascompras") {
    await showUserPurchases(interaction);
  }
});

// FUNÇÕES AUXILIARES PARA PAINEL ADMIN
async function showAdminPanel(interaction) {
    const canViewAll = await checkAdminPermissions(interaction.member, 'can_view_all_stats');
    
    // Obter estatísticas do mês atual
    const currentMonth = new Date().toISOString().slice(0, 7);
    let stats;
    
    if (canViewAll) {
        stats = await getAllStats(currentMonth);
    } else {
        // Mostrar apenas as próprias estatísticas
        stats = await getDatabase();
        const userStat = await stats.get(`
            SELECT 
                SUM(total_purchases) as total_purchases,
                SUM(total_spent) as total_spent,
                SUM(commission_earned) as total_commission
            FROM sales_stats 
            WHERE discord_id = ? AND month_year = ?
        `, [interaction.user.id, currentMonth]);
        
        stats = userStat ? [{
            discord_id: interaction.user.id,
            total_purchases: userStat.total_purchases || 0,
            total_spent: userStat.total_spent || 0,
            total_commission: userStat.total_commission || 0
        }] : [];
    }
    
    // Calcular totais
    let totalVendas = 0;
    let totalValor = 0;
    let totalComissao = 0;
    
    stats.forEach(stat => {
        totalVendas += stat.total_purchases || 0;
        totalValor += stat.total_spent || 0;
        totalComissao += stat.total_commission || 0;
    });
    
    const container = new ContainerBuilder()
        .setAccentColor(UI_THEME.GREEN)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`## 📊 Painel Administrativo\n**Mês:** ${currentMonth}`)
        )
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `**📈 Estatísticas do Mês:**\n` +
                `• Total de Vendas: ${totalVendas}\n` +
                `• Valor Total: R$ ${totalValor.toFixed(2)}\n` +
                `• Comissão Total (15%): R$ ${totalComissao.toFixed(2)}\n` +
                `• Clientes Ativos: ${stats.length}`
            )
        );
    
    // Adicionar estatísticas por usuário se tiver permissão
    if (canViewAll && stats.length > 0) {
        let userStatsText = `\n**👥 Top Clientes:**\n`;
        stats.slice(0, 10).forEach((stat, index) => {
            userStatsText += `**${index + 1}.** <@${stat.discord_id}> - R$ ${(stat.total_spent || 0).toFixed(2)} (${stat.total_purchases || 0} compras)\n`;
        });
        
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(userStatsText)
        );
    }
    
    // Botões de ação
    const row1 = new ActionRowBuilder();
    
    if (canViewAll) {
        row1.addComponents(
            new ButtonBuilder()
                .setStyle(ButtonStyle.Primary)
                .setLabel("📋 Ver Todos")
                .setCustomId("admin_view_all"),
            new ButtonBuilder()
                .setStyle(ButtonStyle.Secondary)
                .setLabel("📅 Mês Anterior")
                .setCustomId("admin_prev_month"),
            new ButtonBuilder()
                .setStyle(ButtonStyle.Secondary)
                .setLabel("📅 Próximo Mês")
                .setCustomId("admin_next_month")
        );
    }
    
    const row2 = new ActionRowBuilder();
    
    if (await checkAdminPermissions(interaction.member, 'can_manage_coupons')) {
        row2.addComponents(
            new ButtonBuilder()
                .setStyle(ButtonStyle.Success)
                .setLabel("🎫 Gerenciar Cupons")
                .setCustomId("admin_manage_coupons")
        );
    }
    
    if (await checkAdminPermissions(interaction.member, 'can_manage_roles')) {
        row2.addComponents(
            new ButtonBuilder()
                .setStyle(ButtonStyle.Danger)
                .setLabel("👑 Gerenciar Cargos")
                .setCustomId("admin_manage_roles")
        );
    }
    
    if (row1.components.length > 0) container.addActionRowComponents(row1);
    if (row2.components.length > 0) container.addActionRowComponents(row2);
    
    await interaction.reply({ 
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        components: [container] 
    });
}

async function showRoleManagementPanel(interaction) {
    const roles = await getAllRolePermissions();
    
    const container = new ContainerBuilder()
        .setAccentColor(UI_THEME.BLUE)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("## 👑 Gerenciamento de Cargos")
        );
    
    if (roles.length === 0) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent("Nenhum cargo configurado.")
        );
    } else {
        let rolesText = "";
        roles.forEach(role => {
            rolesText += `**${role.role_name}** (<@&${role.role_id}>)\n`;
            rolesText += `• Ver Estatísticas: ${role.can_view_stats ? '✅' : '❌'}\n`;
            rolesText += `• Ver Todas Estatísticas: ${role.can_view_all_stats ? '✅' : '❌'}\n`;
            rolesText += `• Gerenciar Cupons: ${role.can_manage_coupons ? '✅' : '❌'}\n`;
            rolesText += `• Gerenciar Cargos: ${role.can_manage_roles ? '✅' : '❌'}\n\n`;
        });
        
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(rolesText)
        );
    }
    
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setStyle(ButtonStyle.Success)
            .setLabel("➕ Adicionar Cargo")
            .setCustomId("role_add"),
        new ButtonBuilder()
            .setStyle(ButtonStyle.Primary)
            .setLabel("✏️ Editar Cargo")
            .setCustomId("role_edit"),
        new ButtonBuilder()
            .setStyle(ButtonStyle.Danger)
            .setLabel("🗑️ Remover Cargo")
            .setCustomId("role_remove")
    );
    
    container.addActionRowComponents(row);
    
    await interaction.reply({ 
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        components: [container] 
    });
}

async function showUserPurchases(interaction) {
    const db = await getDatabase();
    const purchases = await db.all(`
        SELECT * FROM purchases 
        WHERE discord_id = ? 
        ORDER BY created_at DESC 
        LIMIT 10
    `, [interaction.user.id]);
    
    if (purchases.length === 0) {
        return interaction.reply({ 
            content: "📭 Você não possui compras registradas.", 
            flags: MessageFlags.Ephemeral 
        });
    }
    
    let purchasesText = `## 🛍️ Suas Compras\n\n`;
    
    purchases.forEach((purchase, index) => {
        const date = new Date(purchase.created_at).toLocaleDateString('pt-BR');
        purchasesText += `**${index + 1}. Compra #${purchase.id}**\n`;
        purchasesText += `• Data: ${date}\n`;
        purchasesText += `• Status: ${getStatusEmoji(purchase.status)} ${purchase.status}\n`;
        purchasesText += `• Robux: ${purchase.total_robux}\n`;
        purchasesText += `• Valor: R$ ${purchase.net_value?.toFixed(2) || '0.00'}\n`;
        if (purchase.coupon_code) {
            purchasesText += `• Cupom: ${purchase.coupon_code}\n`;
        }
        purchasesText += `\n`;
    });
    
    const container = new ContainerBuilder()
        .setAccentColor(UI_THEME.BLUE)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(purchasesText)
        );
    
    await interaction.reply({ 
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        components: [container] 
    });
}

function getStatusEmoji(status) {
    switch(status) {
        case 'pending': return '⏳';
        case 'paid': return '✅';
        case 'approved': return '✅';
        case 'cancelled': return '❌';
        default: return '❓';
    }
}

// INTERAÇÕES DE BOTÃO
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId === "btn_ajuda") {
      await interaction.reply({ content: "🔔 Um atendente foi notificado.", flags: MessageFlags.Ephemeral });
      return;
  }

  if (interaction.customId === "btn_calculadora") {
    const modal = new ModalBuilder()
        .setCustomId("modal_calculadora_thread")
        .setTitle("Calculadora de Preços");
    
    const robuxInput = new TextInputBuilder()
        .setCustomId("robux_amount")
        .setLabel("Quantidade de Robux desejada")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
    
    const cupomInput = new TextInputBuilder()
        .setCustomId("cupom_code")
        .setLabel("Código do cupom (opcional)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);
    
    modal.addComponents(
        new ActionRowBuilder().addComponents(robuxInput),
        new ActionRowBuilder().addComponents(cupomInput)
    );
    
    await interaction.showModal(modal);
    return;
  }

  if (interaction.customId === "criar_thread_privada") {
    if (!IS_SHOP_OPEN) return interaction.reply({ content: "⛔ **A loja está fechada no momento.**", flags: MessageFlags.Ephemeral });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
        const thread = await interaction.channel.threads.create({ name: `🛒 Compra - ${interaction.user.username}`, type: ChannelType.PrivateThread, invitable: false });
        await thread.members.add(interaction.user.id);
        await thread.send(`Olá <@${interaction.user.id}>!`);
        const container = buildCartWelcomeContainer(interaction.user);
        const msg = await thread.send({ flags: MessageFlags.IsComponentsV2, components: [ container ] });
        const current = userPurchaseData.get(interaction.user.id) || {};
        userPurchaseData.set(interaction.user.id, { ...current, lastMessageId: msg.id, lastChannelId: msg.channel.id, threadId: thread.id });
        scheduleThreadAutoDelete(interaction.user.id, thread);
        await interaction.editReply({ content: `✅ Criei sua thread: ${thread.toString()}` });
    } catch (e) {
        console.error("Erro criar thread:", e);
        await interaction.editReply({ content: "Erro ao criar thread." });
    }
    return;
  }

  if (interaction.customId === "btn_continuar" || interaction.customId === "confirmar_usuario_nao") return openPurchaseForm(interaction);

  if (interaction.customId === "btn_voltar_inicio") {
      const data = userPurchaseData.get(interaction.user.id);
      if(!data) return interaction.reply({content: "Erro de sessão.", flags: MessageFlags.Ephemeral});
      const container = buildCartWelcomeContainer(interaction.user);
      try {
        const ch = await client.channels.fetch(data.lastChannelId);
        const msg = await ch.messages.fetch(data.lastMessageId);
        await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
        await interaction.deferUpdate();
      } catch(e) {}
      return;
  }

  if (interaction.customId === "confirmar_usuario_sim") {
    await interaction.deferUpdate();
    const data = userPurchaseData.get(interaction.user.id);
    if (!data || !data.robloxUserId) return; 
    const { robloxUserId, avatarURL, robloxUsername, lastMessageId, lastChannelId } = data;
    const gamepasses = await getUserGamepasses(robloxUserId);
    let gamepassesAVenda = [];
    let fallbackManual = false;
    if (gamepasses && gamepasses.length > 0) {
      gamepassesAVenda = gamepasses.filter((gp) => gp.isForSale === true);
      if (!gamepassesAVenda.length) fallbackManual = true;
    } else { fallbackManual = true; }
    data.gamepassesAVenda = gamepassesAVenda;
    const containerBuilder = buildGamepassSelectionContainer({ robloxUsername, robloxUserId, avatarURL, gamepassesAVenda, fallbackManual });
    data.lastSelectionContainer = containerBuilder;
    data.lastContainer = containerBuilder;
    userPurchaseData.set(interaction.user.id, data);
    try {
      if (lastMessageId && lastChannelId) {
        const channel = await client.channels.fetch(lastChannelId);
        const message = await channel.messages.fetch(lastMessageId);
        await message.edit({ flags: MessageFlags.IsComponentsV2, components: [containerBuilder] });
      }
    } catch (e) { console.error(e); }
    return;
  }

  if (interaction.customId === "voltar_confirmacao_usuario") {
    const data = userPurchaseData.get(interaction.user.id);
    if (!data) return;
    const container = buildConfirmUserContainer({ usuarioDigitado: data.usuarioDigitado, robloxUserId: data.robloxUserId, robloxUsername: data.robloxUsername, avatarURL: data.avatarURL, gameName: data.gameName });
    data.lastContainer = container; 
    userPurchaseData.set(interaction.user.id, data);
    try {
        const ch = await client.channels.fetch(data.lastChannelId);
        const msg = await ch.messages.fetch(data.lastMessageId);
        await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
        await interaction.deferUpdate();
    } catch(e) {}
  }
  
  if (interaction.customId === "btn_cancelar_compra") {
    const data = userPurchaseData.get(interaction.user.id);
    if(!data) return;
    const container = buildCancelConfirmContainer();
    try {
       const channel = await client.channels.fetch(data.lastChannelId);
       const message = await channel.messages.fetch(data.lastMessageId);
       await message.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
       await interaction.deferUpdate();
    } catch(e) {}
  }

  if (interaction.customId === "btn_cancelar_voltar") {
      const data = userPurchaseData.get(interaction.user.id);
      if(!data || !data.lastContainer) return;
      try {
        const ch = await client.channels.fetch(data.lastChannelId);
        const msg = await ch.messages.fetch(data.lastMessageId);
        await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [data.lastContainer] });
        await interaction.deferUpdate();
      } catch(e) {}
  }

  if (interaction.customId === "btn_cancelar_confirmado") {
     const data = userPurchaseData.get(interaction.user.id);
     if(!data) return;
     const container = buildCanceledContainer();
     try {
       const channel = await client.channels.fetch(data.lastChannelId);
       const message = await channel.messages.fetch(data.lastMessageId);
       await message.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
       await interaction.deferUpdate();
       clearThreadAutoDelete(interaction.user.id);
       if(data.threadId) {
          setTimeout(async () => {
             const t = await client.channels.fetch(data.threadId).catch(()=>null);
             if(t) t.delete().catch(()=>null);
          }, 5000);
       }
       userPurchaseData.delete(interaction.user.id);
     } catch(e) {}
  }
  
  if (interaction.customId === "voltar_para_selecao_gamepasses") {
      const data = userPurchaseData.get(interaction.user.id);
      if(!data || !data.lastSelectionContainer) return;
      data.lastContainer = data.lastSelectionContainer;
      userPurchaseData.set(interaction.user.id, data);
      try {
        const ch = await client.channels.fetch(data.lastChannelId);
        const msg = await ch.messages.fetch(data.lastMessageId);
        await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [data.lastSelectionContainer] });
        await interaction.deferUpdate();
      } catch(e) {}
  }

  if (interaction.customId === "enviar_gamepass_manual") {
      const modal = new ModalBuilder().setCustomId("modal_gamepass_manual").setTitle("Informar Manualmente");
      const input = new TextInputBuilder().setCustomId("gamepassManual").setLabel("ID da Gamepass").setStyle(TextInputStyle.Short).setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      await interaction.showModal(modal);
  }

  if (interaction.customId === "confirmar_gamepasses" || interaction.customId === "confirmar_gamepasses_force") {
      const data = userPurchaseData.get(interaction.user.id);
      if(!data || !data.selectedGamepasses?.length) return interaction.reply({content: "⚠️ Selecione pelo menos uma gamepass.", flags: MessageFlags.Ephemeral});
      const pagamento = await criarPagamento(
        25, // valor
        "Compra de Robux"
      );
      await criarPedido({
  discordId: interaction.user.id,
  pagamentoId: pagamento.id,
  valor: 25
});

      await interaction.reply({
        content: `💸 **Pague o Pix abaixo:**\n\n${pagamento.qrCode}`

});
      // Verificar se há cupom aplicado
      let coupon = null;
      let discountAmount = 0;
      
      if (data.couponCode) {
          coupon = await getCoupon(data.couponCode);
          if (coupon) {
              // Calcular valor total para aplicar desconto
              let totalRobux = 0;
              data.selectedGamepasses.forEach(gp => {
                  totalRobux += gp.price || gp.priceInRobux || 0;
              });
              
              const totalReceber = Math.floor(totalRobux * 0.7);
              const valorBase = totalReceber * ECONOMY.PRICE_PER_ROBUX;
              
              if (coupon.discount_type === 'percentage') {
                  discountAmount = valorBase * (coupon.discount_value / 100);
              } else if (coupon.discount_type === 'fixed') {
                  discountAmount = coupon.discount_value;
              }
              
              // Usar o cupom
              await useCoupon(data.couponCode);
          }
      }
      
      const container = buildFinalSummaryContainer({ 
          robloxUsername: data.robloxUsername, 
          robloxUserId: data.robloxUserId, 
          avatarURL: data.avatarURL, 
          selectedGamepasses: data.selectedGamepasses,
          couponCode: data.couponCode,
          discountAmount: discountAmount
      });
      data.lastContainer = container;
      data.discountAmount = discountAmount;
      userPurchaseData.set(interaction.user.id, data);
      
      try {
        const ch = await client.channels.fetch(data.lastChannelId);
        const msg = await ch.messages.fetch(data.lastMessageId);
        await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
        await interaction.deferUpdate();
      } catch(e) {}
  }

  if (interaction.customId === "finalizar_compra") {
      const data = userPurchaseData.get(interaction.user.id);
      if(!data || !data.selectedGamepasses?.length) return interaction.reply({content: "⚠️ Erro ao processar compra.", flags: MessageFlags.Ephemeral});
      
      await interaction.deferUpdate();
      
      // Calcular valores totais
      let totalRobux = 0;
      let totalReceber = 0;
      const gamepassIds = [];
      
      data.selectedGamepasses.forEach(gp => {
          const preco = gp.price || gp.priceInRobux || 0;
          totalRobux += preco;
          totalReceber += Math.floor(preco * 0.7);
          gamepassIds.push(gp.gamePassId || gp.id);
      });
      
      const valorBase = totalReceber * ECONOMY.PRICE_PER_ROBUX;
      const valorFinal = valorBase - (data.discountAmount || 0);
      
      // Salvar compra no banco de dados
      const purchaseData = {
          userId: data.robloxUserId,
          discordId: interaction.user.id,
          robloxUsername: data.robloxUsername,
          robloxId: data.robloxUserId,
          gamepassIds: gamepassIds,
          totalRobux: totalRobux,
          totalBRL: valorBase,
          status: 'pending',
          couponCode: data.couponCode || null,
          discountAmount: data.discountAmount || 0,
          netValue: valorFinal > 0 ? valorFinal : 0
      };
      
      const purchaseId = await savePurchase(purchaseData);
      
      // Criar pagamento no Mercado Pago
      if (MERCADO_PAGO.ACCESS_TOKEN) {
          const payment = await createMercadoPagoPayment({
              ...purchaseData,
              finalPrice: valorFinal
          }, interaction.user.id, data.threadId, purchaseId);
          
          if (payment && payment.init_point) {
              const container = buildPaymentContainer(payment.init_point, valorFinal);
              data.lastContainer = container;
              userPurchaseData.set(interaction.user.id, data);
              
              try {
                  const ch = await client.channels.fetch(data.lastChannelId);
                  const msg = await ch.messages.fetch(data.lastMessageId);
                  await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
                  
                  // Mover thread para categoria de pendentes
                  await moveThreadToCategory(data.threadId, CATEGORIES.PENDING);
              } catch(e) {
                  console.error('Erro ao mostrar pagamento:', e);
              }
          } else {
              const container = new ContainerBuilder()
                  .setAccentColor(UI_THEME.RED)
                  .addTextDisplayComponents(
                      new TextDisplayBuilder().setContent("## ❌ Erro no Pagamento\nNão foi possível criar o pagamento. Entre em contato com o suporte.")
                  );
              
              try {
                  const ch = await client.channels.fetch(data.lastChannelId);
                  const msg = await ch.messages.fetch(data.lastMessageId);
                  await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
              } catch(e) {}
          }
      } else {
          // Se não tiver Mercado Pago configurado
          const container = new ContainerBuilder()
              .setAccentColor(UI_THEME.ORANGE)
              .addTextDisplayComponents(
                  new TextDisplayBuilder().setContent(`## 📝 Compra Registrada\n**ID da Compra:** ${purchaseId}\n\nEntre em contato com um administrador para finalizar o pagamento.`)
              );
          
          try {
              const ch = await client.channels.fetch(data.lastChannelId);
              const msg = await ch.messages.fetch(data.lastMessageId);
              await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
          } catch(e) {}
      }
  }

  if (interaction.customId === "voltar_resumo_compra") {
      const data = userPurchaseData.get(interaction.user.id);
      if(!data) return;
      
      const container = buildFinalSummaryContainer({ 
          robloxUsername: data.robloxUsername, 
          robloxUserId: data.robloxUserId, 
          avatarURL: data.avatarURL, 
          selectedGamepasses: data.selectedGamepasses,
          couponCode: data.couponCode,
          discountAmount: data.discountAmount
      });
      
      data.lastContainer = container;
      userPurchaseData.set(interaction.user.id, data);
      
      try {
        const ch = await client.channels.fetch(data.lastChannelId);
        const msg = await ch.messages.fetch(data.lastMessageId);
        await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
        await interaction.deferUpdate();
      } catch(e) {}
  }

  // Botões do painel administrativo
  if (interaction.customId.startsWith("admin_") || interaction.customId.startsWith("role_")) {
      await handleAdminButtons(interaction);
  }
});

async function handleAdminButtons(interaction) {
    if (interaction.customId === "admin_view_all") {
        const hasPermission = await checkAdminPermissions(interaction.member, 'can_view_all_stats');
        if (!hasPermission) {
            return interaction.reply({ 
                content: "⛔ Você não tem permissão para ver todas as estatísticas.", 
                flags: MessageFlags.Ephemeral 
            });
        }
        
        const currentMonth = new Date().toISOString().slice(0, 7);
        const stats = await getAllStats(currentMonth);
        
        let statsText = `## 📊 Estatísticas Detalhadas - ${currentMonth}\n\n`;
        
        stats.forEach((stat, index) => {
            statsText += `**${index + 1}.** <@${stat.discord_id}>\n`;
            statsText += `• Compras: ${stat.total_purchases || 0}\n`;
            statsText += `• Valor Gasto: R$ ${(stat.total_spent || 0).toFixed(2)}\n`;
            statsText += `• Comissão: R$ ${(stat.total_commission || 0).toFixed(2)}\n\n`;
        });
        
        const container = new ContainerBuilder()
            .setAccentColor(UI_THEME.BLUE)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(statsText)
            );
        
        await interaction.reply({ 
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            components: [container] 
        });
    }
    
    if (interaction.customId === "admin_manage_coupons") {
        const modal = new ModalBuilder()
            .setCustomId("modal_adicionar_cupom")
            .setTitle("Adicionar Cupom");
        
        const codeInput = new TextInputBuilder()
            .setCustomId("cupom_code")
            .setLabel("Código do Cupom")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);
        
        const typeInput = new TextInputBuilder()
            .setCustomId("discount_type")
            .setLabel("Tipo (percentage ou fixed)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);
        
        const valueInput = new TextInputBuilder()
            .setCustomId("discount_value")
            .setLabel("Valor do desconto")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);
        
        const maxUsesInput = new TextInputBuilder()
            .setCustomId("max_uses")
            .setLabel("Usos máximos (deixe vazio para ilimitado)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false);
        
        const validUntilInput = new TextInputBuilder()
            .setCustomId("valid_until")
            .setLabel("Válido até (YYYY-MM-DD, opcional)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false);
        
        modal.addComponents(
            new ActionRowBuilder().addComponents(codeInput),
            new ActionRowBuilder().addComponents(typeInput),
            new ActionRowBuilder().addComponents(valueInput),
            new ActionRowBuilder().addComponents(maxUsesInput),
            new ActionRowBuilder().addComponents(validUntilInput)
        );
        
        await interaction.showModal(modal);
    }
    
    if (interaction.customId === "admin_manage_roles") {
        await showRoleManagementPanel(interaction);
    }
    
    if (interaction.customId === "role_add") {
        const modal = new ModalBuilder()
            .setCustomId("modal_add_role")
            .setTitle("Adicionar Cargo");
        
        const roleIdInput = new TextInputBuilder()
            .setCustomId("role_id")
            .setLabel("ID do Cargo")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);
        
        const roleNameInput = new TextInputBuilder()
            .setCustomId("role_name")
            .setLabel("Nome do Cargo (para exibição)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true);
        
        modal.addComponents(
            new ActionRowBuilder().addComponents(roleIdInput),
            new ActionRowBuilder().addComponents(roleNameInput)
        );
        
        await interaction.showModal(modal);
    }
}

async function openPurchaseForm(interaction) {
  const modal = new ModalBuilder().setCustomId("modal_compra").setTitle("Informações da compra");
  const robloxUser = new TextInputBuilder().setCustomId("robloxUser").setLabel("Usuário Roblox").setPlaceholder("Ex: RobloxPlayer").setRequired(true).setStyle(TextInputStyle.Short);
  
  const cupomInput = new TextInputBuilder()
      .setCustomId("cupom_code")
      .setLabel("Código do cupom (opcional)")
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
  
  modal.addComponents(
      new ActionRowBuilder().addComponents(robloxUser),
      new ActionRowBuilder().addComponents(cupomInput)
  );
  await interaction.showModal(modal);
}

// SUBMIT MODAL - USUÁRIO
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isModalSubmit() && interaction.customId === "modal_compra") {
    await interaction.deferUpdate();
    const usuario = interaction.fields.getTextInputValue("robloxUser");
    const cupomCode = interaction.fields.getTextInputValue("cupom_code");
    const saved = userPurchaseData.get(interaction.user.id);
    const sendError = async (msg) => {
        if (saved?.lastMessageId && saved?.lastChannelId) {
            const ch = await client.channels.fetch(saved.lastChannelId);
            const m = await ch.messages.fetch(saved.lastMessageId);
            await m.edit({ flags: MessageFlags.IsComponentsV2, components: [buildErrorContainer(msg)] });
        }
    };

    const robloxUser = await getRobloxUser(usuario);
    if (!robloxUser) { await sendError(`O usuário **${usuario}** não foi encontrado.`); return; }

    // Verificar cupom se fornecido
    let coupon = null;
    if (cupomCode) {
        coupon = await getCoupon(cupomCode.toUpperCase());
        if (!coupon) {
            await sendError(`Cupom **${cupomCode}** inválido ou expirado.`);
            return;
        }
    }

    const userGames = await getUserGames(robloxUser.id);
    const gameName = userGames.length > 0 ? userGames[0].name : null;
    const avatarURL = await getRobloxAvatar(robloxUser.id);

    const newData = { ...saved, usuarioDigitado: usuario, robloxUserId: robloxUser.id, robloxUsername: robloxUser.name, avatarURL, gameName, selectedGamepasses: [], lastChannelId: saved.lastChannelId, lastMessageId: saved.lastMessageId, threadId: saved.threadId, couponCode: cupomCode ? cupomCode.toUpperCase() : null };
    userPurchaseData.set(interaction.user.id, newData);

    const containerBuilder = buildConfirmUserContainer({ usuarioDigitado: usuario, robloxUserId: robloxUser.id, robloxUsername: robloxUser.name, avatarURL, gameName });

    if (saved?.lastMessageId && saved?.lastChannelId) {
      try {
        const channel = await client.channels.fetch(saved.lastChannelId);
        const message = await channel.messages.fetch(saved.lastMessageId);
        await message.edit({ flags: MessageFlags.IsComponentsV2, components: [containerBuilder] });
        newData.lastContainer = containerBuilder;
        userPurchaseData.set(interaction.user.id, newData);
      } catch (e) { console.error(e); }
    }
  }

  if (interaction.isModalSubmit() && interaction.customId === "modal_gamepass_manual") {
      await interaction.deferUpdate();
      const data = userPurchaseData.get(interaction.user.id);
      const sendError = async (msg) => {
        if (data?.lastMessageId) {
            const ch = await client.channels.fetch(data.lastChannelId);
            const m = await ch.messages.fetch(data.lastMessageId);
            await m.edit({ flags: MessageFlags.IsComponentsV2, components: [buildErrorContainer(msg)] });
        }
      };

      if(!data) return;
      const raw = interaction.fields.getTextInputValue("gamepassManual");
      const idMatch = raw.match(/(\d+)/);
      if(!idMatch) { await sendError("ID inválido fornecido."); return; }
      const info = await getGamepassInfo(idMatch[1]);
      if(!info) { await sendError("Gamepass não encontrada."); return; }
      
      const manualGp = { gamePassId: info.TargetId, name: info.Name, price: info.PriceInRobux, priceInRobux: info.PriceInRobux };
      let container;
      if(info.Creator?.Id && String(info.Creator.Id) !== String(data.robloxUserId)) {
          container = buildGamepassMismatchContainer({ robloxUsername: data.robloxUsername, avatarURL: data.avatarURL, gamepass: manualGp, creatorName: info.Creator.Name });
      } else {
          container = buildManualGamepassContainer({ robloxUsername: data.robloxUsername, avatarURL: data.avatarURL, gamepass: manualGp });
      }
      data.selectedGamepasses = [manualGp];
      data.lastContainer = container;
      userPurchaseData.set(interaction.user.id, data);
      try {
          const ch = await client.channels.fetch(data.lastChannelId);
          const msg = await ch.messages.fetch(data.lastMessageId);
          await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
      } catch(e) {}
  }

  if (interaction.isModalSubmit() && interaction.customId === "modal_calculadora") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    const robuxAmount = parseInt(interaction.fields.getTextInputValue("robux_amount"));
    const cupomCode = interaction.fields.getTextInputValue("cupom_code");
    
    if (isNaN(robuxAmount) || robuxAmount <= 0) {
        return interaction.editReply({ 
            content: "❌ Por favor, insira uma quantidade válida de Robux." 
        });
    }
    
    let coupon = null;
    if (cupomCode) {
        coupon = await getCoupon(cupomCode.toUpperCase());
        if (!coupon) {
            return interaction.editReply({ 
                content: "❌ Cupom inválido ou expirado." 
            });
        }
    }
    
    const calculation = calculatePrice(robuxAmount, coupon);
    
    const response = new ContainerBuilder()
        .setAccentColor(UI_THEME.GREEN)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("## 🧮 Resultado da Calculadora")
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `**Robux Desejados:** ${robuxAmount}\n` +
                `**Valor da Gamepass:** ${calculation.gamepassValue} Robux\n` +
                `**Preço Base:** R$ ${calculation.basePrice.toFixed(2)}\n` +
                `${coupon ? `**Desconto (${coupon.discount_type === 'percentage' ? coupon.discount_value + '%' : 'R$ ' + coupon.discount_value}):** R$ ${calculation.discount.toFixed(2)}\n` : ''}` +
                `**💰 Valor Final:** R$ ${calculation.finalPrice.toFixed(2)}`
            )
        );
    
    await interaction.editReply({ 
        flags: MessageFlags.IsComponentsV2,
        components: [response] 
    });
  }

  if (interaction.isModalSubmit() && interaction.customId === "modal_calculadora_thread") {
    await interaction.deferUpdate();
    
    const robuxAmount = parseInt(interaction.fields.getTextInputValue("robux_amount"));
    const cupomCode = interaction.fields.getTextInputValue("cupom_code");
    const data = userPurchaseData.get(interaction.user.id);
    
    if (isNaN(robuxAmount) || robuxAmount <= 0) {
        if (data?.lastMessageId) {
            const ch = await client.channels.fetch(data.lastChannelId);
            const m = await ch.messages.fetch(data.lastMessageId);
            await m.edit({ flags: MessageFlags.IsComponentsV2, components: [buildErrorContainer("Por favor, insira uma quantidade válida de Robux.")] });
        }
        return;
    }
    
    let coupon = null;
    if (cupomCode) {
        coupon = await getCoupon(cupomCode.toUpperCase());
        if (!coupon) {
            if (data?.lastMessageId) {
                const ch = await client.channels.fetch(data.lastChannelId);
                const m = await ch.messages.fetch(data.lastMessageId);
                await m.edit({ flags: MessageFlags.IsComponentsV2, components: [buildErrorContainer(`Cupom ${cupomCode} inválido ou expirado.`)] });
            }
            return;
        }
    }
    
    const calculation = calculatePrice(robuxAmount, coupon);
    
    const response = new ContainerBuilder()
        .setAccentColor(UI_THEME.GREEN)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("## 🧮 Resultado da Calculadora")
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `**Robux Desejados:** ${robuxAmount}\n` +
                `**Valor da Gamepass:** ${calculation.gamepassValue} Robux\n` +
                `**Preço Base:** R$ ${calculation.basePrice.toFixed(2)}\n` +
                `${coupon ? `**Desconto (${coupon.discount_type === 'percentage' ? coupon.discount_value + '%' : 'R$ ' + coupon.discount_value}):** R$ ${calculation.discount.toFixed(2)}\n` : ''}` +
                `**💰 Valor Final:** R$ ${calculation.finalPrice.toFixed(2)}`
            )
        )
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Voltar").setCustomId("btn_voltar_calculadora")
            )
        );
    
    if (data?.lastMessageId) {
        const ch = await client.channels.fetch(data.lastChannelId);
        const m = await ch.messages.fetch(data.lastMessageId);
        data.lastCalcContainer = response;
        userPurchaseData.set(interaction.user.id, data);
        await m.edit({ flags: MessageFlags.IsComponentsV2, components: [response] });
    }
  }

  if (interaction.isModalSubmit() && interaction.customId === "modal_adicionar_cupom") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    const code = interaction.fields.getTextInputValue("cupom_code").toUpperCase();
    const discountType = interaction.fields.getTextInputValue("discount_type");
    const discountValue = parseFloat(interaction.fields.getTextInputValue("discount_value"));
    const maxUses = interaction.fields.getTextInputValue("max_uses") 
        ? parseInt(interaction.fields.getTextInputValue("max_uses")) 
        : null;
    const validUntil = interaction.fields.getTextInputValue("valid_until") || null;
    
    if (!['percentage', 'fixed'].includes(discountType)) {
        return interaction.editReply({ 
            content: "❌ Tipo de desconto inválido. Use 'percentage' ou 'fixed'." 
        });
    }
    
    if (isNaN(discountValue) || discountValue <= 0) {
        return interaction.editReply({ 
            content: "❌ Valor do desconto inválido." 
        });
    }
    
    if (discountType === 'percentage' && discountValue > 100) {
        return interaction.editReply({ 
            content: "❌ Desconto percentual não pode ser maior que 100%." 
        });
    }
    
    const couponData = {
        code,
        discountType,
        discountValue,
        maxUses,
        validUntil: validUntil ? new Date(validUntil).toISOString() : null
    };
    
    const result = await createCoupon(couponData);
    
    if (result) {
        await interaction.editReply({ 
            content: `✅ Cupom **${code}** criado com sucesso!\n` +
                    `Tipo: ${discountType === 'percentage' ? discountValue + '%' : 'R$ ' + discountValue}\n` +
                    `${maxUses ? `Usos máximos: ${maxUses}` : 'Usos ilimitados'}\n` +
                    `${validUntil ? `Válido até: ${validUntil}` : 'Sem data de validade'}`
        });
    } else {
        await interaction.editReply({ 
            content: "❌ Erro ao criar cupom. Verifique se o código já existe." 
        });
    }
  }

  if (interaction.isModalSubmit() && interaction.customId === "modal_add_role") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    const roleId = interaction.fields.getTextInputValue("role_id");
    const roleName = interaction.fields.getTextInputValue("role_name");
    
    // Verificar se o cargo existe no Discord
    try {
        const role = await interaction.guild.roles.fetch(roleId);
        if (!role) {
            return interaction.editReply({ 
                content: "❌ Cargo não encontrado no servidor." 
            });
        }
        
        // Adicionar com permissões padrão
        const roleData = {
            roleId,
            roleName,
            canViewStats: true,
            canViewAllStats: false,
            canManageCoupons: false,
            canManageRoles: false
        };
        
        const result = await addRolePermission(roleData);
        
        if (result) {
            await interaction.editReply({ 
                content: `✅ Cargo **${roleName}** adicionado com sucesso!\n` +
                        `Permissões padrão: Ver Estatísticas`
            });
        } else {
            await interaction.editReply({ 
                content: "❌ Erro ao adicionar cargo. Verifique se já foi adicionado." 
            });
        }
    } catch (error) {
        console.error('Erro ao buscar cargo:', error);
        await interaction.editReply({ 
            content: "❌ Erro ao buscar cargo. Verifique o ID." 
        });
    }
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (interaction.customId !== "selecionar_gamepass") return;
  const data = userPurchaseData.get(interaction.user.id);
  if (!data) return interaction.reply({ content: "Erro.", flags: MessageFlags.Ephemeral });
  const selecionadas = [];
  for (const value of interaction.values) {
    const found = data.gamepassesAVenda.find((gp) => String(gp.gamePassId) === String(value));
    if (found) selecionadas.push(found);
  }
  data.selectedGamepasses = selecionadas;
  userPurchaseData.set(interaction.user.id, data);
  await interaction.deferUpdate();
});

// Função para processar webhook do Mercado Pago (simplificada)
async function handleMercadoPagoWebhook(paymentData) {
    try {
        console.log('📥 Recebendo webhook Mercado Pago:', paymentData);
        
        if (paymentData.action === 'payment.created' || paymentData.action === 'payment.updated') {
            const paymentId = paymentData.data.id;
            
            // Aqui você precisaria buscar o payment no Mercado Pago para obter mais detalhes
            // Esta é uma implementação simplificada
            
            // Em uma implementação real, você buscaria o pagamento:
            // const payment = await mercadopago.payment.findById(paymentId);
            // const externalRef = JSON.parse(payment.body.external_reference);
            
            // Para este exemplo, assumimos que o external_reference está no paymentData
            if (paymentData.data.external_reference) {
                const externalRef = JSON.parse(paymentData.data.external_reference);
                const { discordUserId, threadId, purchaseId } = externalRef;
                
                // Atualizar status da compra
                await updatePurchaseStatus(purchaseId, paymentData.data.status, paymentId);
                
                // Mover thread para categoria apropriada
                if (paymentData.data.status === 'approved') {
                    await moveThreadToCategory(threadId, CATEGORIES.PAID);
                    
                    // Notificar o usuário
                    try {
                        const user = await client.users.fetch(discordUserId);
                        await user.send(`✅ Seu pagamento foi aprovado! Sua compra está sendo processada.`);
                    } catch (error) {
                        console.error('Erro ao notificar usuário:', error);
                    }
                } else if (paymentData.data.status === 'pending') {
                    await moveThreadToCategory(threadId, CATEGORIES.PENDING);
                }
            }
        }
    } catch (error) {
        console.error('Erro ao processar webhook Mercado Pago:', error);
    }
}

// Inicializar o bot
initDatabase().then(() => {
    client.login(TOKEN).then(() => {
        console.log('🤖 Bot iniciado com sucesso!');
    }).catch(error => {
        console.error('Erro ao fazer login:', error);
    });
});
