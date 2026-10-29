import { Decimal } from "decimal.js";
import { z } from "zod";
import { feeTables, safeAmount } from "./models.js";

export function estimateWithdrawal(tables: unknown, provider: string, amount: number): { estimate: string; authoritative: false } {
  const fees = feeTables.parse(tables);
  const key = z.enum(["mtn_mobile_money", "orange_money"]).parse(provider);
  safeAmount.positive().parse(amount);
  const matches = fees[key].filter(row => amount >= row.amount_range.min && amount <= row.amount_range.max);
  if (matches.length !== 1) throw new Error("Fee is unknown: expected exactly one matching amount bracket");
  const row = matches[0]!;
  const fee = row.fee.unit === "currency"
    ? new Decimal(row.fee.value) : new Decimal(amount).times(row.fee.value).dividedBy(100);
  return { estimate: fee.toFixed(), authoritative: false };
}
