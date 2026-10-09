export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export function oppositeDirection(direction: LedgerDirection): LedgerDirection {
  return direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
}
