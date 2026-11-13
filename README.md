# BingoPix (versão de teste)

Bingo online de 90 bolas com **fichas de brincadeira**. Não tem Pix, depósito, saque nem prêmio em dinheiro.

- Login e cadastro, 1.000 fichas de boas-vindas
- Rodadas automáticas, cartelas de 15 números (3x5)
- Prêmios em fichas: Quadra, Quina e Cartela cheia (Bingo)
- Sorteio ao vivo com socket.io, marcação automática, chat

Rodar: `npm install && npm start` (porta `PORT`, padrão 3000).

Variáveis opcionais: `JWT_SECRET`, `ROUND_GAP` (segundos entre rodadas, padrão 60), `DRAW_MS` (ms entre bolas, padrão 2500), `CARD_PRICE` (padrão 10), `BOTS` (cartelas de bots por rodada, padrão 12).
