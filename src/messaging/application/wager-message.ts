import { plainToInstance, Type } from "class-transformer";
import {
  IsIn,
  IsISO8601,
  IsObject,
  IsString,
  Matches,
  ValidateNested,
  validate,
} from "class-validator";
import { WagerTransactionDto } from "../../wagering/http/dtos";

export class WagerMessageData extends WagerTransactionDto {
  @IsString()
  @Matches(/^[ -~]{1,255}$/)
  idempotencyKey!: string;
}

export class WagerMessage {
  @IsString()
  @Matches(/^[!-~]{1,128}$/)
  messageId!: string;

  @IsIn(["WagerTransactionRequested"])
  type!: "WagerTransactionRequested";

  @IsString()
  @IsISO8601({ strict: true })
  occurredAt!: string;

  @IsObject()
  @ValidateNested()
  @Type(() => WagerMessageData)
  data!: WagerMessageData;
}

export class InvalidWagerMessage extends Error {
  constructor(readonly reason: "INVALID_JSON" | "INVALID_MESSAGE") {
    super(reason);
  }
}

export async function parseWagerMessage(body: string): Promise<WagerMessage> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new InvalidWagerMessage("INVALID_JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InvalidWagerMessage("INVALID_MESSAGE");
  const message = plainToInstance(WagerMessage, value);
  const errors = await validate(message, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
  });
  if (errors.length) throw new InvalidWagerMessage("INVALID_MESSAGE");
  return message;
}
