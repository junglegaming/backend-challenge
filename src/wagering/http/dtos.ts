import { Type } from "class-transformer";
import { IsIn, IsObject, IsString, Matches, ValidateIf, ValidateNested } from "class-validator";
import { WagerTransactionKind } from "../domain/wager-transaction";

export class MoneyDto {
  @IsString()
  @Matches(/^(0|[1-9][0-9]{0,15})\.[0-9]{2}$/)
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency!: string;
}

export class OpenWalletDto {
  @IsString()
  @Matches(/^[!-~]{1,128}$/)
  playerId!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}

export class WagerTransactionDto {
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9-]{1,63}$/)
  providerId!: string;

  @IsString()
  @Matches(/^[!-~]{1,128}$/)
  externalTransactionId!: string;

  @IsString()
  @Matches(/^[!-~]{1,128}$/)
  playerId!: string;

  @IsString()
  @Matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  walletId!: string;

  @IsString()
  @Matches(/^[!-~]{1,128}$/)
  roundId!: string;

  @IsString()
  @Matches(/^[!-~]{1,128}$/)
  gameId!: string;

  @IsIn([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ])
  kind!: WagerTransactionKind;

  @IsObject()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(/^[!-~]{1,128}$/)
  referenceExternalTransactionId?: string;
}
