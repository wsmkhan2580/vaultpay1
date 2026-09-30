// In-memory fakes so the REAL service code (receiptService, pdfService, webhookService, money) runs offline.
/* eslint-disable */
const Module = require('module');
const path = require('path');
const { EventEmitter } = require('events');

export const SRC = process.env.SRC || path.resolve(__dirname, '../../src');

// ---------- tiny in-memory "mongoose" ----------
class FakeQuery {
  constructor(private run: () => any) {}
  session() { return this; }
  sort(spec?: any) { (this as any)._sort = spec; return this; }
  select() { return this; }
  then(res: any, rej: any) { return Promise.resolve().then(() => this.finish()).then(res, rej); }
  catch(rej: any) { return this.then(undefined, rej); }
  private finish() {
    let r = this.run();
    const s = (this as any)._sort;
    if (Array.isArray(r) && s) {
      const [k, dir] = Object.entries(s)[0] as [string, number];
      r = [...r].sort((a: any, b: any) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (dir as number));
    } else if (s && r == null) { /* findOne */ }
    return r;
  }
}
function matches(doc: any, q: any) {
  return Object.entries(q).every(([k, v]) => {
    if (v === null) return doc[k] === null || doc[k] === undefined;
    return String(doc[k]) === String(v);
  });
}
let idSeq = BigInt('0x64b2c3d4e5f6a1b2c3d4e5');
export const newId = () => (idSeq++).toString(16).padStart(24, '0');

export function makeCollection(name: string, uniques: string[] = []) {
  const docs: any[] = [];
  const api: any = {
    name, docs,
    seed(d: any) { const doc = { _id: newId(), ...d }; docs.push(doc); return doc; },
    findOne: (q: any) => new FakeQuery(() => docs.find((d) => matches(d, q)) ?? null),
    findById: (id: any) => new FakeQuery(() => docs.find((d) => String(d._id) === String(id)) ?? null),
    find: (q: any) => new FakeQuery(() => docs.filter((d) => matches(d, q))),
    async create(d: any) {
      for (const u of uniques) {
        if (docs.some((x) => x[u] !== undefined && String(x[u]) === String(d[u]))) {
          const e: any = new Error('E11000 duplicate key'); e.code = 11000; throw e;
        }
      }
      const doc = { _id: newId(), emailSentAt: null, ...d };
      docs.push(doc);
      return doc;
    },
    findOneAndUpdate: (q: any, upd: any) => new FakeQuery(() => {
      const d = docs.find((x) => matches(x, q));
      if (!d) return null;
      const before = { ...d };
      Object.assign(d, upd.$set || {});
      return before; // mongoose default: returns the document BEFORE the update
    }),
    updateOne: (q: any, upd: any) => new FakeQuery(() => {
      const d = docs.find((x) => matches(x, q));
      if (d) Object.assign(d, upd.$set || {});
      return { matchedCount: d ? 1 : 0 };
    }),
    deleteOne: (q: any) => new FakeQuery(() => {
      const i = docs.findIndex((x) => matches(x, q));
      if (i >= 0) docs.splice(i, 1);
      return { deletedCount: i >= 0 ? 1 : 0 };
    }),
  };
  return api;
}

// ---------- fake pdfkit that records layout ----------
export const pdfLog = { pages: 1, texts: [] as any[], violations: [] as string[], fonts: [] as string[] };
export function resetPdfLog() { pdfLog.pages = 1; pdfLog.texts = []; pdfLog.violations = []; pdfLog.fonts = []; }
class FakeDoc extends EventEmitter {
  page = { width: 595.28, height: 841.89 };
  private size = 12;
  constructor(public opts: any) { super(); }
  font(f: string) { pdfLog.fonts.push(f); return this; }
  fontSize(n: number) { this.size = n; return this; }
  fillColor() { return this; } strokeColor() { return this; } lineWidth() { return this; }
  moveTo() { return this; } lineTo() { return this; } stroke() { return this; }
  roundedRect() { return this; } save() { return this; } restore() { return this; }
  rotate() { return this; } opacity() { return this; } registerFont() { return this; }
  addPage() { pdfLog.pages++; return this; }
  heightOfString(s: string, o: any) {
    const w = (o && o.width) || 483;
    const perLine = Math.max(1, Math.floor(w / (this.size * 0.5)));
    const lines = String(s).split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
    return lines * this.size * 1.15;
  }
  text(s: string, x: number, y: number, o: any = {}) {
    const h = this.heightOfString(s, o);
    const page = pdfLog.pages;
    pdfLog.texts.push({ s: String(s), x, y, page, size: this.size });
    if (y + h > this.page.height - 56 + 0.5) pdfLog.violations.push(`text "${String(s).slice(0, 25)}" ends at ${(y + h).toFixed(0)} > ${(this.page.height - 56).toFixed(0)} on page ${page}`);
    return this;
  }
  end() { setImmediate(() => { this.emit('data', Buffer.from('%PDF-1.4 fake')); this.emit('end'); }); }
}

// ---------- module interception ----------
export const calls = { emails: [] as any[], uploads: [] as any[], audits: [] as any[] };
export const state = { emailOk: true, uploadOk: true, emailDelayMs: 0 };
export const cols = {
  Receipt: makeCollection('Receipt', ['paymentId', 'receiptNumber']),
  Invoice: makeCollection('Invoice'), Payment: makeCollection('Payment'), Client: makeCollection('Client'),
  Processed: makeCollection('ProcessedWebhookEvent', ['stripeEventId']),
};
export const sessionsExpired: string[] = [];
const mocks: Record<string, any> = {
  '../models/Receipt': { Receipt: cols.Receipt },
  '../models/Invoice': { Invoice: cols.Invoice },
  '../models/Payment': { Payment: cols.Payment },
  '../models/Client': { Client: cols.Client },
  '../models/ProcessedWebhookEvent': { ProcessedWebhookEvent: cols.Processed },
  './storageService': {
    uploadReceiptPdf: async (_b: Buffer, key: string) => { if (!state.uploadOk) throw new Error('S3 down'); calls.uploads.push(key); return { storageKey: key, provider: 'S3' }; },
    getSignedDownloadUrl: () => 'https://signed',
  },
  './emailService': {
    sendReceiptEmail: async (_c: any, _i: any, num: string) => { if (state.emailDelayMs) await new Promise((r) => setTimeout(r, state.emailDelayMs)); if (state.emailOk) calls.emails.push({ type: 'receipt', num }); return state.emailOk; },
    sendPaymentConfirmationEmail: async () => { calls.emails.push({ type: 'confirm' }); return true; },
  },
  './auditService': { recordAudit: async (e: any) => { calls.audits.push(e.action); } },
  'pdfkit': FakeDoc,
  'mongoose': { startSession: async () => ({ withTransaction: async (fn: any) => fn(), endSession: async () => {} }) },
  '../utils/logger': { logger: { info() {}, warn() {}, error() {}, debug() {} } },
};
const origLoad = Module._load;
Module._load = function (request: string, parent: any, isMain: boolean) {
  if (request in mocks) {
    const m = mocks[request];
    return request === 'pdfkit' ? { __esModule: true, default: m } : m;
  }
  return origLoad.apply(this, arguments);
};
export const req = (rel: string) => require(path.join(SRC, rel));
export const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
