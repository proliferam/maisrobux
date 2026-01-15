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
  PermissionFlagsBits,
  EmbedBuilder,
  Colors
} from "discord.js";
import { MercadoPagoConfig, Preference, Payment } from "mercadopago";
import express from "express";
import {
  criarPedido,
  buscarAfiliadoPorCupom,
  buscarAfiliadoPorId,
  atualizarEstatisticasAfiliado,
  criarAfiliado,
  listarAfiliados,
  obterEstatisticas,
  obterEstatisticasPorCargo,
  obterComissoesMensais,
  atualizarComissaoPaga,
  criarCupom,
  buscarCupom,
  registrarUsoCupom,
  buscarPedidosPorDiscordId
} from "./database.js";
import { criarPagamentoPix, criarPreferenciaPix } from "./mercadopago.js";

// ================================================================
// 💳 MERCADO PAGO CONFIG
// ================================================================
const mpConfig = new MercadoPagoConfig({
  accessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN
});

const preferenceClient = new Preference(mpConfig);
const paymentClient = new Payment(mpConfig);

// ================================================================
// 🎨 CONFIGURAÇÕES
// ================================================================
const UI_THEME = {
    RED: 0xED4245,
    YELLOW: 0xFEE75C,
    ORANGE: 0xFFA500,
    GRAY: 0x2B2D31,
    GREEN: 0x57F287,
    BLUE: 0x5865F2,
    LOGO: "https://cdn.discordapp.com/attachments/1418035623503204474/1460882898751193108/Design_sem_nome_1.png?ex=696888b8&is=69673738&hm=b62a6798b415e8b860cb53927b91eba1018a472f681193ab4e54319ee0ddaec6&",
    BANNER_CART: "https://cdn.discordapp.com/attachments/1418035623503204474/1460867069372399781/ChatGPT_Image_13_de_jan._de_2026_23_40_20.png?ex=696879fa&is=6967287a&hm=7acd1824bb377377e64f0269c51ea60df3f56aed9313b28e5109fbb7964bee77&"
};

const ECONOMY = {
    PRICE_PER_ROBUX: 0.048,
    ROBLOX_TAX: 0.7, // 30% de taxa do Roblox
    BASE_PRICE: 40 // 40 reais por 1000 robux
};

let IS_SHOP_OPEN = true; 
let MAIN_PANEL_DATA = {
    channelId: "1424199624822100010", 
    messageId: "1443818839073751162" 
};

const userPurchaseData = new Map();
const pendingPayments = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User],
});

const TOKEN = process.env.DISCORD_TOKEN;
const ROBLOX_SECURITY = process.env.ROBLOSECURITY;
let CSRF_TOKEN = null;

const CHANNEL_AUTO_DELETE_MS = 30 * 60 * 1000;

// ================================================================
// 🧮 CALCULADORA DE PREÇOS
// ================================================================
function calcularPrecoRobux(robuxDesejados, cupom = null) {
  // Cálculo: 40 reais = 1000 robux (cliente recebe 700 devido à taxa)
  const robuxComTaxa = Math.ceil(robuxDesejados / ECONOMY.ROBLOX_TAX); // 1429 para receber 1000
  const precoBase = (robuxComTaxa / 1000) * ECONOMY.BASE_PRICE;
  
  let desconto = 0;
  if (cupom) {
    // Verificar cupom no banco de dados
    const cupomData = buscarCupomNoSistema(cupom);
    if (cupomData) {
      desconto = cupomData.desconto;
    }
  }
  
  const precoFinal = precoBase - (precoBase * (desconto / 100));
  
  return {
    robuxDesejados,
    robuxReceber: Math.floor(robuxComTaxa * ECONOMY.ROBLOX_TAX),
    gamepassValor: robuxComTaxa,
    precoBase: parseFloat(precoBase.toFixed(2)),
    descontoPercentual: desconto,
    valorDesconto: parseFloat((precoBase * (desconto / 100)).toFixed(2)),
    precoFinal: parseFloat(precoFinal.toFixed(2)),
    taxaRoblox: 30,
    precoPorMil: ECONOMY.BASE_PRICE
  };
}

function buscarCupomNoSistema(cupom) {
  // Cupons pré-definidos (em produção, buscar do banco)
  const cupons = {
    "PRIMEIRA": { desconto: 10, tipo: "percentual" },
    "ROBUX10": { desconto: 10, tipo: "percentual" },
    "ROBUX20": { desconto: 20, tipo: "percentual" },
    "VIP15": { desconto: 15, tipo: "percentual" }
  };
  
  return cupons[cupom.toUpperCase()] || null;
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
  } catch (err) { 
    console.error("Erro ao buscar gamepasses:", err);
    return null; 
  }
}

async function getGamepassInfo(gamePassId) {
  try {
    const res = await fetch(`https://apis.roblox.com/game-passes/v1/game-passes/${gamePassId}/product-info`);
    if (!res.ok) return null;
    const data = await res.json();
    return data;
  } catch (err) { return null; }
}

function encontrarGamepassPorValor(gamepasses, valorDesejado) {
  if (!gamepasses || !Array.isArray(gamepasses)) return null;
  
  const exata = gamepasses.find(gp => gp.price === valorDesejado && gp.isForSale === true);
  if (exata) return exata;
  
  const valorMin = Math.max(1, valorDesejado - 50);
  const valorMax = valorDesejado + 50;
  
  const proxima = gamepasses.find(gp => 
    gp.price >= valorMin && 
    gp.price <= valorMax && 
    gp.isForSale === true
  );
  
  return proxima || null;
}

// ================================================================
// 🔵 FUNÇÕES AUXILIARES
// ================================================================
async function createMercadoPagoPayment(purchaseData, discordUserId, robloxUser, cupom = null, afiliado = null) {
  try {
    const externalReference = JSON.stringify({
      discordUserId,
      robloxUser,
      cupom,
      afiliado,
      timestamp: Date.now()
    });

    const paymentData = {
      valor: purchaseData.finalPrice,
      descricao: `Compra de ${purchaseData.robuxReceber} Robux`,
      email: "cliente@discord.com",
      nome: robloxUser,
      externalReference: externalReference
    };

    const pagamento = await criarPagamentoPix(paymentData);
    
    // Salvar no banco de dados
    await criarPedido({
      pagamentoId: pagamento.id,
      discordId: discordUserId,
      discordTag: (await client.users.fetch(discordUserId)).tag,
      robloxUser: robloxUser,
      valor: purchaseData.finalPrice,
      robux: purchaseData.robuxReceber,
      status: "Pendente",
      cupom: cupom,
      afiliado: afiliado?.discordTag,
      afiliadoId: afiliado?.discordId,
      comissaoAfiliado: afiliado ? (purchaseData.finalPrice * (afiliado.comissao / 100)) : 0,
      gamepassValor: purchaseData.gamepassValor
    });

    return pagamento;
  } catch (error) {
    console.error("Erro ao criar pagamento:", error);
    throw error;
  }
}

function scheduleChannelAutoDelete(userId, channel) {
  const timeout = setTimeout(async () => {
    try {
      await channel.send("⏰ Esta compra ficou inativa por muito tempo. O canal será encerrado.");
      setTimeout(async () => {
        await channel.delete().catch(() => {});
      }, 5000);
    } catch (e) {} finally {
      const data = userPurchaseData.get(userId);
      if (data) {
        if (data.channelDeleteTimeout) clearTimeout(data.channelDeleteTimeout);
        userPurchaseData.delete(userId);
      }
    }
  }, CHANNEL_AUTO_DELETE_MS);
  const current = userPurchaseData.get(userId) || {};
  userPurchaseData.set(userId, { ...current, channelId: channel.id, channelDeleteTimeout: timeout });
}

function clearChannelAutoDelete(userId) {
  const data = userPurchaseData.get(userId);
  if (!data) return;
  if (data.channelDeleteTimeout) { clearTimeout(data.channelDeleteTimeout); data.channelDeleteTimeout = null; }
  userPurchaseData.set(userId, data);
}

const formatBRL = (val) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(val);

// ================================================================
// 🎨 UI BUILDERS
// ================================================================

function buildMainPanelComponents() {
    const statusColor = IS_SHOP_OPEN ? UI_THEME.GREEN : UI_THEME.YELLOW;

    const mainContainer = new ContainerBuilder()
        .setAccentColor(statusColor)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("## 🛍️ Painel de Compras\n▎ Primeira vez aqui? Veja as [avaliações](https://discord.gg/seu-link)")
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "\n**📋 Como comprar**\n" +
                "1. Acesse o [tutorial](https://discord.com/channels/1418035622568005754/1446323283342659685)\n" +
                "2. Escolha o tipo de compra abaixo\n" +
                "3. Siga as instruções no canal privado\n\n" +
                
                "**ℹ️ Informações**\n" +
                "• Dúvidas? Contate o [suporte](https://discord.com/channels/1418035622568005754/1446323399944179762)\n" +
                "• Valores e Limites [aqui](https://discord.com/channels/1418035622568005754/1446323238761267333)\n" +
                "• Status da Loja: " + (IS_SHOP_OPEN ? "✅ **ABERTA**" : "⛔ **FECHADA**")
            )
        );

    const selectMenuRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId("tipo_compra_menu")
            .setPlaceholder("Escolha o tipo de compra...")
            .addOptions([
                {
                    label: "💎 Comprar Robux",
                    description: "Compra direta de Robux via PIX",
                    value: "comprar_robux",
                    emoji: "<:1297019782649872404:1460904157539209321>"
                },
                {
                    label: "🎮 Comprar via Gamepass",
                    description: "Em desenvolvimento",
                    value: "comprar_gamepass",
                    emoji: "<:1297270954279567433:1460904184508453026>"
                },
                {
                    label: "🧮 Calculadora de Preços",
                    description: "Calcule quanto vai pagar",
                    value: "calculadora_precos",
                    emoji: "🧮"
                }
            ])
    );

    return [mainContainer, selectMenuRow];
}

function buildCartWelcomeContainer(user) {
    return new ContainerBuilder()
        .setAccentColor(UI_THEME.YELLOW)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("## 🛒 Carrinho de Compras\n▎ Compre seus robux aqui!")
        )
        .addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(UI_THEME.BANNER_CART))
        )
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `Olá **${user.username}**, bem-vindo(a) ao seu carrinho de compras!\n` +
                `Clique em "Continuar" para prosseguir com sua compra.\n\n` +
                `⏰ **Atenção:** O canal será fechado automaticamente após 30 minutos de inatividade.`
            )
        )
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("**📋 Informações da Conta**")
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`• **ID do Discord:** ${user.id}\n• **Usuário:** ${user.username}\n• Guarde essas informações com cuidado!`)
        )
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Success)
                    .setLabel("➡️ Continuar")
                    .setCustomId("btn_continuar"),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Danger)
                    .setLabel("❌ Encerrar")
                    .setCustomId("btn_cancelar_compra"),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Secondary)
                    .setLabel("❓ Ajuda")
                    .setCustomId("btn_ajuda")
            )
        );
}

function buildConfirmUserContainer({ usuarioDigitado, robloxUserId, robloxUsername, avatarURL, gameName, quantidadeRobux }) {
    const safeAvatar = avatarURL || UI_THEME.LOGO;
    const safeUser = robloxUsername || "Desconhecido";

    // Calcular preço
    const calculo = calcularPrecoRobux(parseInt(quantidadeRobux));
    
    const container = new ContainerBuilder()
      .setAccentColor(UI_THEME.YELLOW)
      .addSectionComponents(
        new SectionBuilder()
          .setThumbnailAccessory(new ThumbnailBuilder().setURL(safeAvatar))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent("## ✅ Confirme seu usuário"))
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**👤 Usuário digitado:** ${usuarioDigitado}\n**✅ Usuário encontrado:** ${safeUser} (ID: ${robloxUserId})`)
      );

    if (gameName) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**🎮 Jogo detectado:** ${gameName}`));
    }
    
    if (quantidadeRobux) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `**💰 Robux desejados:** ${quantidadeRobux}\n` +
            `**💎 Robux a receber:** ${calculo.robuxReceber} (após taxa)\n` +
            `**🎮 Valor da Gamepass:** ${calculo.gamepassValor} Robux\n` +
            `**💵 Valor total:** ${formatBRL(calculo.precoFinal)}`
        ));
    }

    container.addActionRowComponents(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("👤 Ver Perfil no Roblox").setURL(`https://www.roblox.com/users/${robloxUserId}/profile`)
        )
    );
    
    container
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Success).setLabel("✅ Sim, sou eu").setCustomId("confirmar_usuario_sim"),
          new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel("✏️ Não, alterar").setCustomId("confirmar_usuario_nao"),
          new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("🏠 Início").setCustomId("btn_voltar_inicio")
        )
      );
    return container;
}

function buildPaymentContainer({ robloxUsername, quantidadeRobux, cupom = null, afiliado = null }) {
    const calculo = calcularPrecoRobux(parseInt(quantidadeRobux), cupom);
    const temCupom = cupom && calculo.descontoPercentual > 0;
    const temAfiliado = afiliado !== null;
    
    const container = new ContainerBuilder()
        .setAccentColor(UI_THEME.GREEN)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("## 💰 Resumo do Pedido")
        )
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `**👤 Cliente:** ${robloxUsername}\n` +
                `**💎 Robux desejados:** ${quantidadeRobux}\n` +
                `**🎮 Valor da Gamepass:** ${calculo.gamepassValor} Robux\n` +
                `**📊 Taxa Roblox:** ${calculo.taxaRoblox}%`
            )
        );
    
    if (temCupom) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `\n**🎫 Cupom aplicado:** ${cupom}\n` +
                `**💰 Desconto:** ${calculo.descontoPercentual}% (${formatBRL(calculo.valorDesconto)})`
            )
        );
    }
    
    if (temAfiliado) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `\n**🤝 Afiliado:** ${afiliado.discordTag}\n` +
                `**📊 Comissão:** ${afiliado.comissao}% (${formatBRL((calculo.precoFinal * afiliado.comissao) / 100)})`
            )
        );
    }
    
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `## 💵 Total a pagar:\n# ${formatBRL(calculo.precoFinal)}`
            )
        )
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "**📝 Informações importantes:**\n" +
                "• O pagamento é processado via PIX\n" +
                "• O QR Code expira em 30 minutos\n" +
                "• Após o pagamento, aguarde a confirmação\n" +
                "• Em caso de problemas, contate o suporte"
            )
        )
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Success)
                    .setLabel("💠 Gerar PIX")
                    .setCustomId("gerar_pix_pagamento"),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Secondary)
                    .setLabel("⬅️ Voltar")
                    .setCustomId("voltar_para_resumo"),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Danger)
                    .setLabel("❌ Cancelar")
                    .setCustomId("btn_cancelar_compra")
            )
        );
    
    return container;
}

function buildPixPaymentContainer(paymentData) {
    return new ContainerBuilder()
        .setAccentColor(UI_THEME.GREEN)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("## 💠 PAGAMENTO PIX")
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `**📋 ID do Pedido:** ${paymentData.id}\n` +
                `**💰 Valor:** ${formatBRL(paymentData.transaction_amount)}\n` +
                `**⏰ Expira em:** 30 minutos\n\n` +
                "**Escaneie o QR Code abaixo ou use o código PIX:**"
            )
        )
        .addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(`data:image/png;base64,${paymentData.qrCodeBase64}`)
            )
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `\`\`\`\n${paymentData.pixCopiaCola}\n\`\`\``
            )
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "**📱 Como pagar:**\n" +
                "1. Abra seu aplicativo bancário\n" +
                "2. Escolha pagar via PIX\n" +
                "3. Escaneie o QR Code ou cole o código\n" +
                "4. Confirme o pagamento"
            )
        )
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Link)
                    .setLabel("📱 Abrir no Celular")
                    .setURL(paymentData.ticketUrl || "#"),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Secondary)
                    .setLabel("🔄 Verificar Pagamento")
                    .setCustomId("verificar_pagamento"),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Danger)
                    .setLabel("❌ Cancelar")
                    .setCustomId("btn_cancelar_compra")
            )
        );
}

function buildAdminPanel() {
    return new ContainerBuilder()
        .setAccentColor(UI_THEME.ORANGE)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("## 👑 PAINEL ADMINISTRATIVO")
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "**📊 Estatísticas**\n" +
                "• Total de vendas\n" +
                "• Valor total arrecadado\n" +
                "• Afiliados ativos\n" +
                "• Comissões pendentes\n\n" +
                
                "**👥 Gerenciamento**\n" +
                "• Adicionar/remover afiliados\n" +
                "• Configurar cargos e comissões\n" +
                "• Ver histórico de vendas\n" +
                "• Gerenciar cupons\n\n" +
                
                "**⚙️ Configurações**\n" +
                "• Abrir/fechar loja\n" +
                "• Configurar preços\n" +
                "• Monitorar pagamentos"
            )
        )
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Primary)
                    .setLabel("📊 Estatísticas")
                    .setCustomId("admin_estatisticas"),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Primary)
                    .setLabel("👥 Afiliados")
                    .setCustomId("admin_afiliados"),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Primary)
                    .setLabel("⚙️ Configurações")
                    .setCustomId("admin_config")
            )
        )
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Success)
                    .setLabel("➕ Novo Afiliado")
                    .setCustomId("admin_novo_afiliado"),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Secondary)
                    .setLabel("🎫 Cupons")
                    .setCustomId("admin_cupons"),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Danger)
                    .setLabel("❌ Fechar")
                    .setCustomId("admin_fechar")
            )
        );
}

function buildEstatisticasPanel(estatisticas) {
    return new ContainerBuilder()
        .setAccentColor(UI_THEME.BLUE)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("## 📊 ESTATÍSTICAS DA LOJA")
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `**📈 Vendas Totais:** ${estatisticas.totalVendas}\n` +
                `**💰 Valor Total:** ${formatBRL(estatisticas.valorTotal)}\n` +
                `**📅 Vendas Este Mês:** ${estatisticas.totalVendasMes}\n` +
                `**💵 Valor Este Mês:** ${formatBRL(estatisticas.valorTotalMes)}\n` +
                `**🎯 Ticket Médio:** ${formatBRL(estatisticas.ticketMedio)}\n\n` +
                
                `**👥 Afiliados Ativos:** ${estatisticas.afiliadosAtivos}\n` +
                `**🤝 Comissões Pendentes:** ${formatBRL(estatisticas.comissoesPendentes || 0)}\n` +
                `**⏱️ Última Atualização:** ${new Date().toLocaleString('pt-BR')}`
            )
        )
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Secondary)
                    .setLabel("🔄 Atualizar")
                    .setCustomId("admin_atualizar_estatisticas"),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Secondary)
                    .setLabel("📋 Detalhes por Cargo")
                    .setCustomId("admin_estatisticas_cargos"),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Secondary)
                    .setLabel("⬅️ Voltar")
                    .setCustomId("admin_voltar")
            )
        );
}

function buildAfiliadosPanel(afiliados) {
    let afiliadosText = "**👥 LISTA DE AFILIADOS**\n\n";
    
    afiliados.forEach((af, index) => {
        afiliadosText += `**${index + 1}. ${af.DiscordTag}**\n`;
        afiliadosText += `   🎖️ Cargo: ${af.Cargo || 'Afiliado'}\n`;
        afiliadosText += `   🎫 Cupom: ${af.Cupom}\n`;
        afiliadosText += `   💰 Comissão: ${af.Comissao}%\n`;
        afiliadosText += `   📊 Vendas: ${af.VendasTotais || 0}\n`;
        afiliadosText += `   💵 Total: ${formatBRL(af.ValorTotal || 0)}\n`;
        afiliadosText += `   💸 Pendente: ${formatBRL(af.ComissaoPendente || 0)}\n`;
        afiliadosText += `   📅 Desde: ${new Date(af.DataCadastro).toLocaleDateString('pt-BR')}\n\n`;
    });
    
    return new ContainerBuilder()
        .setAccentColor(UI_THEME.GREEN)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("## 🤝 GERENCIAR AFILIADOS")
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(afiliadosText)
        )
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Success)
                    .setLabel("➕ Adicionar Afiliado")
                    .setCustomId("admin_novo_afiliado_modal"),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Primary)
                    .setLabel("💰 Pagar Comissões")
                    .setCustomId("admin_pagar_comissoes"),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Secondary)
                    .setLabel("⬅️ Voltar")
                    .setCustomId("admin_voltar")
            )
        );
}

function buildCalculadoraContainer(quantidadeRobux, cupom = null) {
    const calculo = calcularPrecoRobux(quantidadeRobux, cupom);
    
    return new ContainerBuilder()
        .setAccentColor(UI_THEME.BLUE)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("## 🧮 CALCULADORA DE PREÇOS")
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `**💎 Robux desejados:** ${quantidadeRobux}\n` +
                `**🎮 Valor da Gamepass:** ${calculo.gamepassValor} Robux\n` +
                `**📊 Taxa Roblox:** ${calculo.taxaRoblox}%\n` +
                `**💎 Robux a receber:** ${calculo.robuxReceber}\n\n` +
                
                `**💰 Preço base:** ${formatBRL(calculo.precoBase)}\n` +
                `**🎫 Cupom aplicado:** ${cupom || 'Nenhum'}\n` +
                `**💸 Desconto:** ${calculo.descontoPercentual}% (${formatBRL(calculo.valorDesconto)})\n\n` +
                
                `## 💵 **TOTAL:** ${formatBRL(calculo.precoFinal)}`
            )
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "\n**📝 Como funciona:**\n" +
                "• 40 reais = 1000 Robux (você recebe 700)\n" +
                "• Para receber 1000 Robux, a gamepass precisa ser de 1429 Robux\n" +
                "• O Roblox fica com 30% (taxa da plataforma)\n" +
                "• O valor final já inclui todas as taxas"
            )
        )
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Success)
                    .setLabel("🛒 Comprar Agora")
                    .setCustomId("comprar_calculadora"),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Secondary)
                    .setLabel("🔢 Nova Consulta")
                    .setCustomId("nova_consulta_calculadora"),
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Danger)
                    .setLabel("❌ Fechar")
                    .setCustomId("fechar_calculadora")
            )
        );
}

function buildCancelConfirmContainer() {
  return new ContainerBuilder()
    .setAccentColor(UI_THEME.YELLOW)
    .addTextDisplayComponents(
        new TextDisplayBuilder().setContent("## ⚠️ Cancelar Compra?\n**Tem certeza que deseja cancelar?**\n\nO canal será encerrado e todos os dados serão perdidos.")
    )
    .addActionRowComponents(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setStyle(ButtonStyle.Danger)
                .setLabel("✅ Sim, cancelar")
                .setCustomId("btn_cancelar_confirmado"),
            new ButtonBuilder()
                .setStyle(ButtonStyle.Secondary)
                .setLabel("❌ Não, voltar")
                .setCustomId("btn_cancelar_voltar")
        )
    );
}

function buildCanceledContainer() {
  return new ContainerBuilder()
    .setAccentColor(UI_THEME.GRAY)
    .addTextDisplayComponents(
        new TextDisplayBuilder().setContent("## ❌ Compra Cancelada\n\nVocê pode iniciar uma nova compra a qualquer momento através do painel principal.\n\nObrigado por visitar nossa loja!")
    );
}

function buildErrorContainer(msg) {
    return new ContainerBuilder()
        .setAccentColor(UI_THEME.RED)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`## ❌ Erro\n${msg}`)
        )
        .addActionRowComponents(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setStyle(ButtonStyle.Primary)
                    .setLabel("🔄 Tentar Novamente")
                    .setCustomId("btn_continuar")
            )
        );
}

// ================================================================
// 🔵 CLIENTE DISCORD - EVENTOS PRINCIPAIS
// ================================================================
client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot logado como ${client.user.tag}`);
  
  const commands = [
    { name: "sendcomponents", description: "Envia o painel de compra de Robux" },
    { name: "abrirloja", description: "Abre a loja e permite carrinhos" },
    { name: "fecharloja", description: "Fecha a loja e bloqueia carrinhos" },
    { name: "novoafiliado", description: "Cadastra um novo afiliado" },
    { name: "paineladmin", description: "Abre o painel administrativo" },
    { name: "calculadora", description: "Calcula preços de robux" },
    { name: "minhascomissoes", description: "Veja suas comissões (afiliados)" },
    { name: "estatisticas", description: "Estatísticas da loja (admin)" },
    { name: "meuspedidos", description: "Veja seus pedidos" },
    { name: "configurar", description: "Configurações do sistema (admin)" }
  ];
  
  try {
    console.log("📝 Registrando comandos slash...");
    await client.application.commands.set(commands);
    console.log("✅ Comandos registrados com sucesso!");
  } catch (error) {
    console.error("❌ Erro ao registrar comandos:", error);
  }
});

// ================================================================
// 🔵 SLASH COMMANDS
// ================================================================
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // COMANDO: sendcomponents
  if (interaction.commandName === "sendcomponents") {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: "❌ Você precisa ser administrador para usar este comando.",
        flags: MessageFlags.Ephemeral
      });
    }
    
    const components = buildMainPanelComponents();
    const reply = await interaction.reply({ 
      components, 
      flags: MessageFlags.IsComponentsV2, 
      fetchReply: true 
    });
    
    MAIN_PANEL_DATA = { channelId: reply.channelId, messageId: reply.id };
    console.log(`📌 Painel registrado em Canal: ${reply.channelId}, Msg: ${reply.id}`);
  }

  // COMANDO: abrirloja
  if (interaction.commandName === "abrirloja") {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: "❌ Você precisa ser administrador para usar este comando.",
        flags: MessageFlags.Ephemeral
      });
    }
    
    IS_SHOP_OPEN = true;
    
    if (MAIN_PANEL_DATA && MAIN_PANEL_DATA.channelId) {
      try {
        const channel = await client.channels.fetch(MAIN_PANEL_DATA.channelId);
        const message = await channel.messages.fetch(MAIN_PANEL_DATA.messageId);
        const updatedComponents = buildMainPanelComponents();
        await message.edit({ components: updatedComponents });
        await interaction.reply({ content: "✅ Loja aberta e painel atualizado.", flags: MessageFlags.Ephemeral });
      } catch (e) {
        console.error("Erro ao atualizar:", e);
        await interaction.reply({ content: "✅ Loja aberta (não consegui atualizar o painel automaticamente).", flags: MessageFlags.Ephemeral });
      }
    } else {
      await interaction.reply({ content: "✅ Loja aberta. (Painel não encontrado para atualizar)", flags: MessageFlags.Ephemeral });
    }
  }

  // COMANDO: fecharloja
  if (interaction.commandName === "fecharloja") {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: "❌ Você precisa ser administrador para usar este comando.",
        flags: MessageFlags.Ephemeral
      });
    }
    
    IS_SHOP_OPEN = false;
    
    if (MAIN_PANEL_DATA && MAIN_PANEL_DATA.channelId) {
      try {
        const channel = await client.channels.fetch(MAIN_PANEL_DATA.channelId);
        const message = await channel.messages.fetch(MAIN_PANEL_DATA.messageId);
        const updatedComponents = buildMainPanelComponents();
        await message.edit({ components: updatedComponents });
        await interaction.reply({ content: "⛔ Loja fechada e painel atualizado.", flags: MessageFlags.Ephemeral });
      } catch (e) {
        console.error("Erro ao atualizar:", e);
        await interaction.reply({ content: "⛔ Loja fechada (erro ao atualizar painel).", flags: MessageFlags.Ephemeral });
      }
    } else {
      await interaction.reply({ content: "⛔ Loja fechada.", flags: MessageFlags.Ephemeral });
    }
  }

  // COMANDO: novoafiliado
  if (interaction.commandName === "novoafiliado") {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: "❌ Você precisa ser administrador para usar este comando.",
        flags: MessageFlags.Ephemeral
      });
    }
    
    const modal = new ModalBuilder()
      .setCustomId("modal_novo_afiliado")
      .setTitle("Cadastrar Novo Afiliado");
    
    const discordId = new TextInputBuilder()
      .setCustomId("discordId")
      .setLabel("ID do Discord")
      .setPlaceholder("123456789012345678")
      .setRequired(true)
      .setStyle(TextInputStyle.Short);
      
    const cargo = new TextInputBuilder()
      .setCustomId("cargo")
      .setLabel("Cargo (Afiliado, Premium, VIP)")
      .setPlaceholder("Afiliado")
      .setRequired(true)
      .setStyle(TextInputStyle.Short);
      
    const cupom = new TextInputBuilder()
      .setCustomId("cupom")
      .setLabel("Cupom Personalizado")
      .setPlaceholder("EXEMPLO20")
      .setRequired(true)
      .setStyle(TextInputStyle.Short);
      
    const comissao = new TextInputBuilder()
      .setCustomId("comissao")
      .setLabel("Comissão (%)")
      .setPlaceholder("15")
      .setRequired(true)
      .setStyle(TextInputStyle.Short);
    
    modal.addComponents(
      new ActionRowBuilder().addComponents(discordId),
      new ActionRowBuilder().addComponents(cargo),
      new ActionRowBuilder().addComponents(cupom),
      new ActionRowBuilder().addComponents(comissao)
    );
    
    await interaction.showModal(modal);
  }

  // COMANDO: paineladmin
  if (interaction.commandName === "paineladmin") {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: "❌ Você precisa ser administrador para usar este comando.",
        flags: MessageFlags.Ephemeral
      });
    }
    
    const container = buildAdminPanel();
    await interaction.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
      ephemeral: true
    });
  }

  // COMANDO: calculadora
  if (interaction.commandName === "calculadora") {
    const modal = new ModalBuilder()
      .setCustomId("modal_calculadora")
      .setTitle("Calculadora de Robux");
    
    const quantidadeRobux = new TextInputBuilder()
      .setCustomId("quantidadeRobux")
      .setLabel("Quantidade de Robux desejada")
      .setPlaceholder("1000")
      .setRequired(true)
      .setStyle(TextInputStyle.Short);
      
    const cupom = new TextInputBuilder()
      .setCustomId("cupomCalculadora")
      .setLabel("Cupom (opcional)")
      .setPlaceholder("ROBUX10")
      .setRequired(false)
      .setStyle(TextInputStyle.Short);
    
    modal.addComponents(
      new ActionRowBuilder().addComponents(quantidadeRobux),
      new ActionRowBuilder().addComponents(cupom)
    );
    
    await interaction.showModal(modal);
  }

  // COMANDO: minhascomissoes
  if (interaction.commandName === "minhascomissoes") {
    const afiliado = await buscarAfiliadoPorId(interaction.user.id);
    
    if (!afiliado) {
      return interaction.reply({
        content: "❌ Você não é um afiliado registrado.",
        flags: MessageFlags.Ephemeral
      });
    }
    
    const embed = new EmbedBuilder()
      .setTitle("💰 Suas Comissões")
      .setColor(Colors.Green)
      .setDescription(`**Afiliado:** ${afiliado.fields.DiscordTag}`)
      .addFields(
        { name: "🎖️ Cargo", value: afiliado.fields.Cargo || "Afiliado", inline: true },
        { name: "🎫 Cupom", value: afiliado.fields.Cupom, inline: true },
        { name: "📊 Comissão", value: `${afiliado.fields.Comissao}%`, inline: true },
        { name: "📈 Vendas Totais", value: String(afiliado.fields.VendasTotais || 0), inline: true },
        { name: "💰 Valor Total", value: formatBRL(afiliado.fields.ValorTotal || 0), inline: true },
        { name: "💸 Comissão Total", value: formatBRL(afiliado.fields.ComissaoTotal || 0), inline: true },
        { name: "✅ Comissão Paga", value: formatBRL(afiliado.fields.ComissaoPaga || 0), inline: true },
        { name: "⏳ Comissão Pendente", value: formatBRL(afiliado.fields.ComissaoPendente || 0), inline: true },
        { name: "📅 Última Venda", value: afiliado.fields.UltimaVenda ? new Date(afiliado.fields.UltimaVenda).toLocaleDateString('pt-BR') : "Nenhuma", inline: true }
      )
      .setFooter({ text: `Cadastrado em: ${new Date(afiliado.fields.DataCadastro).toLocaleDateString('pt-BR')}` })
      .setTimestamp();
    
    await interaction.reply({
      embeds: [embed],
      flags: MessageFlags.Ephemeral
    });
  }

  // COMANDO: estatisticas
  if (interaction.commandName === "estatisticas") {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: "❌ Você precisa ser administrador para usar este comando.",
        flags: MessageFlags.Ephemeral
      });
    }
    
    try {
      const estatisticas = await obterEstatisticas();
      const container = buildEstatisticasPanel(estatisticas);
      
      await interaction.reply({
        flags: MessageFlags.IsComponentsV2,
        components: [container],
        ephemeral: true
      });
    } catch (error) {
      console.error("Erro ao buscar estatísticas:", error);
      await interaction.reply({
        content: "❌ Erro ao buscar estatísticas.",
        flags: MessageFlags.Ephemeral
      });
    }
  }

  // COMANDO: meuspedidos
  if (interaction.commandName === "meuspedidos") {
    try {
      const pedidos = await buscarPedidosPorDiscordId(interaction.user.id);
      
      if (!pedidos || pedidos.length === 0) {
        return interaction.reply({
          content: "📭 Você não possui pedidos registrados.",
          flags: MessageFlags.Ephemeral
        });
      }
      
      const embed = new EmbedBuilder()
        .setTitle("📦 Seus Pedidos")
        .setColor(Colors.Blue)
        .setDescription(`**Total de pedidos:** ${pedidos.length}`);
      
      pedidos.slice(0, 10).forEach((pedido, index) => {
        embed.addFields({
          name: `📋 Pedido ${index + 1}`,
          value: `**ID:** ${pedido.PagamentoId || 'N/A'}\n` +
                 `**Roblox:** ${pedido.RobloxUser || 'N/A'}\n` +
                 `**Robux:** ${pedido.Robux || 0}\n` +
                 `**Valor:** ${formatBRL(pedido.Valor || 0)}\n` +
                 `**Status:** ${pedido.Status || 'Desconhecido'}\n` +
                 `**Data:** ${new Date(pedido.Data).toLocaleDateString('pt-BR')}\n` +
                 `**Cupom:** ${pedido.Cupom || 'Nenhum'}`,
          inline: true
        });
      });
      
      if (pedidos.length > 10) {
        embed.setFooter({ text: `Mostrando 10 de ${pedidos.length} pedidos` });
      }
      
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
      });
    } catch (error) {
      console.error("Erro ao buscar pedidos:", error);
      await interaction.reply({
        content: "❌ Erro ao buscar seus pedidos.",
        flags: MessageFlags.Ephemeral
      });
    }
  }

  // COMANDO: configurar
  if (interaction.commandName === "configurar") {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: "❌ Você precisa ser administrador para usar este comando.",
        flags: MessageFlags.Ephemeral
      });
    }
    
    const modal = new ModalBuilder()
      .setCustomId("modal_configurar")
      .setTitle("Configurações do Sistema");
    
    const precoBase = new TextInputBuilder()
      .setCustomId("precoBase")
      .setLabel("Preço base (por 1000 robux)")
      .setPlaceholder("40")
      .setRequired(true)
      .setStyle(TextInputStyle.Short);
      
    const comissaoPadrao = new TextInputBuilder()
      .setCustomId("comissaoPadrao")
      .setLabel("Comissão padrão para afiliados (%)")
      .setPlaceholder("15")
      .setRequired(true)
      .setStyle(TextInputStyle.Short);
    
    modal.addComponents(
      new ActionRowBuilder().addComponents(precoBase),
      new ActionRowBuilder().addComponents(comissaoPadrao)
    );
    
    await interaction.showModal(modal);
  }
});

// ================================================================
// 🔵 INTERAÇÕES DE MENU DE SELEÇÃO
// ================================================================
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  
  // MENU: tipo_compra_menu
  if (interaction.customId === "tipo_compra_menu") {
    await interaction.deferUpdate();
    
    const selectedValue = interaction.values[0];
    
    if (selectedValue === "comprar_robux") {
      if (!IS_SHOP_OPEN) {
        await interaction.followUp({ content: "⛔ **A loja está fechada no momento.**", flags: MessageFlags.Ephemeral });
        return;
      }
      
      try {
        const parentChannel = interaction.channel.parent;
        const channel = await interaction.guild.channels.create({
          name: `🛒-compra-${interaction.user.username}`,
          type: ChannelType.GuildText,
          parent: parentChannel ? parentChannel.id : null,
          permissionOverwrites: [
            {
              id: interaction.guild.id,
              deny: [PermissionFlagsBits.ViewChannel]
            },
            {
              id: interaction.user.id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
            }
          ]
        });
        
        await channel.send(`Olá <@${interaction.user.id}>!`);
        
        const container = buildCartWelcomeContainer(interaction.user);
        const msg = await channel.send({ 
          flags: MessageFlags.IsComponentsV2, 
          components: [container] 
        });
        
        const current = userPurchaseData.get(interaction.user.id) || {};
        userPurchaseData.set(interaction.user.id, { 
          ...current, 
          lastMessageId: msg.id, 
          lastChannelId: msg.channel.id, 
          channelId: channel.id,
          purchaseType: "robux"
        });
        
        scheduleChannelAutoDelete(interaction.user.id, channel);
        
        await interaction.followUp({ 
          content: `✅ Criei seu canal para compra de Robux: ${channel.toString()}`, 
          flags: MessageFlags.Ephemeral 
        });
        
      } catch (e) {
        console.error("Erro criar canal:", e);
        await interaction.followUp({ 
          content: "❌ Erro ao criar canal. Tente novamente.", 
          flags: MessageFlags.Ephemeral 
        });
      }
    } 
    else if (selectedValue === "comprar_gamepass") {
      const devContainer = new ContainerBuilder()
        .setAccentColor(UI_THEME.ORANGE)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("## 🎮 Em Desenvolvimento")
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                "**Compra via Gamepass está em desenvolvimento!**\n\n" +
                "Esta funcionalidade será implementada em breve. Por enquanto, use a opção de compra direta de Robux."
            )
        )
        .addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(UI_THEME.LOGO))
        );
      
      await interaction.followUp({ 
        flags: MessageFlags.IsComponentsV2,
        components: [devContainer],
        ephemeral: true 
      });
    }
    else if (selectedValue === "calculadora_precos") {
      const modal = new ModalBuilder()
        .setCustomId("modal_calculadora_menu")
        .setTitle("Calculadora de Preços");
      
      const quantidadeRobux = new TextInputBuilder()
        .setCustomId("quantidadeRobuxMenu")
        .setLabel("Quantidade de Robux desejada")
        .setPlaceholder("1000")
        .setRequired(true)
        .setStyle(TextInputStyle.Short);
        
      const cupom = new TextInputBuilder()
        .setCustomId("cupomMenu")
        .setLabel("Cupom (opcional)")
        .setPlaceholder("ROBUX10")
        .setRequired(false)
        .setStyle(TextInputStyle.Short);
      
      modal.addComponents(
        new ActionRowBuilder().addComponents(quantidadeRobux),
        new ActionRowBuilder().addComponents(cupom)
      );
      
      await interaction.showModal(modal);
    }
    return;
  }
});

// ================================================================
// 🔵 INTERAÇÕES DE BOTÃO
// ================================================================
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  // BOTÃO: btn_ajuda
  if (interaction.customId === "btn_ajuda") {
    await interaction.reply({ content: "🔔 Um atendente foi notificado e entrará em contato em breve.", flags: MessageFlags.Ephemeral });
    
    // Notificar administradores
    const adminRole = interaction.guild.roles.cache.get(process.env.ADMIN_ROLE_ID);
    if (adminRole) {
      const adminChannel = interaction.guild.channels.cache.find(ch => ch.name.includes('suporte') || ch.name.includes('admin'));
      if (adminChannel) {
        await adminChannel.send({
          content: `📞 **Nova solicitação de ajuda!**\nUsuário: ${interaction.user.tag}\nCanal: ${interaction.channel.toString()}`,
          allowedMentions: { roles: [adminRole.id] }
        });
      }
    }
    return;
  }

  // BOTÃO: btn_continuar
  if (interaction.customId === "btn_continuar" || interaction.customId === "confirmar_usuario_nao") {
    const modal = new ModalBuilder()
      .setCustomId("modal_compra")
      .setTitle("Informações da compra");
    
    const robloxUser = new TextInputBuilder()
      .setCustomId("robloxUser")
      .setLabel("Usuário Roblox")
      .setPlaceholder("Ex: RobloxPlayer")
      .setRequired(true)
      .setStyle(TextInputStyle.Short);
      
    const quantidadeRobux = new TextInputBuilder()
      .setCustomId("quantidadeRobux")
      .setLabel("Quantidade de Robux desejada")
      .setPlaceholder("Ex: 1000")
      .setRequired(true)
      .setStyle(TextInputStyle.Short);
    
    const cupom = new TextInputBuilder()
      .setCustomId("cupom")
      .setLabel("Cupom (opcional)")
      .setPlaceholder("Ex: ROBUX10")
      .setRequired(false)
      .setStyle(TextInputStyle.Short);
    
    modal.addComponents(
      new ActionRowBuilder().addComponents(robloxUser),
      new ActionRowBuilder().addComponents(quantidadeRobux),
      new ActionRowBuilder().addComponents(cupom)
    );
    
    await interaction.showModal(modal);
    return;
  }

  // BOTÃO: btn_voltar_inicio
  if (interaction.customId === "btn_voltar_inicio") {
    const data = userPurchaseData.get(interaction.user.id);
    if (!data) return interaction.reply({ content: "Erro de sessão.", flags: MessageFlags.Ephemeral });
    
    const container = buildCartWelcomeContainer(interaction.user);
    try {
      const ch = await client.channels.fetch(data.lastChannelId);
      const msg = await ch.messages.fetch(data.lastMessageId);
      await msg.edit({ 
        flags: MessageFlags.IsComponentsV2, 
        components: [container] 
      });
      await interaction.deferUpdate();
    } catch(e) {
      console.error("Erro ao voltar:", e);
    }
    return;
  }

  // BOTÃO: confirmar_usuario_sim
  if (interaction.customId === "confirmar_usuario_sim") {
    await interaction.deferUpdate();
    const data = userPurchaseData.get(interaction.user.id);
    if (!data || !data.robloxUserId) return;
    
    const { robloxUsername, quantidadeRobux, cupom } = data;
    
    // Verificar se há cupom
    let afiliado = null;
    if (cupom) {
      const afiliadoData = await buscarAfiliadoPorCupom(cupom);
      if (afiliadoData) {
        afiliado = {
          discordId: afiliadoData.fields.DiscordId,
          discordTag: afiliadoData.fields.DiscordTag,
          comissao: afiliadoData.fields.Comissao || 15
        };
      }
    }
    
    const container = buildPaymentContainer({ 
      robloxUsername, 
      quantidadeRobux, 
      cupom,
      afiliado 
    });
    
    data.afiliado = afiliado;
    data.lastContainer = container;
    userPurchaseData.set(interaction.user.id, data);
    
    try {
      const ch = await client.channels.fetch(data.lastChannelId);
      const msg = await ch.messages.fetch(data.lastMessageId);
      await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
    } catch(e) {
      console.error("Erro ao mostrar pagamento:", e);
    }
    return;
  }

  // BOTÃO: gerar_pix_pagamento
  if (interaction.customId === "gerar_pix_pagamento") {
    await interaction.deferUpdate();
    
    const data = userPurchaseData.get(interaction.user.id);
    if (!data) return;
    
    const { robloxUsername, quantidadeRobux, cupom, afiliado } = data;
    
    // Calcular preço final
    const calculo = calcularPrecoRobux(parseInt(quantidadeRobux), cupom);
    
    try {
      // Criar pagamento PIX
      const paymentData = await createMercadoPagoPayment(
        {
          finalPrice: calculo.precoFinal,
          robuxReceber: calculo.robuxReceber,
          gamepassValor: calculo.gamepassValor
        },
        interaction.user.id,
        robloxUsername,
        cupom,
        afiliado
      );
      
      // Salvar dados do pagamento
      data.paymentId = paymentData.id;
      data.paymentData = paymentData;
      userPurchaseData.set(interaction.user.id, data);
      
      // Mostrar QR Code PIX
      const container = buildPixPaymentContainer(paymentData);
      
      try {
        const ch = await client.channels.fetch(data.lastChannelId);
        const msg = await ch.messages.fetch(data.lastMessageId);
        await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
      } catch(e) {
        console.error("Erro ao mostrar PIX:", e);
      }
      
      // Enviar DM com os dados do pagamento
      try {
        const user = await client.users.fetch(interaction.user.id);
        await user.send({
          embeds: [{
            title: "💠 PIX Gerado com Sucesso!",
            description: `Seu pagamento foi gerado com sucesso!\n\n` +
                         `**Detalhes do Pagamento:**\n` +
                         `• ID: ${paymentData.id}\n` +
                         `• Valor: ${formatBRL(calculo.precoFinal)}\n` +
                         `• Robux a receber: ${calculo.robuxReceber}\n` +
                         `• Expira em: 30 minutos\n\n` +
                         `**Código PIX:**\n\`\`\`\n${paymentData.pixCopiaCola}\n\`\`\``,
            color: Colors.Green
          }]
        });
      } catch (error) {
        console.log("Não foi possível enviar DM:", error);
      }
      
    } catch (error) {
      console.error("Erro ao gerar PIX:", error);
      
      const errorContainer = buildErrorContainer("Erro ao gerar o PIX. Tente novamente.");
      try {
        const ch = await client.channels.fetch(data.lastChannelId);
        const msg = await ch.messages.fetch(data.lastMessageId);
        await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [errorContainer] });
      } catch(e) {
        console.error("Erro ao mostrar erro:", e);
      }
    }
    return;
  }

  // BOTÃO: voltar_para_resumo
  if (interaction.customId === "voltar_para_resumo") {
    const data = userPurchaseData.get(interaction.user.id);
    if (!data) return;
    
    const { robloxUsername, quantidadeRobux, cupom, afiliado } = data;
    const container = buildPaymentContainer({ 
      robloxUsername, 
      quantidadeRobux, 
      cupom,
      afiliado 
    });
    
    try {
      const ch = await client.channels.fetch(data.lastChannelId);
      const msg = await ch.messages.fetch(data.lastMessageId);
      await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
      await interaction.deferUpdate();
    } catch(e) {
      console.error("Erro ao voltar:", e);
    }
    return;
  }

  // BOTÃO: verificar_pagamento
  if (interaction.customId === "verificar_pagamento") {
    await interaction.deferUpdate();
    
    const data = userPurchaseData.get(interaction.user.id);
    if (!data || !data.paymentId) return;
    
    // Aqui você implementaria a verificação do pagamento
    // Por enquanto, apenas informamos que está sendo verificado
    
    try {
      const ch = await client.channels.fetch(data.lastChannelId);
      await ch.send({
        content: `🔍 Verificando pagamento **${data.paymentId}**...\nO sistema atualizará automaticamente quando o pagamento for confirmado.`
      });
    } catch(e) {
      console.error("Erro ao verificar:", e);
    }
    return;
  }

  // BOTÃO: btn_cancelar_compra
  if (interaction.customId === "btn_cancelar_compra") {
    const data = userPurchaseData.get(interaction.user.id);
    if (!data) return;
    
    const container = buildCancelConfirmContainer();
    try {
      const channel = await client.channels.fetch(data.lastChannelId);
      const message = await channel.messages.fetch(data.lastMessageId);
      await message.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
      await interaction.deferUpdate();
    } catch(e) {
      console.error("Erro ao cancelar:", e);
    }
    return;
  }

  // BOTÃO: btn_cancelar_voltar
  if (interaction.customId === "btn_cancelar_voltar") {
    const data = userPurchaseData.get(interaction.user.id);
    if (!data || !data.lastContainer) return;
    
    try {
      const ch = await client.channels.fetch(data.lastChannelId);
      const msg = await ch.messages.fetch(data.lastMessageId);
      await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [data.lastContainer] });
      await interaction.deferUpdate();
    } catch(e) {
      console.error("Erro ao voltar do cancelamento:", e);
    }
    return;
  }

  // BOTÃO: btn_cancelar_confirmado
  if (interaction.customId === "btn_cancelar_confirmado") {
    const data = userPurchaseData.get(interaction.user.id);
    if (!data) return;
    
    const container = buildCanceledContainer();
    try {
      const channel = await client.channels.fetch(data.lastChannelId);
      const message = await channel.messages.fetch(data.lastMessageId);
      await message.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
      await interaction.deferUpdate();
      
      clearChannelAutoDelete(interaction.user.id);
      
      // Agendar exclusão do canal
      setTimeout(async () => {
        try {
          const c = await client.channels.fetch(data.channelId).catch(() => null);
          if (c) {
            await c.send("🔒 Canal sendo encerrado...");
            setTimeout(async () => {
              await c.delete().catch(() => {});
            }, 3000);
          }
        } catch (error) {
          console.error("Erro ao excluir canal:", error);
        }
      }, 5000);
      
      userPurchaseData.delete(interaction.user.id);
      
    } catch(e) {
      console.error("Erro ao confirmar cancelamento:", e);
    }
    return;
  }

  // BOTÕES DO PAINEL ADMIN
  if (interaction.customId.startsWith("admin_")) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: "❌ Você precisa ser administrador para usar este painel.",
        flags: MessageFlags.Ephemeral
      });
    }
    
    await interaction.deferUpdate();
    
    // admin_estatisticas
    if (interaction.customId === "admin_estatisticas") {
      try {
        const estatisticas = await obterEstatisticas();
        const container = buildEstatisticasPanel(estatisticas);
        
        const ch = interaction.channel;
        const msg = await ch.messages.fetch(interaction.message.id);
        await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
      } catch (error) {
        console.error("Erro ao buscar estatísticas:", error);
      }
    }
    
    // admin_afiliados
    else if (interaction.customId === "admin_afiliados") {
      try {
        const afiliados = await listarAfiliados();
        const container = buildAfiliadosPanel(afiliados);
        
        const ch = interaction.channel;
        const msg = await ch.messages.fetch(interaction.message.id);
        await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
      } catch (error) {
        console.error("Erro ao buscar afiliados:", error);
      }
    }
    
    // admin_novo_afiliado
    else if (interaction.customId === "admin_novo_afiliado" || interaction.customId === "admin_novo_afiliado_modal") {
      const modal = new ModalBuilder()
        .setCustomId("modal_admin_novo_afiliado")
        .setTitle("Cadastrar Novo Afiliado");
      
      const discordId = new TextInputBuilder()
        .setCustomId("adminDiscordId")
        .setLabel("ID do Discord")
        .setPlaceholder("123456789012345678")
        .setRequired(true)
        .setStyle(TextInputStyle.Short);
        
      const cargo = new TextInputBuilder()
        .setCustomId("adminCargo")
        .setLabel("Cargo (Afiliado, Premium, VIP)")
        .setPlaceholder("Afiliado")
        .setRequired(true)
        .setStyle(TextInputStyle.Short);
        
      const cupom = new TextInputBuilder()
        .setCustomId("adminCupom")
        .setLabel("Cupom Personalizado")
        .setPlaceholder("EXEMPLO20")
        .setRequired(true)
        .setStyle(TextInputStyle.Short);
        
      const comissao = new TextInputBuilder()
        .setCustomId("adminComissao")
        .setLabel("Comissão (%)")
        .setPlaceholder("15")
        .setRequired(true)
        .setStyle(TextInputStyle.Short);
      
      modal.addComponents(
        new ActionRowBuilder().addComponents(discordId),
        new ActionRowBuilder().addComponents(cargo),
        new ActionRowBuilder().addComponents(cupom),
        new ActionRowBuilder().addComponents(comissao)
      );
      
      await interaction.showModal(modal);
    }
    
    // admin_pagar_comissoes
    else if (interaction.customId === "admin_pagar_comissoes") {
      try {
        const comissoes = await obterComissoesMensais(new Date().getMonth() + 1, new Date().getFullYear());
        
        if (comissoes.length === 0) {
          await interaction.followUp({
            content: "✅ Não há comissões pendentes para pagar.",
            flags: MessageFlags.Ephemeral
          });
          return;
        }
        
        let totalPagar = 0;
        let mensagem = "**💰 COMISSÕES PENDENTES**\n\n";
        
        comissoes.forEach((com, index) => {
          mensagem += `**${index + 1}. ${com.discordTag}**\n`;
          mensagem += `   🎖️ Cargo: ${com.cargo}\n`;
          mensagem += `   💰 Pendente: ${formatBRL(com.comissaoPendente)}\n`;
          mensagem += `   📊 Vendas: ${com.vendasTotais}\n`;
          mensagem += `   💵 Total Vendido: ${formatBRL(com.valorTotal)}\n\n`;
          
          totalPagar += com.comissaoPendente;
        });
        
        mensagem += `\n**💵 TOTAL A PAGAR:** ${formatBRL(totalPagar)}`;
        
        const embed = new EmbedBuilder()
          .setTitle("💰 Pagamento de Comissões")
          .setDescription(mensagem)
          .setColor(Colors.Gold)
          .setTimestamp();
        
        await interaction.followUp({
          embeds: [embed],
          flags: MessageFlags.Ephemeral
        });
        
      } catch (error) {
        console.error("Erro ao processar comissões:", error);
        await interaction.followUp({
          content: "❌ Erro ao processar comissões.",
          flags: MessageFlags.Ephemeral
        });
      }
    }
    
    // admin_voltar
    else if (interaction.customId === "admin_voltar") {
      const container = buildAdminPanel();
      const ch = interaction.channel;
      const msg = await ch.messages.fetch(interaction.message.id);
      await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
    }
    
    // admin_fechar
    else if (interaction.customId === "admin_fechar") {
      await interaction.message.delete().catch(() => {});
    }
    
    // admin_atualizar_estatisticas
    else if (interaction.customId === "admin_atualizar_estatisticas") {
      try {
        const estatisticas = await obterEstatisticas();
        const container = buildEstatisticasPanel(estatisticas);
        
        const ch = interaction.channel;
        const msg = await ch.messages.fetch(interaction.message.id);
        await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
        
        await interaction.followUp({
          content: "✅ Estatísticas atualizadas!",
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        console.error("Erro ao atualizar estatísticas:", error);
        await interaction.followUp({
          content: "❌ Erro ao atualizar estatísticas.",
          flags: MessageFlags.Ephemeral
        });
      }
    }
    
    // admin_estatisticas_cargos
    else if (interaction.customId === "admin_estatisticas_cargos") {
      try {
        const estatisticasCargo = await obterEstatisticasPorCargo();
        
        let mensagem = "**📊 ESTATÍSTICAS POR CARGO**\n\n";
        
        Object.entries(estatisticasCargo).forEach(([cargo, dados]) => {
          mensagem += `**🎖️ ${cargo}**\n`;
          mensagem += `   👥 Quantidade: ${dados.quantidade}\n`;
          mensagem += `   📊 Vendas: ${dados.vendas}\n`;
          mensagem += `   💵 Valor: ${formatBRL(dados.valor)}\n`;
          mensagem += `   💸 Comissão: ${formatBRL(dados.comissao)}\n\n`;
        });
        
        const embed = new EmbedBuilder()
          .setTitle("📊 Estatísticas por Cargo")
          .setDescription(mensagem)
          .setColor(Colors.Blue)
          .setTimestamp();
        
        await interaction.followUp({
          embeds: [embed],
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        console.error("Erro ao buscar estatísticas por cargo:", error);
        await interaction.followUp({
          content: "❌ Erro ao buscar estatísticas por cargo.",
          flags: MessageFlags.Ephemeral
        });
      }
    }
    
    return;
  }

  // BOTÕES DA CALCULADORA
  if (interaction.customId === "comprar_calculadora") {
    // Redirecionar para compra
    if (!IS_SHOP_OPEN) {
      return interaction.reply({
        content: "⛔ A loja está fechada no momento.",
        flags: MessageFlags.Ephemeral
      });
    }
    
    await interaction.deferUpdate();
    
    // Criar canal de compra
    try {
      const parentChannel = interaction.channel.parent;
      const channel = await interaction.guild.channels.create({
        name: `🛒-compra-${interaction.user.username}`,
        type: ChannelType.GuildText,
        parent: parentChannel ? parentChannel.id : null,
        permissionOverwrites: [
          {
            id: interaction.guild.id,
            deny: [PermissionFlagsBits.ViewChannel]
          },
          {
            id: interaction.user.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
          }
        ]
      });
      
      await channel.send(`Olá <@${interaction.user.id}>!`);
      
      const container = buildCartWelcomeContainer(interaction.user);
      const msg = await channel.send({ 
        flags: MessageFlags.IsComponentsV2, 
        components: [container] 
      });
      
      const current = userPurchaseData.get(interaction.user.id) || {};
      userPurchaseData.set(interaction.user.id, { 
        ...current, 
        lastMessageId: msg.id, 
        lastChannelId: msg.channel.id, 
        channelId: channel.id,
        purchaseType: "robux"
      });
      
      scheduleChannelAutoDelete(interaction.user.id, channel);
      
      await interaction.followUp({ 
        content: `✅ Criei seu canal para compra de Robux: ${channel.toString()}`, 
        flags: MessageFlags.Ephemeral 
      });
      
    } catch (e) {
      console.error("Erro criar canal:", e);
      await interaction.followUp({ 
        content: "❌ Erro ao criar canal. Tente novamente.", 
        flags: MessageFlags.Ephemeral 
      });
    }
    return;
  }
  
  else if (interaction.customId === "nova_consulta_calculadora") {
    const modal = new ModalBuilder()
      .setCustomId("modal_calculadora_menu")
      .setTitle("Calculadora de Preços");
    
    const quantidadeRobux = new TextInputBuilder()
      .setCustomId("quantidadeRobuxMenu")
      .setLabel("Quantidade de Robux desejada")
      .setPlaceholder("1000")
      .setRequired(true)
      .setStyle(TextInputStyle.Short);
      
    const cupom = new TextInputBuilder()
      .setCustomId("cupomMenu")
      .setLabel("Cupom (opcional)")
      .setPlaceholder("ROBUX10")
      .setRequired(false)
      .setStyle(TextInputStyle.Short);
    
    modal.addComponents(
      new ActionRowBuilder().addComponents(quantidadeRobux),
      new ActionRowBuilder().addComponents(cupom)
    );
    
    await interaction.showModal(modal);
    return;
  }
  
  else if (interaction.customId === "fechar_calculadora") {
    await interaction.message.delete().catch(() => {});
    return;
  }
});

// ================================================================
// 🔵 SUBMIT DE MODAIS
// ================================================================
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isModalSubmit()) return;

  // MODAL: modal_compra
  if (interaction.customId === "modal_compra") {
    await interaction.deferUpdate();
    
    const usuario = interaction.fields.getTextInputValue("robloxUser");
    const quantidadeRobux = interaction.fields.getTextInputValue("quantidadeRobux");
    const cupom = interaction.fields.getTextInputValue("cupom") || null;
    
    const saved = userPurchaseData.get(interaction.user.id);
    const sendError = async (msg) => {
      if (saved?.lastMessageId && saved?.lastChannelId) {
        try {
          const ch = await client.channels.fetch(saved.lastChannelId);
          const m = await ch.messages.fetch(saved.lastMessageId);
          await m.edit({ flags: MessageFlags.IsComponentsV2, components: [buildErrorContainer(msg)] });
        } catch (e) {
          console.error("Erro ao enviar erro:", e);
        }
      }
    };

    // Validar quantidade de Robux
    const qtdRobuxNum = parseInt(quantidadeRobux);
    if (isNaN(qtdRobuxNum) || qtdRobuxNum < 100) {
      await sendError("Por favor, insira uma quantidade válida de Robux (mínimo 100).");
      return;
    }

    // Validar cupom
    let afiliadoData = null;
    if (cupom) {
      const afiliado = await buscarAfiliadoPorCupom(cupom.toUpperCase());
      if (!afiliado) {
        await sendError(`O cupom **${cupom}** não é válido ou não existe.`);
        return;
      }
      afiliadoData = {
        discordId: afiliado.fields.DiscordId,
        discordTag: afiliado.fields.DiscordTag,
        comissao: afiliado.fields.Comissao || 15
      };
    }

    // Buscar usuário Roblox
    const robloxUser = await getRobloxUser(usuario);
    if (!robloxUser) { 
      await sendError(`O usuário **${usuario}** não foi encontrado no Roblox.`); 
      return; 
    }

    const userGames = await getUserGames(robloxUser.id);
    const gameName = userGames.length > 0 ? userGames[0].name : null;
    const avatarURL = await getRobloxAvatar(robloxUser.id);

    // Salvar dados do usuário
    const newData = { 
      ...saved, 
      usuarioDigitado: usuario, 
      robloxUserId: robloxUser.id, 
      robloxUsername: robloxUser.name, 
      avatarURL, 
      gameName, 
      quantidadeRobux: qtdRobuxNum,
      cupom: cupom?.toUpperCase() || null,
      afiliado: afiliadoData,
      selectedGamepasses: [], 
      lastChannelId: saved.lastChannelId, 
      lastMessageId: saved.lastMessageId, 
      channelId: saved.channelId 
    };
    userPurchaseData.set(interaction.user.id, newData);

    // Mostrar confirmação
    const containerBuilder = buildConfirmUserContainer({ 
      usuarioDigitado: usuario, 
      robloxUserId: robloxUser.id, 
      robloxUsername: robloxUser.name, 
      avatarURL, 
      gameName,
      quantidadeRobux: qtdRobuxNum
    });

    if (saved?.lastMessageId && saved?.lastChannelId) {
      try {
        const channel = await client.channels.fetch(saved.lastChannelId);
        const message = await channel.messages.fetch(saved.lastMessageId);
        await message.edit({ flags: MessageFlags.IsComponentsV2, components: [containerBuilder] });
        newData.lastContainer = containerBuilder;
        userPurchaseData.set(interaction.user.id, newData);
      } catch (e) { 
        console.error("Erro ao editar mensagem:", e);
      }
    }
  }

  // MODAL: modal_novo_afiliado
  else if (interaction.customId === "modal_novo_afiliado" || interaction.customId === "modal_admin_novo_afiliado") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    try {
      const discordId = interaction.customId === "modal_novo_afiliado" 
        ? interaction.fields.getTextInputValue("discordId")
        : interaction.fields.getTextInputValue("adminDiscordId");
      
      const cargo = interaction.customId === "modal_novo_afiliado"
        ? interaction.fields.getTextInputValue("cargo")
        : interaction.fields.getTextInputValue("adminCargo");
      
      const cupom = interaction.customId === "modal_novo_afiliado"
        ? interaction.fields.getTextInputValue("cupom")
        : interaction.fields.getTextInputValue("adminCupom");
      
      const comissao = interaction.customId === "modal_novo_afiliado"
        ? interaction.fields.getTextInputValue("comissao")
        : interaction.fields.getTextInputValue("adminComissao");
      
      const comissaoNum = parseFloat(comissao);
      
      // Validar comissão
      if (isNaN(comissaoNum) || comissaoNum < 1 || comissaoNum > 50) {
        return interaction.editReply({ 
          content: "❌ A comissão deve ser um número entre 1% e 50%." 
        });
      }
      
      // Verificar se usuário existe
      let user;
      try {
        user = await client.users.fetch(discordId);
      } catch {
        return interaction.editReply({ 
          content: "❌ Não foi possível encontrar o usuário com este ID no Discord." 
        });
      }
      
      // Verificar se cupom já existe
      const cupomExistente = await buscarAfiliadoPorCupom(cupom.toUpperCase());
      if (cupomExistente) {
        return interaction.editReply({ 
          content: `❌ O cupom **${cupom.toUpperCase()}** já está em uso por outro afiliado.` 
        });
      }
      
      // Criar afiliado no banco de dados
      const dadosAfiliado = {
        discordId,
        discordTag: user.tag,
        cargo: cargo || "Afiliado",
        cupom: cupom.toUpperCase(),
        comissao: comissaoNum
      };
      
      await criarAfiliado(dadosAfiliado);
      
      await interaction.editReply({ 
        content: `✅ Afiliado cadastrado com sucesso!\n\n` +
                 `**👤 Usuário:** ${user.tag}\n` +
                 `**🆔 ID:** ${discordId}\n` +
                 `**🎖️ Cargo:** ${cargo || 'Afiliado'}\n` +
                 `**🎫 Cupom:** ${cupom.toUpperCase()}\n` +
                 `**💰 Comissão:** ${comissaoNum}%\n\n` +
                 `O cupom já está ativo para uso!`
      });
      
      // Enviar mensagem para o afiliado
      try {
        await user.send({
          embeds: [{
            title: "🎉 Você foi cadastrado como Afiliado!",
            description: `Parabéns! Você foi registrado como afiliado na nossa loja de Robux.\n\n` +
                         `**Seus dados:**\n` +
                         `• Cargo: ${cargo || 'Afiliado'}\n` +
                         `• Cupom: ${cupom.toUpperCase()}\n` +
                         `• Comissão: ${comissaoNum}%\n\n` +
                         `**Como funciona:**\n` +
                         `1. Compartilhe seu cupom com seus amigos\n` +
                         `2. Quando alguém usar seu cupom, você ganha ${comissaoNum}% da venda\n` +
                         `3. As comissões são pagas mensalmente\n\n` +
                         `Agora você pode começar a ganhar comissões!`,
            color: Colors.Green,
            timestamp: new Date()
          }]
        });
      } catch (error) {
        console.log("⚠️ Não foi possível enviar DM para o afiliado:", error);
      }
      
    } catch (error) {
      console.error("Erro ao cadastrar afiliado:", error);
      await interaction.editReply({ 
        content: "❌ Ocorreu um erro ao cadastrar o afiliado. Verifique os dados e tente novamente." 
      });
    }
  }

  // MODAL: modal_calculadora ou modal_calculadora_menu
  else if (interaction.customId === "modal_calculadora" || interaction.customId === "modal_calculadora_menu") {
    await interaction.deferReply({ ephemeral: true });
    
    const quantidadeRobux = interaction.customId === "modal_calculadora"
      ? interaction.fields.getTextInputValue("quantidadeRobux")
      : interaction.fields.getTextInputValue("quantidadeRobuxMenu");
    
    const cupom = interaction.customId === "modal_calculadora"
      ? interaction.fields.getTextInputValue("cupomCalculadora")
      : interaction.fields.getTextInputValue("cupomMenu");
    
    const qtdRobuxNum = parseInt(quantidadeRobux);
    
    if (isNaN(qtdRobuxNum) || qtdRobuxNum < 100) {
      return interaction.editReply({
        content: "❌ Por favor, insira uma quantidade válida de Robux (mínimo 100).",
        flags: MessageFlags.Ephemeral
      });
    }
    
    const container = buildCalculadoraContainer(qtdRobuxNum, cupom || null);
    
    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: [container]
    });
  }

  // MODAL: modal_configurar
  else if (interaction.customId === "modal_configurar") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    
    const precoBase = parseFloat(interaction.fields.getTextInputValue("precoBase"));
    const comissaoPadrao = parseFloat(interaction.fields.getTextInputValue("comissaoPadrao"));
    
    if (isNaN(precoBase) || precoBase <= 0) {
      return interaction.editReply({
        content: "❌ O preço base deve ser um número maior que zero."
      });
    }
    
    if (isNaN(comissaoPadrao) || comissaoPadrao < 0 || comissaoPadrao > 100) {
      return interaction.editReply({
        content: "❌ A comissão padrão deve ser um número entre 0 e 100."
      });
    }
    
    // Atualizar configurações
    ECONOMY.BASE_PRICE = precoBase;
    
    await interaction.editReply({
      content: `✅ Configurações atualizadas com sucesso!\n\n` +
               `**💰 Preço base:** ${formatBRL(precoBase)} por 1000 Robux\n` +
               `**📊 Comissão padrão:** ${comissaoPadrao}%\n\n` +
               `As novas configurações já estão em vigor.`
    });
  }
});

// ================================================================
// 🔵 SISTEMA DE COMISSÕES MENSAL
// ================================================================
async function processarComissoesMensais() {
  console.log("💸 Processando comissões mensais...");
  
  try {
    const hoje = new Date();
    const comissoes = await obterComissoesMensais(hoje.getMonth() + 1, hoje.getFullYear());
    
    if (comissoes.length === 0) {
      console.log("✅ Nenhuma comissão pendente para processar.");
      return;
    }
    
    let totalPago = 0;
    const pagamentosRealizados = [];
    
    for (const comissao of comissoes) {
      if (comissao.comissaoPendente > 0) {
        // Marcar comissão como paga no banco
        await atualizarComissaoPaga(comissao.discordId, comissao.comissaoPendente);
        
        totalPago += comissao.comissaoPendente;
        pagamentosRealizados.push({
          afiliado: comissao.discordTag,
          valor: comissao.comissaoPendente
        });
        
        // Notificar afiliado
        try {
          const user = await client.users.fetch(comissao.discordId);
          await user.send({
            embeds: [{
              title: "💰 Comissão Paga!",
              description: `Sua comissão do mês foi paga!\n\n` +
                           `**Valor recebido:** ${formatBRL(comissao.comissaoPendente)}\n` +
                           `**Período:** ${hoje.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })}\n` +
                           `**Vendas realizadas:** ${comissao.vendasTotais}\n` +
                           `**Total vendido:** ${formatBRL(comissao.valorTotal)}\n\n` +
                           `Obrigado por fazer parte da nossa rede de afiliados!`,
              color: Colors.Gold,
              timestamp: new Date()
            }]
          });
        } catch (error) {
          console.log(`⚠️ Não foi possível notificar afiliado ${comissao.discordTag}:`, error);
        }
      }
    }
    
    console.log(`✅ Comissões processadas: ${formatBRL(totalPago)} pago para ${pagamentosRealizados.length} afiliados.`);
    
    // Enviar relatório para canal administrativo
    if (client.isReady()) {
      const canalAdmin = client.channels.cache.find(ch => ch.name.includes('admin') || ch.name.includes('log'));
      
      if (canalAdmin) {
        const embed = new EmbedBuilder()
          .setTitle("💰 RELATÓRIO DE COMISSÕES MENSAL")
          .setDescription(`Comissões pagas em ${hoje.toLocaleDateString('pt-BR')}`)
          .setColor(Colors.Green)
          .addFields(
            { name: "Total de Afiliados", value: String(pagamentosRealizados.length), inline: true },
            { name: "Valor Total Pago", value: formatBRL(totalPago), inline: true },
            { name: "Mês de Referência", value: hoje.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }), inline: true }
          )
          .setTimestamp();
        
        await canalAdmin.send({ embeds: [embed] });
      }
    }
    
  } catch (error) {
    console.error("❌ Erro ao processar comissões mensais:", error);
  }
}

// Agendar processamento para o primeiro dia de cada mês às 00:00
setInterval(() => {
  const agora = new Date();
  if (agora.getDate() === 1 && agora.getHours() === 0 && agora.getMinutes() === 0) {
    processarComissoesMensais();
  }
}, 60 * 1000); // Verificar a cada minuto

// ================================================================
// 🔵 INICIAR BOT
// ================================================================
client.login(TOKEN).catch(console.error);

// ================================================================
// 🔵 SERVER EXPRESS PARA WEBHOOKS
// ================================================================
const server = express();
server.use(express.json());

// Endpoint para verificar status do bot
server.get('/status', (req, res) => {
  res.json({
    status: 'online',
    bot: client.user?.tag || 'Desconectado',
    shopOpen: IS_SHOP_OPEN,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// Endpoint para receber webhooks do Mercado Pago
server.post('/mercadopago-webhook', async (req, res) => {
  console.log('📩 Webhook recebido do Mercado Pago:', req.body);
  
  try {
    const { type, data } = req.body;
    
    if (type === 'payment') {
      const paymentId = data.id;
      
      // Buscar informações do pagamento
      const payment = await buscarPagamento(paymentId);
      
      if (payment && payment.status === 'approved') {
        console.log(`✅ Pagamento aprovado: ${paymentId}`);
        
        // Aqui você implementaria a lógica para:
        // 1. Atualizar status no banco de dados
        // 2. Notificar o cliente
        // 3. Processar comissões do afiliado
        // 4. Mover para canal de pagos
      }
    }
    
    res.status(200).send('OK');
  } catch (error) {
    console.error('❌ Erro ao processar webhook:', error);
    res.status(500).send('Erro interno');
  }
});

server.listen(8080, () => {
  console.log('🌐 Servidor webhook rodando na porta 8080');
});

// ================================================================
// 🔵 TRATAMENTO DE ERROS
// ================================================================
process.on('unhandledRejection', (error) => {
  console.error('❌ Erro não tratado:', error);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Exceção não capturada:', error);
});
