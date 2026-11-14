# BingoPix — protótipo em modo de teste

Bingo online de 90 bolas com carteira e valores exibidos em reais. **Esta versão é estritamente simulada:** não se conecta à InfinitePay, não inicia cobranças e não realiza saques ou pagamentos. O saldo, os depósitos, as compras, os sorteios e os prêmios são fictícios. Não informe uma chave Pix real.

Cada cartela custa R$ 0,20. O depósito de teste aceita valores de R$ 5,00 a R$ 50,00. Após a primeira confirmação simulada, a conta recebe uma única vez R$ 40,00 de bônus, separado do saldo sacável e utilizável somente para comprar cartelas. O prêmio total é sorteado por rodada com limite de R$ 300,00 (normal) ou R$ 500,00 (especial), dividido entre Quadra (15%), Quina (25%) e Bingo (60%). Solicitações de saque e revisão administrativa também são somente simulações.

## Executar localmente

Use Node.js 18 ou superior:

```sh
npm install
npm test
npm start
```

O servidor usa a porta indicada por `PORT` (padrão `3000`) e armazena dados locais de teste em `data/db.json`, que não é versionado. Rodadas ocorrem a cada cinco minutos por padrão (`ROUND_MIN`); `DRAW_MS` controla o intervalo entre bolas.

Para habilitar o painel administrativo de teste, defina `ADMIN_USER` como o nome de usuário já cadastrado que deve acessar a revisão. Sem essa variável, o painel permanece bloqueado. Defina `JWT_SECRET` como segredo aleatório em qualquer implantação de teste persistente. Não coloque chaves da InfinitePay, chaves Pix ou outros segredos no repositório, no navegador ou em arquivos commitados.

## Pagamentos

A confirmação de depósito é um botão de simulação local. Esta versão não chama endpoints reais da InfinitePay; a documentação consultada não apresentou um ambiente de sandbox de pagamentos. Uma futura integração real precisará ser implementada e validada separadamente, com credencial nova configurada como secret no servidor e com os requisitos legais e do provedor verificados. A chave que foi compartilhada anteriormente no chat deve ser revogada e substituída antes de qualquer uso real.
