import express from "express";
import cors from "cors";
import { criarPagamentoPix } from "./mercadopago.js";
import { criarPedido } from "./database.js";


const app = express();
app.use(cors());
app.use(express.json());

// Endpoint para criar pagamento
app.post("/criar-pagamento", async (req, res) => {
  try {
    const { valor, descricao, discordId, robloxUser, cupom, afiliadoId } = req.body;

    const pagamento = await criarPagamentoPix({
      valor,
      descricao,
      email: "cliente@discord.com",
      nome: robloxUser || "Cliente",
      externalReference: JSON.stringify({
        discordId,
        robloxUser,
        cupom,
        afiliadoId,
        timestamp: Date.now()
      })
    });

    await criarPedido({
      pagamentoId: pagamento.id,
      discordId,
      robloxUser: robloxUser || "Não informado",
      valor,
      robux: Math.floor((valor / 40) * 700), // Cálculo aproximado
      status: "Pendente",
      cupom,
      afiliadoId
    });

    res.json(pagamento);
  } catch (error) {
    console.error("Erro ao criar pagamento:", error);
    res.status(500).json({ error: "Erro ao criar pagamento" });
  }
});

// Endpoint para verificar status
app.get("/status/:id", async (req, res) => {
  try {
    const { buscarPagamento } = await import("./mercadopago.js");
    const pagamento = await buscarPagamento(req.params.id);
    res.json(pagamento);
  } catch (error) {
    console.error("Erro ao buscar pagamento:", error);
    res.status(500).json({ error: "Erro ao buscar pagamento" });
  }
});

// Endpoint para listar pedidos
app.get("/pedidos/:discordId", async (req, res) => {
  try {
    const { buscarPedidosPorDiscordId } = await import("./database.js");
    const pedidos = await buscarPedidosPorDiscordId(req.params.discordId);
    res.json(pedidos);
  } catch (error) {
    console.error("Erro ao buscar pedidos:", error);
    res.status(500).json({ error: "Erro ao buscar pedidos" });
  }
});

app.listen(process.env.PORT || 3001, () => {
  console.log("🚀 API rodando na porta", process.env.PORT || 3001);
});
