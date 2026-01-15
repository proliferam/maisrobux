import express from "express";
import cors from "cors";
import { criarPagamento } from "./mercadopago.js";
import { criarPedido } from "./database.js";

const app = express();
app.use(cors());
app.use(express.json());

app.post("/criar-pagamento", async (req, res) => {
  const { valor, descricao } = req.body;

  const pagamento = await criarPagamento(valor, descricao);

  await criarPedido({
    pagamentoId: pagamento.id,
    valor,
    status: "Pendente"
  });

  res.json(pagamento);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 API rodando");
});
