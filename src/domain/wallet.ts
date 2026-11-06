import { DomainError, Money } from './money';
export type WalletState = {
  id: string;
  playerId: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private current: Money,
    private revision: number,
    readonly createdAt: Date,
    private changedAt: Date,
  ) {}
  static open(p: { id: string; playerId: string; initialBalance: Money; now?: Date }) {
    if (p.initialBalance.isNegative())
      throw new DomainError('NEGATIVE_BALANCE', 'Initial balance cannot be negative');
    const now = p.now ?? new Date();
    return new Wallet(p.id, p.playerId, p.initialBalance.currency, p.initialBalance, 1, now, now);
  }
  static rehydrate(s: WalletState) {
    return new Wallet(
      s.id,
      s.playerId,
      s.balance.currency,
      s.balance,
      s.version,
      s.createdAt,
      s.updatedAt,
    );
  }
  get balance() {
    return this.current;
  }
  get version() {
    return this.revision;
  }
  get updatedAt() {
    return this.changedAt;
  }
  debit(amount: Money, at = new Date()) {
    this.currencyCheck(amount);
    if (amount.isZero()) return;
    if (this.current.isLessThan(amount))
      throw new DomainError('INSUFFICIENT_FUNDS', 'Wallet has insufficient funds');
    this.current = this.current.subtract(amount);
    this.revision += 1;
    this.changedAt = at;
  }
  credit(amount: Money, at = new Date()) {
    this.currencyCheck(amount);
    if (amount.isZero()) return;
    if (amount.isNegative()) throw new DomainError('NEGATIVE_AMOUNT', 'Credit cannot be negative');
    this.current = this.current.add(amount);
    this.revision += 1;
    this.changedAt = at;
  }
  private currencyCheck(m: Money) {
    if (m.currency !== this.currency)
      throw new DomainError('CURRENCY_MISMATCH', 'Wallet currency must match transaction currency');
    if (m.isNegative()) throw new DomainError('NEGATIVE_AMOUNT', 'Movement cannot be negative');
  }
}
