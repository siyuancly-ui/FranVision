'use strict';
// Minimal Wave GraphQL client (Node 18+ fetch, no dependencies). fetch/sleep are injectable for tests.
//
// Retry policy (deliberate): reads retry on 429/5xx/network errors. Mutations retry ONLY on 429,
// where Wave rejected the request outright. A network error or 5xx on invoiceCreate may mean the
// invoice WAS created, so retrying could make a duplicate; those surface as errors for the caller
// (which should look the invoice up before trying again).

const ENDPOINT = 'https://gql.waveapps.com/graphql/public';

class WaveError extends Error {
  constructor(message, extra) { super(message); this.name = 'WaveError'; Object.assign(this, extra); }
}

function createWaveClient({ token, businessId, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxAttempts = 3, endpoint = ENDPOINT }) {
  if (!token) throw new Error('WAVE token missing');
  if (!businessId) throw new Error('businessId missing');

  async function gql(query, variables, { mutation = false } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables }),
        });
      } catch (e) {
        lastErr = new WaveError('network error: ' + e.message, { retryable: !mutation });
        if (mutation) throw lastErr;
        await sleep(300 * 2 ** (attempt - 1));
        continue;
      }
      const body = await res.json().catch(() => ({}));
      if (res.status === 429 || (res.status >= 500 && !mutation)) {
        lastErr = new WaveError('HTTP ' + res.status, { status: res.status });
        await sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      if (res.status >= 500) throw new WaveError('HTTP ' + res.status + ' on a mutation; outcome unknown, check Wave before retrying', { status: res.status, outcomeUnknown: true });
      if (!res.ok || body.errors) {
        throw new WaveError((body.errors || []).map((e) => e.message).join('; ') || 'HTTP ' + res.status, { status: res.status, errors: body.errors });
      }
      return body.data;
    }
    throw lastErr;
  }

  function mustSucceed(m, what) {
    if (!m || !m.didSucceed) throw new WaveError(what + ' failed: ' + JSON.stringify(m && m.inputErrors), { inputErrors: m && m.inputErrors });
    return m;
  }

  const INVOICE_FIELDS = 'id status invoiceNumber viewUrl total{ value } amountDue{ value }';
  const shape = (inv) => inv && ({
    id: inv.id, status: inv.status, invoiceNumber: inv.invoiceNumber, viewUrl: inv.viewUrl,
    totalDecimal: inv.total && inv.total.value, amountDueDecimal: inv.amountDue && inv.amountDue.value,
  });

  return {
    gql,

    // `input` comes from buildInvoiceRequest; businessId is checked so a request built for another business can't slip through.
    async createDraftInvoice(input) {
      if (input.businessId !== businessId) throw new Error('invoice input businessId does not match this client');
      const d = await gql(`mutation($i:InvoiceCreateInput!){ invoiceCreate(input:$i){ didSucceed inputErrors{ message path } invoice{ ${INVOICE_FIELDS} } } }`, { i: input }, { mutation: true });
      return shape(mustSucceed(d.invoiceCreate, 'invoiceCreate').invoice);
    },

    async approveInvoice(invoiceId) {
      const d = await gql(`mutation($i:InvoiceApproveInput!){ invoiceApprove(input:$i){ didSucceed inputErrors{ message } invoice{ ${INVOICE_FIELDS} } } }`, { i: { invoiceId } }, { mutation: true });
      return shape(mustSucceed(d.invoiceApprove, 'invoiceApprove').invoice);
    },

    async getInvoice(invoiceId) {
      const d = await gql(`query($b:ID!,$i:ID!){ business(id:$b){ invoice(id:$i){ ${INVOICE_FIELDS} } } }`, { b: businessId, i: invoiceId });
      return shape(d.business.invoice);
    },

    async deleteInvoice(invoiceId) {
      const d = await gql('mutation($i:InvoiceDeleteInput!){ invoiceDelete(input:$i){ didSucceed inputErrors{ message } } }', { i: { invoiceId } }, { mutation: true });
      mustSucceed(d.invoiceDelete, 'invoiceDelete');
    },

    async createCustomer({ name, email }) {
      const i = { businessId, name, ...(email ? { email } : {}) };
      const d = await gql('mutation($i:CustomerCreateInput!){ customerCreate(input:$i){ didSucceed inputErrors{ message } customer{ id name } } }', { i }, { mutation: true });
      return mustSucceed(d.customerCreate, 'customerCreate').customer;
    },

    async listProducts() {
      const out = [];
      for (let page = 1; ; page++) {
        const d = await gql('query($b:ID!,$p:Int!){ business(id:$b){ products(page:$p,pageSize:100){ pageInfo{ totalPages } edges{ node{ id name unitPrice isArchived } } } } }', { b: businessId, p: page });
        const c = d.business.products;
        c.edges.forEach((e) => out.push(e.node));
        if (page >= c.pageInfo.totalPages) return out;
      }
    },

    async findHstTaxId() {
      const d = await gql('query($b:ID!){ business(id:$b){ salesTaxes(page:1,pageSize:50){ edges{ node{ id name rate } } } } }', { b: businessId });
      const hst = d.business.salesTaxes.edges.map((e) => e.node).filter((t) => /HST/i.test(t.name));
      if (hst.length !== 1) throw new WaveError('expected exactly one HST tax, found ' + hst.length);
      return hst[0].id;
    },
  };
}

module.exports = { createWaveClient, WaveError, ENDPOINT };
