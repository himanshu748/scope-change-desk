const LIMIT = Number.MAX_SAFE_INTEGER;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

function fail(message) {
  throw new Error(message);
}

function object(value, name, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`Unsupported ${name} field: ${key}`);
}

function text(value, name, maximum = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    fail(`${name} must be nonempty text of at most ${maximum} characters without unsupported control characters.`);
  }
  return value;
}

function id(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) fail(`${name} must be a simple identifier of at most 80 characters.`);
}

function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${name} must be a safe integer of at least ${minimum}.`);
}

function checked(value, name) {
  if (value < -BigInt(LIMIT) || value > BigInt(LIMIT)) fail(`${name} exceeds safe integer limits.`);
  return Number(value);
}

function amount(quantity, rate) {
  return checked(BigInt(quantity) * BigInt(rate), 'Line amount');
}

function sum(values) {
  return checked(values.reduce((total, value) => total + BigInt(value), 0n), 'Quote total');
}

function list(value, name, minimum = 0, maximum = 100) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(`${name} must contain ${minimum}–${maximum} entries.`);
}

export function validateQuote(quote) {
  object(quote, 'quote', ['version', 'id', 'currency', 'minorUnitDigits', 'items', 'agreedDeadline']);
  if (quote.version !== 1) fail('Quote version must be 1.');
  id(quote.id, 'Quote ID');
  if (typeof quote.currency !== 'string' || !/^[A-Z]{3}$/.test(quote.currency)) fail('Currency must be an explicit three-letter uppercase code.');
  integer(quote.minorUnitDigits, 'Minor-unit decimal digits');
  if (quote.minorUnitDigits > 3) fail('Minor-unit decimal digits must be between 0 and 3.');
  list(quote.items, 'Quote items', 1);
  const seen = new Set();
  for (const item of quote.items) {
    object(item, 'quote item', ['id', 'description', 'quantity', 'unitRateMinor', 'rateApprovalRef']);
    id(item.id, 'Item ID');
    if (seen.has(item.id)) fail(`Duplicate quote item ID: ${item.id}`);
    seen.add(item.id);
    text(item.description, 'Item description', 500);
    integer(item.quantity, 'Quantity', 1);
    integer(item.unitRateMinor, 'Unit rate');
    text(item.rateApprovalRef, 'Provided rate approval reference');
    amount(item.quantity, item.unitRateMinor);
  }
  if (quote.agreedDeadline !== undefined) {
    object(quote.agreedDeadline, 'agreed deadline', ['text', 'sourceRef']);
    text(quote.agreedDeadline.text, 'Agreed deadline text', 500);
    text(quote.agreedDeadline.sourceRef, 'Agreed deadline source reference');
  }
}

function validateChanges(request, quote) {
  object(request, 'change request', ['version', 'id', 'quoteId', 'changes', 'deadlineQuestions']);
  if (request.version !== 1) fail('Change request version must be 1.');
  id(request.id, 'Change request ID');
  if (request.quoteId !== quote.id) fail('Change request references a different quote.');
  list(request.changes, 'Changes', 1);
  const seen = new Set();
  for (const change of request.changes) {
    object(change, 'change', ['action', 'itemId', 'quantity', 'description', 'unitRateMinor', 'rateApprovalRef', 'pricingQuestion', 'sourceRef']);
    id(change.itemId, 'Changed item ID');
    if (seen.has(change.itemId)) fail(`Only one change per item is supported: ${change.itemId}`);
    seen.add(change.itemId);
    text(change.sourceRef, 'Change source reference');
    if (!['add', 'remove', 'set_quantity'].includes(change.action)) fail('Change action must be add, remove, or set_quantity.');
    const allowed = change.action === 'add'
      ? ['action', 'itemId', 'quantity', 'description', 'unitRateMinor', 'rateApprovalRef', 'pricingQuestion', 'sourceRef']
      : change.action === 'set_quantity' ? ['action', 'itemId', 'quantity', 'sourceRef'] : ['action', 'itemId', 'sourceRef'];
    object(change, `${change.action} change`, allowed);
    if (change.action !== 'remove') integer(change.quantity, 'Changed quantity', 1);
    if (change.action === 'add') {
      text(change.description, 'Added item description', 500);
      if (change.unitRateMinor === null || change.unitRateMinor === undefined) {
        if (change.rateApprovalRef !== undefined && change.rateApprovalRef !== null) fail('An unpriced item cannot have a rate approval reference.');
        text(change.pricingQuestion, 'Unresolved pricing question');
      } else {
        integer(change.unitRateMinor, 'Added unit rate');
        text(change.rateApprovalRef, 'Provided added-rate approval reference');
        if (change.pricingQuestion !== undefined) fail('A priced item cannot also carry an unresolved pricing question.');
        amount(change.quantity, change.unitRateMinor);
      }
    }
  }
  if (request.deadlineQuestions !== undefined) {
    list(request.deadlineQuestions, 'Deadline questions', 0, 20);
    request.deadlineQuestions.forEach((question) => text(question, 'Deadline question'));
  }
}

export function createRevision(quote, request) {
  validateQuote(quote);
  validateChanges(request, quote);
  const originalItems = quote.items.map((item) => ({ ...item, amountMinor: amount(item.quantity, item.unitRateMinor) }));
  const originalTotalMinor = sum(originalItems.map((item) => item.amountMinor));
  const items = new Map(originalItems.map((item) => [item.id, { ...item }]));
  const changes = [];
  for (const change of request.changes) {
    const before = items.get(change.itemId) ?? null;
    if (change.action === 'add' && before) fail(`Cannot add existing item: ${change.itemId}`);
    if (change.action !== 'add' && !before) fail(`Cannot change missing item: ${change.itemId}`);
    let after = null;
    if (change.action === 'remove') items.delete(change.itemId);
    else if (change.action === 'set_quantity') {
      after = { ...before, quantity: change.quantity, amountMinor: amount(change.quantity, before.unitRateMinor) };
      items.set(change.itemId, after);
    } else {
      const unitRateMinor = change.unitRateMinor ?? null;
      after = {
        id: change.itemId, description: change.description, quantity: change.quantity,
        unitRateMinor, amountMinor: unitRateMinor === null ? null : amount(change.quantity, unitRateMinor),
        rateApprovalRef: change.rateApprovalRef ?? null,
        ...(unitRateMinor === null ? { pricingQuestion: change.pricingQuestion } : {}),
      };
      items.set(change.itemId, after);
    }
    changes.push({ action: change.action, itemId: change.itemId, sourceRef: change.sourceRef, before: before ? { ...before } : null, after: after ? { ...after } : null });
  }
  const revisedItems = [...items.values()];
  const knownSubtotalMinor = sum(revisedItems.filter((item) => item.amountMinor !== null).map((item) => item.amountMinor));
  const pricingQuestions = revisedItems.filter((item) => item.amountMinor === null).map((item) => ({ itemId: item.id, question: item.pricingQuestion }));
  const pricingResolved = pricingQuestions.length === 0;
  const knownDeltaMinor = checked(BigInt(knownSubtotalMinor) - BigInt(originalTotalMinor), 'Known price delta');
  return {
    version: 1, status: 'draft_for_review', quoteId: quote.id, requestId: request.id,
    currency: quote.currency, minorUnitDigits: quote.minorUnitDigits,
    originalItems, originalTotalMinor, revisedItems, changes,
    knownSubtotalMinor, knownDeltaMinor,
    totalMinor: pricingResolved ? knownSubtotalMinor : null,
    deltaMinor: pricingResolved ? knownDeltaMinor : null,
    pricingQuestions, pricingResolved,
    agreedDeadline: quote.agreedDeadline ? { ...quote.agreedDeadline } : null,
    deadlineQuestions: [...(request.deadlineQuestions ?? [])],
    scheduleStatus: 'not_validated', clientApproval: 'not_recorded',
  };
}

export function formatMoney(value, currency, digits) {
  const number = BigInt(value);
  const absolute = number < 0n ? -number : number;
  const scale = 10n ** BigInt(digits);
  const fraction = digits ? `.${String(absolute % scale).padStart(digits, '0')}` : '';
  return `${number < 0n ? '-' : ''}${currency} ${absolute / scale}${fraction}`;
}

function markdown(value) {
  return value.replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&').replace(/[\r\n]+/g, ' ');
}

export function renderRevision(revision, { quoteSource, changeSource, interpretation }) {
  const money = (value) => value === null ? 'Unresolved' : formatMoney(value, revision.currency, revision.minorUnitDigits);
  const lines = [
    '# Website scope revision', '',
    '**Draft for owner review. Client approval has not been recorded.**', '',
    interpretation
      ? `This draft started from a model suggestion (${markdown(interpretation.inference.provider)} / ${markdown(interpretation.inference.model)}). ${interpretation.inference.liveInferenceVerified ? 'The runtime recorded a live inference response.' : 'Live inference was not verified; this receipt may come from a test fixture.'} ${interpretation.editedSinceInterpretation ? 'The structured request was edited after interpretation.' : 'The structured request matches the stored suggestion.'} Arithmetic was recalculated deterministically. Rate approval references were supplied by the user and have not been independently verified.`
      : 'This document uses manually structured inputs and deterministic arithmetic. No model interpreted a client message. Rate approval references below were supplied by the user and have not been independently verified.', '',
    `Original quote: ${markdown(revision.quoteId)} · ${markdown(quoteSource)}`,
    `Change request: ${markdown(revision.requestId)} · ${markdown(changeSource)}`, '',
    '## Price comparison', '',
    '| Amount | Value |', '| --- | --- |',
    `| Original agreed-quote total, as supplied | ${money(revision.originalTotalMinor)} |`,
    `| Known revised subtotal | ${money(revision.knownSubtotalMinor)} |`,
    `| Known price delta | ${money(revision.knownDeltaMinor)} |`,
    `| Full revised total | ${money(revision.totalMinor)} |`,
    `| Full price delta | ${money(revision.deltaMinor)} |`, '',
    ...(revision.pricingResolved ? ['All revised lines have explicit rates. Client approval and schedule feasibility still require review.'] : ['Unpriced lines are excluded from the known subtotal and known delta. The full total and full delta remain unresolved; an unknown rate is never treated as zero.']), '',
    '## Proposed scope', '',
    '| Item | Quantity | Unit rate | Line amount |', '| --- | --- | --- | --- |',
    ...revision.revisedItems.map((item) => `| ${markdown(item.description)} (${markdown(item.id)}) | ${item.quantity} | ${money(item.unitRateMinor)} | ${money(item.amountMinor)} |`),
    ...(revision.revisedItems.length === 0 ? ['| All original items are proposed for removal | — | — | — |'] : []), '',
    '## Changes and provided sources', '',
  ];
  for (const change of revision.changes) {
    lines.push(`### ${markdown(change.itemId)}: ${change.action}`, '',
      `Quantity: ${change.before?.quantity ?? 0} → ${change.after?.quantity ?? 0}.`,
      `Source reference: ${markdown(change.sourceRef)}`, '',
      `Provided rate approval reference: ${markdown(change.after?.rateApprovalRef ?? change.before?.rateApprovalRef ?? 'None. Pricing remains unresolved.')}`, '');
  }
  lines.push('## Pricing questions', '',
    ...(revision.pricingQuestions.length ? revision.pricingQuestions.map(({ itemId, question }) => `- [ ] ${markdown(itemId)}: ${markdown(question)}`) : ['No pricing questions remain in the structured input.']), '',
    '## Deadline review', '',
    ...(revision.agreedDeadline ? [`Original deadline, as supplied: ${markdown(revision.agreedDeadline.text)}`, `Provided source: ${markdown(revision.agreedDeadline.sourceRef)}`] : ['No original deadline was supplied.']), '',
    ...revision.deadlineQuestions.map((question) => `- [ ] ${markdown(question)}`), '',
    'Schedule feasibility has not been validated. This revision does not promise a delivery date or preserve the old deadline automatically.', '',
    '## Owner review', '', '- [ ] Confirm the structured changes match the client request and references.', '- [ ] Resolve missing pricing and review the deadline.', '- [ ] Obtain and record actual client approval before treating this draft as agreed.', '',
    'The original quote input was preserved. This command produced a draft only; it did not send a proposal, record approval, or update a client agreement.', '');
  return lines.join('\n');
}
