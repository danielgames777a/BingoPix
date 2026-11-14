const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CARD_PRICE_CENTS,
  DEPOSIT_MIN_CENTS,
  DEPOSIT_MAX_CENTS,
  FIRST_DEPOSIT_BONUS_CENTS,
  NORMAL_PRIZE_CAP_CENTS,
  SPECIAL_PRIZE_CAP_CENTS,
  ensureWallet,
  totalWalletCents,
  spendForCards,
  splitPrizePool,
  randomRoundPoolCents,
} = require('./finance');

test('carteira inicia em zero e mantém bônus separado do saldo sacável', () => {
  const user = {};
  ensureWallet(user);
  assert.equal(user.cashCents, 0);
  assert.equal(user.bonusCents, 0);
  assert.equal(totalWalletCents(user), 0);
});

test('parâmetros financeiros correspondem às regras definidas', () => {
  assert.equal(CARD_PRICE_CENTS, 20);
  assert.equal(DEPOSIT_MIN_CENTS, 500);
  assert.equal(DEPOSIT_MAX_CENTS, 5000);
  assert.equal(FIRST_DEPOSIT_BONUS_CENTS, 4000);
});

test('compras consomem o bônus antes do saldo sacável', () => {
  const user = { cashCents: 1000, bonusCents: 2000 };
  const first = spendForCards(user, 1500);
  assert.deepEqual(first, { bonusUsedCents: 1500, cashUsedCents: 0 });
  assert.equal(user.bonusCents, 500);
  assert.equal(user.cashCents, 1000);

  const second = spendForCards(user, 1500);
  assert.deepEqual(second, { bonusUsedCents: 500, cashUsedCents: 1000 });
  assert.equal(user.bonusCents, 0);
  assert.equal(user.cashCents, 0);
});

test('compra acima do saldo disponível é rejeitada sem alterar a carteira', () => {
  const user = { cashCents: 20, bonusCents: 10 };
  assert.throws(() => spendForCards(user, 31), /Saldo insuficiente/);
  assert.equal(user.cashCents, 20);
  assert.equal(user.bonusCents, 10);
});

test('divisão de prêmios preserva exatamente o total em centavos', () => {
  const split = splitPrizePool(10001);
  assert.deepEqual(split, { quadra: 1500, quina: 2500, bingo: 6001 });
  assert.equal(split.quadra + split.quina + split.bingo, 10001);
});

test('valores aleatórios respeitam os limites normal e especial', () => {
  assert.equal(randomRoundPoolCents(false, (min) => min), 1);
  assert.equal(randomRoundPoolCents(false, (_min, max) => max - 1), NORMAL_PRIZE_CAP_CENTS);
  assert.equal(randomRoundPoolCents(true, (_min, max) => max - 1), SPECIAL_PRIZE_CAP_CENTS);
});
