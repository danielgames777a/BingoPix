const crypto = require('node:crypto');

const CARD_PRICE_CENTS = 20;
const DEPOSIT_MIN_CENTS = 500;
const DEPOSIT_MAX_CENTS = 5000;
const FIRST_DEPOSIT_BONUS_CENTS = 4000;
const NORMAL_PRIZE_CAP_CENTS = 30000;
const SPECIAL_PRIZE_CAP_CENTS = 50000;
const PRIZE_SPLIT = Object.freeze({ quadra: 0.15, quina: 0.25, bingo: 0.60 });

function ensureWallet(user) {
  if (!Number.isSafeInteger(user.cashCents) || user.cashCents < 0) user.cashCents = 0;
  if (!Number.isSafeInteger(user.bonusCents) || user.bonusCents < 0) user.bonusCents = 0;
  if (typeof user.firstDepositBonusGranted !== 'boolean') user.firstDepositBonusGranted = false;
  return user;
}

function totalWalletCents(user) {
  ensureWallet(user);
  return user.cashCents + user.bonusCents;
}

function spendForCards(user, amountCents) {
  ensureWallet(user);
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error('Valor da compra inválido.');
  }
  if (totalWalletCents(user) < amountCents) {
    throw new Error('Saldo insuficiente. Faça um depósito de teste para continuar.');
  }

  // O bônus é consumido primeiro para preservar o saldo sacável.
  const bonusUsedCents = Math.min(user.bonusCents, amountCents);
  const cashUsedCents = amountCents - bonusUsedCents;
  user.bonusCents -= bonusUsedCents;
  user.cashCents -= cashUsedCents;
  return { bonusUsedCents, cashUsedCents };
}

function splitPrizePool(totalCents) {
  if (!Number.isSafeInteger(totalCents) || totalCents < 0) {
    throw new Error('Valor do prêmio inválido.');
  }
  const quadra = Math.floor(totalCents * PRIZE_SPLIT.quadra);
  const quina = Math.floor(totalCents * PRIZE_SPLIT.quina);
  return { quadra, quina, bingo: totalCents - quadra - quina };
}

function randomRoundPoolCents(special, randomInt = crypto.randomInt) {
  const cap = special ? SPECIAL_PRIZE_CAP_CENTS : NORMAL_PRIZE_CAP_CENTS;
  return randomInt(1, cap + 1);
}

module.exports = {
  CARD_PRICE_CENTS,
  DEPOSIT_MIN_CENTS,
  DEPOSIT_MAX_CENTS,
  FIRST_DEPOSIT_BONUS_CENTS,
  NORMAL_PRIZE_CAP_CENTS,
  SPECIAL_PRIZE_CAP_CENTS,
  PRIZE_SPLIT,
  ensureWallet,
  totalWalletCents,
  spendForCards,
  splitPrizePool,
  randomRoundPoolCents,
};
