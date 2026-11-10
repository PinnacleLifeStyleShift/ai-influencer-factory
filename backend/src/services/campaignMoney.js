import { ApiError } from "../lib/errors.js";
import { usdToMicros } from "./spendLedger.js";

/**
 * Campaign money in three separate states (brief section 10):
 *  - planned:  the payout offered in the campaign (a plan, not income)
 *  - invoiced: invoices actually issued (voided ones excluded)
 *  - received: cash actually received, with a reference and evidence
 *              (reversed ones excluded)
 * WHY separate: a planned payout is not money, and an invoice is not cash.
 * Nothing is "earned" until it is received, and no amount is attributed to
 * posts or metrics. Records are voided or reversed, never deleted.
 */
const CUR = /^[A-Z]{3}$/;
const invalid = (fields) => new ApiError("VALIDATION_FAILED", 400, "Money record is invalid", { fields });
const time = (v) => { const d = typeof v === "string" ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };
const amount = (v) => { const m = usdToMicros(v); return m === null || m <= 0 ? null : m; };

async function campaignOr404(prisma, id) {
  const c = await prisma.campaign.findUnique({ where: { id } });
  if (!c) throw new ApiError("NOT_FOUND", 404, "Campaign not found");
  return c;
}

export async function recordInvoice(prisma, campaignId, body, { by, now = new Date() }) {
  await campaignOr404(prisma, campaignId);
  const fields = {};
  const micros = amount(body?.amount);
  if (micros === null) fields.amount = "must be a positive amount (up to 6 decimals)";
  if (!CUR.test(body?.currency || "")) fields.currency = "must be an ISO currency code, e.g. USD";
  if (typeof body?.number !== "string" || !body.number.trim() || body.number.length > 64) fields.number = "is required (the invoice number)";
  const issuedAt = time(body?.issuedAt);
  if (!issuedAt || issuedAt > now) fields.issuedAt = "is required and cannot be in the future";
  const dueAt = body?.dueAt === undefined || body?.dueAt === null ? null : time(body.dueAt);
  if (body?.dueAt && !dueAt) fields.dueAt = "must be a date";
  if (Object.keys(fields).length) throw invalid(fields);
  try {
    return await prisma.campaignInvoice.create({ data: { campaignId, number: body.number.trim(), amountMicros: BigInt(micros), currency: body.currency, issuedAt, dueAt, recordedBy: by } });
  } catch (err) {
    if (err?.code === "P2002") throw new ApiError("DUPLICATE_INVOICE", 409, `Invoice ${body.number} is already recorded for this campaign`);
    throw err;
  }
}

export async function voidInvoice(prisma, campaignId, invoiceId, reason, { by }) {
  if (typeof reason !== "string" || reason.trim().length < 3) throw invalid({ reason: "is required" });
  const inv = await prisma.campaignInvoice.findFirst({ where: { id: invoiceId, campaignId }, include: { receipts: true } });
  if (!inv) throw new ApiError("NOT_FOUND", 404, "Invoice not found");
  if (inv.receipts.some((r) => !r.reversedAt)) throw new ApiError("INVOICE_HAS_RECEIPTS", 409, "Reverse the receipts recorded against this invoice first");
  const { count } = await prisma.campaignInvoice.updateMany({ where: { id: inv.id, voidedAt: null }, data: { voidedAt: new Date(), voidReason: `${reason.trim()} (by ${by})` } });
  if (count !== 1) throw new ApiError("ALREADY_VOIDED", 409, "This invoice is already void");
  return prisma.campaignInvoice.findUnique({ where: { id: inv.id } });
}

export async function recordReceipt(prisma, campaignId, body, { by, now = new Date() }) {
  await campaignOr404(prisma, campaignId);
  const fields = {};
  const micros = amount(body?.amount);
  if (micros === null) fields.amount = "must be a positive amount (up to 6 decimals)";
  if (!CUR.test(body?.currency || "")) fields.currency = "must be an ISO currency code";
  const receivedAt = time(body?.receivedAt);
  if (!receivedAt || receivedAt > now) fields.receivedAt = "is required and cannot be in the future";
  if (typeof body?.reference !== "string" || body.reference.trim().length < 3 || body.reference.length > 200) fields.reference = "is required (bank or payment reference)";
  if (typeof body?.evidence !== "string" || body.evidence.trim().length < 10 || body.evidence.length > 2000) fields.evidence = "is required: where the payment can be seen (10+ characters)";
  if (Object.keys(fields).length) throw invalid(fields);
  let invoiceId = null;
  if (body.invoiceId) {
    const inv = await prisma.campaignInvoice.findFirst({ where: { id: body.invoiceId, campaignId } });
    if (!inv) throw new ApiError("NOT_FOUND", 404, "Invoice not found for this campaign");
    if (inv.voidedAt) throw new ApiError("INVOICE_VOID", 409, "That invoice is void");
    if (inv.currency !== body.currency) throw invalid({ currency: `must match the invoice currency (${inv.currency})` });
    invoiceId = inv.id;
  }
  return prisma.campaignReceipt.create({ data: {
    campaignId, invoiceId, amountMicros: BigInt(micros), currency: body.currency, receivedAt,
    reference: body.reference.trim(), evidence: body.evidence.trim(), recordedBy: by,
  } });
}

export async function reverseReceipt(prisma, campaignId, receiptId, reason, { by }) {
  if (typeof reason !== "string" || reason.trim().length < 3) throw invalid({ reason: "is required" });
  const r = await prisma.campaignReceipt.findFirst({ where: { id: receiptId, campaignId } });
  if (!r) throw new ApiError("NOT_FOUND", 404, "Receipt not found");
  const { count } = await prisma.campaignReceipt.updateMany({ where: { id: r.id, reversedAt: null }, data: { reversedAt: new Date(), reverseReason: `${reason.trim()} (by ${by})` } });
  if (count !== 1) throw new ApiError("ALREADY_REVERSED", 409, "This receipt is already reversed");
  return prisma.campaignReceipt.findUnique({ where: { id: r.id } });
}

const n = (b) => Number(b);

/** Planned / invoiced / received / outstanding per currency for some campaigns. */
export function moneySummary(campaigns) {
  const by = {};
  const bucket = (cur) => (by[cur] ||= { plannedMicros: 0, invoicedMicros: 0, receivedMicros: 0, outstandingMicros: 0, overpaidMicros: 0 });
  for (const c of campaigns) {
    const planned = usdToMicros(c.payoutAmount ?? "");
    if (planned) bucket(c.currency || "USD").plannedMicros += planned;
    for (const i of c.invoices || []) {
      if (i.voidedAt) continue;
      const b = bucket(i.currency);
      b.invoicedMicros += n(i.amountMicros);
      const paid = (c.receipts || []).filter((r) => r.invoiceId === i.id && !r.reversedAt).reduce((s, r) => s + n(r.amountMicros), 0);
      b.outstandingMicros += Math.max(0, n(i.amountMicros) - paid);
      b.overpaidMicros += Math.max(0, paid - n(i.amountMicros));
    }
    for (const r of c.receipts || []) if (!r.reversedAt) bucket(r.currency).receivedMicros += n(r.amountMicros);
  }
  return by;
}

export async function campaignMoney(prisma, campaignId) {
  const c = await prisma.campaign.findUnique({ where: { id: campaignId }, include: { invoices: { orderBy: { issuedAt: "asc" } }, receipts: { orderBy: { receivedAt: "asc" } } } });
  if (!c) throw new ApiError("NOT_FOUND", 404, "Campaign not found");
  const plain = (r) => ({ ...r, amountMicros: n(r.amountMicros) });
  return {
    campaignId: c.id,
    planned: { amount: c.payoutAmount ?? null, currency: c.currency, note: "Offered payout; a plan, not income" },
    invoices: c.invoices.map(plain),
    receipts: c.receipts.map(plain),
    summary: moneySummary([c]),
  };
}
