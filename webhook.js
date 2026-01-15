import express from "express";
import { atualizarStatus } from "./database.js";

const app = express();
app.use(express.json());

app.post("/webhook", async (req, res) => {
  const pagamentoId = req.body.data?.id;

  if (!pagamentoId) return res.sendStatus(200);

  // Aqui você buscaria no Mercado Pago se está aprovado
  await atualizarStatus(pagamentoId, "Pago");

  res.sendStatus(200);
});

app.listen(3000, () => {
  console.log("Webhook rodando na porta 3000");
});
