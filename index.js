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
} from "discord.js";
import fetch from "node-fetch";
import { MercadoPagoConfig, Preference, Payment } from "mercadopago";
import express from "express";

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
    GREEN: 0x57F287,
    RED: 0xED4245,
    ORANGE: 0xFFA500,
    GRAY: 0x2B2D31,
    LOGO: "https://cdn.discordapp.com/attachments/1418035623503204474/1460867069372399781/ChatGPT_Image_13_de_jan._de_2026_23_40_20.png?ex=696879fa&is=6967287a&hm=7acd1824bb377377e64f0269c51ea60df3f56aed9313b28e5109fbb7964bee77&",
    BANNER_CART: "https://cdn.discordapp.com/attachments/1418035623503204474/1460867069372399781/ChatGPT_Image_13_de_jan._de_2026_23_40_20.png?ex=696879fa&is=6967287a&hm=7acd1824bb377377e64f0269c51ea60df3f56aed9313b28e5109fbb7964bee77&"
};

const ECONOMY = {
    PRICE_PER_ROBUX: 0.048
};

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
  ],
  partials: [Partials.Channel],
});

const TOKEN = process.env.DISCORD_TOKEN;
const ROBLOX_SECURITY = process.env.ROBLOSECURITY;
let CSRF_TOKEN = null;

const THREAD_AUTO_DELETE_MS = 30 * 60 * 1000;

// ================================================================
// 🔵 FUNÇÕES DE AUTENTICAÇÃO & ROBLOX
// ================================================================
async function createMercadoPagoPayment(purchaseData, discordUserId, threadId, purchaseId) {
  const preference = {
    items: [
      {
        title: `Compra de ${purchaseData.totalRobux} Robux`,
        quantity: 1,
        currency_id: "BRL",
        unit_price: purchaseData.finalPrice
      }
    ],
    external_reference: JSON.stringify({
      discordUserId,
      threadId,
      purchaseId
    }),
    notification_url: `${process.env.WEBHOOK_URL}/mercadopago-webhook`,
    payment_methods: {
      default_payment_method_id: "pix"
    }
  };

  const response = await preferenceClient.create({ body: preference });
  return response.init_point;
}


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

// FUNÇÃO CORRIGIDA - USANDO O MÉTODO DO INDEX (1).js QUE FUNCIONA
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

// FUNÇÃO PARA ENCONTRAR GAMEPASS POR VALOR ESPECÍFICO
function encontrarGamepassPorValor(gamepasses, valorDesejado) {
  if (!gamepasses || !Array.isArray(gamepasses)) return null;
  
  // Primeiro, tentar encontrar exatamente o valor
  const exata = gamepasses.find(gp => gp.price === valorDesejado && gp.isForSale === true);
  if (exata) return exata;
  
  // Se não encontrar exato, tentar encontrar o mais próximo (dentro de um intervalo)
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
// 🎨 UI BUILDERS (MANTIDOS IGUAIS)
// ================================================================

function buildMainPanelComponents() {
    const statusColor = IS_SHOP_OPEN ? UI_THEME.RED : UI_THEME.RED;

    return [
      new ContainerBuilder()
        .setAccentColor(statusColor)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("## Painel de compras\n▎ Primeira vez aqui? Veja as [avaliações](https://discord.gg/seu-link)")
        )
        .addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(UI_THEME.LOGO))
        )
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
              "\n**1. Como comprar**\n" +
              "Acesse o [tutorial](https://discord.com/channels/1418035622568005754/1446323283342659685).\n" +
              "Faça o seu pedido clicando no botão abaixo.\n\n" +
              "**2. Informações**\n" +
              "Dúvidas ou erros, contate o [suporte](https://discord.com/channels/1418035622568005754/1446323399944179762).\n" +
              "Valores e Limites veja [clicando aqui](https://discord.com/channels/1418035622568005754/1446323238761267333).\n\n"
            )
        )
        .addActionRowComponents(
          new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Criar carrinho")
             .setEmoji("1460819966826774713")
             .setCustomId("criar_thread_privada")
             .setDisabled(!IS_SHOP_OPEN)
            
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
              new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Ajuda").setCustomId("btn_ajuda")
          )
      );
}

function buildConfirmUserContainer({ usuarioDigitado, robloxUserId, robloxUsername, avatarURL, gameName, quantidadeRobux }) {
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
    
    if (quantidadeRobux) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`**💰 Robux desejados:** ${quantidadeRobux}`));
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

function buildGamepassSelectionContainer({ robloxUsername, robloxUserId, avatarURL, gamepassesAVenda, fallbackManual, quantidadeRobux }) {
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
  
    // Se o usuário especificou uma quantidade de robux, tentar encontrar automaticamente
    let gamepassAutoSelecionada = null;
    if (quantidadeRobux && gamepassesAVenda && gamepassesAVenda.length > 0) {
        gamepassAutoSelecionada = encontrarGamepassPorValor(gamepassesAVenda, parseInt(quantidadeRobux));
    }
    
    if (gamepassAutoSelecionada) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`✅ **Gamepass encontrada automaticamente:**\n**${gamepassAutoSelecionada.name}** - ${gamepassAutoSelecionada.price} Robux`)
        );
    }
  
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
    
    // Se encontrou gamepass automaticamente, mudar o botão para "Usar Gamepass Encontrada"
    if (gamepassAutoSelecionada && !fallbackManual) {
        rowButtons.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Success).setLabel("Usar Gamepass Encontrada").setCustomId("usar_gamepass_automatica"));
    } else if (select && !fallbackManual) {
        rowButtons.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Success).setLabel("Confirmar Seleção").setCustomId("confirmar_gamepasses"));
    }
    
    rowButtons.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("Voltar").setCustomId("voltar_confirmacao_usuario"));
  
    if (fallbackManual) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent("❌ Nenhuma gamepass válida encontrada."));
      container.addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel("Inserir Manualmente").setCustomId("enviar_gamepass_manual")));
    }
    container.addActionRowComponents(rowButtons);
    return container;
}

function buildFinalSummaryContainer({ robloxUsername, robloxUserId, avatarURL, selectedGamepasses }) {
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
    const valorReais = totalReceber * ECONOMY.PRICE_PER_ROBUX;

    return new ContainerBuilder().setAccentColor(UI_THEME.GREEN)
      .addSectionComponents(new SectionBuilder().setThumbnailAccessory(new ThumbnailBuilder().setURL(safeAvatar)).addTextDisplayComponents(new TextDisplayBuilder().setContent(`## Detalhes finais\nUsuário: **${robloxUsername}**`)))
      .addActionRowComponents(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Ver Perfil no Roblox").setURL(`https://www.roblox.com/users/${robloxUserId}/profile`)
        )
      )
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(linhas.join("\n\n")))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`💰 **Total em Robux:** ${totalPriceRobux}\n💵 **Valor a Pagar:** ${formatBRL(valorReais)}`))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent("✅ **Pronto!** Aguarde o atendimento."))
      .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel("⬅ Voltar").setCustomId("voltar_para_selecao_gamepasses"), new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel("Cancelar").setCustomId("btn_cancelar_compra"), new ButtonBuilder().setStyle(ButtonStyle.Success).setLabel("💠 Pagar com PIX").setCustomId("pagar_pix")));
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

// ================================================================
// 🔵 CLIENTE DISCORD (MANTIDO IGUAL)
// ================================================================
client.once(Events.ClientReady, async () => {
  console.log(`Logado como ${client.user.tag}`);
  const commands = [
    { name: "sendcomponents", description: "Envia o painel de compra de Robux" },
    { name: "abrirloja", description: "Abre a loja e permite carrinhos" },
    { name: "fecharloja", description: "Fecha a loja e bloqueia carrinhos" },
  ];
  try {
      console.log("Registrando comandos slash...");
      await client.application.commands.set(commands);
      console.log("✅ Comandos registrados!");
  } catch (error) { console.error("Erro ao registrar comandos:", error); }
});

// SLASH COMMANDS (MANTIDO IGUAL)
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "sendcomponents") {
      const components = buildMainPanelComponents();
      const reply = await interaction.reply({ flags: MessageFlags.IsComponentsV2, components, fetchReply: true });
      MAIN_PANEL_DATA = { channelId: reply.channelId, messageId: reply.id };
      console.log(`Painel registrado em Canal: ${reply.channelId}, Msg: ${reply.id}`);
  }

  if (interaction.commandName === "abrirloja") {
      IS_SHOP_OPEN = true;
      
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
});

// INTERAÇÕES DE BOTÃO (MANTIDO IGUAL COM ADIÇÃO DO NOVO BOTÃO)
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

 if (interaction.customId === "pagar_pix") {
  await interaction.deferUpdate();

  const data = userPurchaseData.get(interaction.user.id);
  if (!data) return;

  const totalRobux = data.selectedGamepasses.reduce(
    (sum, gp) => sum + (gp.price ?? gp.priceInRobux ?? 0),
    0
  );

  const receber = Math.floor(totalRobux * 0.7);
  const valorReais = receber * ECONOMY.PRICE_PER_ROBUX;

  const paymentLink = await createMercadoPagoPayment(
    {
      totalRobux: receber,
      finalPrice: Number(valorReais.toFixed(2))
    },
    interaction.user.id,
    data.threadId,
    Date.now()
  );

  await interaction.followUp({
    content: `💠 **PIX gerado com sucesso!**\n\n👉 Pague aqui:\n${paymentLink}`,
    flags: MessageFlags.Ephemeral
  });

  return;
}


  if (interaction.customId === "btn_ajuda") {
      await interaction.reply({ content: "🔔 Um atendente foi notificado.", flags: MessageFlags.Ephemeral });
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
    const { robloxUserId, avatarURL, robloxUsername, lastMessageId, lastChannelId, quantidadeRobux } = data;
    const gamepasses = await getUserGamepasses(robloxUserId);
    let gamepassesAVenda = [];
    let fallbackManual = false;
    if (gamepasses && gamepasses.length > 0) {
      gamepassesAVenda = gamepasses.filter((gp) => gp.isForSale === true);
      if (!gamepassesAVenda.length) fallbackManual = true;
    } else { fallbackManual = true; }
    data.gamepassesAVenda = gamepassesAVenda;
    const containerBuilder = buildGamepassSelectionContainer({ 
      robloxUsername, 
      robloxUserId, 
      avatarURL, 
      gamepassesAVenda, 
      fallbackManual,
      quantidadeRobux 
    });
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

  // NOVO BOTÃO: USAR GAMEPASS AUTOMÁTICA
  if (interaction.customId === "usar_gamepass_automatica") {
    await interaction.deferUpdate();
    const data = userPurchaseData.get(interaction.user.id);
    if (!data || !data.robloxUserId || !data.quantidadeRobux) return;
    
    const { robloxUserId, avatarURL, robloxUsername, lastMessageId, lastChannelId, quantidadeRobux } = data;
    
    // Buscar gamepasses novamente
    const gamepasses = await getUserGamepasses(robloxUserId);
    let gamepassesAVenda = [];
    if (gamepasses && gamepasses.length > 0) {
      gamepassesAVenda = gamepasses.filter((gp) => gp.isForSale === true);
    }
    
    // Encontrar gamepass pelo valor desejado
    const gamepassEncontrada = encontrarGamepassPorValor(gamepassesAVenda, parseInt(quantidadeRobux));
    
    if (!gamepassEncontrada) {
      // Se não encontrou, mostrar erro
      const errorContainer = buildErrorContainer(`Não foi encontrada uma gamepass de ${quantidadeRobux} Robux à venda.`);
      try {
        const channel = await client.channels.fetch(lastChannelId);
        const message = await channel.messages.fetch(lastMessageId);
        await message.edit({ flags: MessageFlags.IsComponentsV2, components: [errorContainer] });
      } catch (e) { console.error(e); }
      return;
    }
    
    // Se encontrou, prosseguir com essa gamepass
    data.selectedGamepasses = [gamepassEncontrada];
    userPurchaseData.set(interaction.user.id, data);
    
    // Ir direto para o resumo final
    const container = buildFinalSummaryContainer({ 
      robloxUsername: data.robloxUsername, 
      robloxUserId: data.robloxUserId, 
      avatarURL: data.avatarURL, 
      selectedGamepasses: data.selectedGamepasses 
    });
    data.lastContainer = container;
    userPurchaseData.set(interaction.user.id, data);
    
    try {
      const ch = await client.channels.fetch(data.lastChannelId);
      const msg = await ch.messages.fetch(data.lastMessageId);
      await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
    } catch(e) { console.error(e); }
    return;
  }

  if (interaction.customId === "voltar_confirmacao_usuario") {
    const data = userPurchaseData.get(interaction.user.id);
    if (!data) return;
    const container = buildConfirmUserContainer({ 
      usuarioDigitado: data.usuarioDigitado, 
      robloxUserId: data.robloxUserId, 
      robloxUsername: data.robloxUsername, 
      avatarURL: data.avatarURL, 
      gameName: data.gameName,
      quantidadeRobux: data.quantidadeRobux 
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
      
      const container = buildFinalSummaryContainer({ robloxUsername: data.robloxUsername, robloxUserId: data.robloxUserId, avatarURL: data.avatarURL, selectedGamepasses: data.selectedGamepasses });
      data.lastContainer = container;
      userPurchaseData.set(interaction.user.id, data);
      
      try {
        const ch = await client.channels.fetch(data.lastChannelId);
        const msg = await ch.messages.fetch(data.lastMessageId);
        await msg.edit({ flags: MessageFlags.IsComponentsV2, components: [container] });
        await interaction.deferUpdate();
      } catch(e) {}
  }
});

// MODIFICADO: AGORA O MODAL PERGUNTA QUANTOS ROBUX O USUÁRIO QUER
async function openPurchaseForm(interaction) {
  const modal = new ModalBuilder().setCustomId("modal_compra").setTitle("Informações da compra");
  
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
  
  modal.addComponents(
    new ActionRowBuilder().addComponents(robloxUser),
    new ActionRowBuilder().addComponents(quantidadeRobux)
  );
  
  await interaction.showModal(modal);
}

// SUBMIT MODAL - USUÁRIO (MODIFICADO PARA LER A QUANTIDADE DE ROBUX)
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isModalSubmit() && interaction.customId === "modal_compra") {
    await interaction.deferUpdate();
    const usuario = interaction.fields.getTextInputValue("robloxUser");
    const quantidadeRobux = interaction.fields.getTextInputValue("quantidadeRobux");
    const saved = userPurchaseData.get(interaction.user.id);
    const sendError = async (msg) => {
        if (saved?.lastMessageId && saved?.lastChannelId) {
            const ch = await client.channels.fetch(saved.lastChannelId);
            const m = await ch.messages.fetch(saved.lastMessageId);
            await m.edit({ flags: MessageFlags.IsComponentsV2, components: [buildErrorContainer(msg)] });
        }
    };

    // Validar quantidade de robux
    const qtdRobuxNum = parseInt(quantidadeRobux);
    if (isNaN(qtdRobuxNum) || qtdRobuxNum < 1) {
      await sendError("Por favor, insira uma quantidade válida de Robux (número maior que 0).");
      return;
    }

    const robloxUser = await getRobloxUser(usuario);
    if (!robloxUser) { 
      await sendError(`O usuário **${usuario}** não foi encontrado.`); 
      return; 
    }

    const userGames = await getUserGames(robloxUser.id);
    const gameName = userGames.length > 0 ? userGames[0].name : null;
    const avatarURL = await getRobloxAvatar(robloxUser.id);

    const newData = { 
      ...saved, 
      usuarioDigitado: usuario, 
      robloxUserId: robloxUser.id, 
      robloxUsername: robloxUser.name, 
      avatarURL, 
      gameName, 
      quantidadeRobux: qtdRobuxNum,
      selectedGamepasses: [], 
      lastChannelId: saved.lastChannelId, 
      lastMessageId: saved.lastMessageId, 
      threadId: saved.threadId 
    };
    userPurchaseData.set(interaction.user.id, newData);

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
const app = express();
app.use(express.json());

app.post("/mercadopago-webhook", async (req, res) => {
  try {
    const paymentId = req.body?.data?.id;
    if (!paymentId) return res.sendStatus(200);

    const payment = await paymentClient.get({ id: paymentId });

    if (payment.status === "approved") {
      const ref = JSON.parse(payment.external_reference || "{}");

      console.log("✅ PAGAMENTO APROVADO:", ref);
      // aqui depois você entrega robux automaticamente
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook erro:", err);
    res.sendStatus(500);
  }
});

app.listen(3000, () => {
  console.log("🌐 Webhook Mercado Pago rodando na porta 3000");
});

client.login(TOKEN);
