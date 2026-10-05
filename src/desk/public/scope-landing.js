import { animateChange, cancelMotion } from '/motion.js';

const pages = document.getElementById('sample-pages');
const checkout = document.getElementById('sample-checkout');
const $ = (id) => document.getElementById(id);
const subtotalRow = document.querySelector('.scope-known-total');
const subtotalValue = $('sample-subtotal');
const subtotalRule = subtotalValue.querySelector('.scope-ledger-rule');
const subtotalText = subtotalValue.firstChild;
const amount = (minor) => {
  const integer = BigInt(minor);
  const absolute = integer < 0n ? -integer : integer;
  const cents = absolute % 100n;
  return `${integer < 0n ? '-' : ''}$${new Intl.NumberFormat('en-US').format(absolute / 100n)}${cents ? `.${String(cents).padStart(2, '0')}` : ''}`;
};
let previousQuantity;
let previousCheckout;
let previousSubtotal;

function exampleRate() {
  if (!checkout.checked || !$('sample-price-enabled').checked) return { minor: null, error: '' };
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec($('sample-price').value.trim());
  let minor = null;
  if (match) {
    const value = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
    if (value <= BigInt(Number.MAX_SAFE_INTEGER) - 100000n) minor = Number(value);
  }
  const reference = $('sample-rate-reference').value.trim();
  $('sample-price').setAttribute('aria-invalid', String(minor === null));
  $('sample-rate-reference').setAttribute('aria-invalid', String(!reference));
  if (minor === null) return { minor: null, error: 'Enter a nonnegative USD amount with up to two decimal places, such as 350.00. The full total stays unresolved.' };
  if (!reference) return { minor: null, error: 'Supply a reference for the example rate. The full total stays unresolved.' };
  return { minor, reference, error: '' };
}

function updateExample(event) {
  const quantity = pages.value === '3' ? 3 : 5;
  const rate = exampleRate();
  const unresolved = checkout.checked && rate.minor === null;
  const subtotal = quantity * 20000 + (rate.minor ?? 0);
  const delta = subtotal - 60000;
  $('sample-quantity').textContent = String(quantity);
  $('sample-page-amount').textContent = amount(quantity * 20000);
  $('sample-checkout-row').hidden = !checkout.checked;
  $('sample-delta').textContent = `${delta > 0 ? '+' : ''}${amount(delta)}`;
  subtotalText.textContent = amount(subtotal);
  $('sample-total').textContent = unresolved ? 'Unresolved' : amount(subtotal);
  $('sample-total').dataset.resolved = String(!unresolved);
  $('sample-question').hidden = !unresolved;
  $('sample-pricing-state').textContent = rate.minor === null ? 'Price not supplied' : 'Example rate supplied';
  $('sample-checkout-rate').textContent = rate.minor === null ? '—' : amount(rate.minor);
  $('sample-checkout-amount').textContent = rate.minor === null ? 'Unpriced' : amount(rate.minor);
  $('sample-checkout-amount').classList.toggle('scope-unpriced', rate.minor === null);
  $('sample-price-enabled').disabled = !checkout.checked;
  $('sample-price-fields').hidden = !checkout.checked || !$('sample-price-enabled').checked;
  for (const input of $('sample-price-fields').querySelectorAll('input')) input.disabled = $('sample-price-fields').hidden;
  $('sample-rate-error').textContent = rate.error;
  $('sample-rate-error').hidden = !rate.error;
  if (!$('sample-price-enabled').checked || !checkout.checked) {
    $('sample-price').removeAttribute('aria-invalid');
    $('sample-rate-reference').removeAttribute('aria-invalid');
  }
  $('scope-demo-message').textContent = `“Could we ${quantity === 5 ? 'make it five pages' : 'keep the three pages'}${checkout.checked ? ' and add checkout' : ''}?”`;
  $('scope-trail-pages').textContent = `3 → ${quantity} website pages`;
  $('scope-trail-checkout').hidden = !checkout.checked;
  $('scope-trail-rate').textContent = rate.minor === null ? 'The new line stays unpriced until you provide a rate and its reference.' : `${amount(rate.minor)} example rate. Provided reference: ${rate.reference}. This does not record client approval.`;
  if (!checkout.checked) {
    cancelMotion($('sample-checkout-row'));
    cancelMotion($('sample-question'));
  }

  if (event && (quantity !== previousQuantity || subtotal !== previousSubtotal)) {
    for (const target of [$('sample-quantity'), $('sample-page-amount'), $('sample-delta')]) {
      animateChange(target, [{ backgroundColor: '#dce6ff' }, { backgroundColor: '#ffffff' }], { duration: 300 });
    }
    animateChange(subtotalRow, [{ backgroundColor: '#dce6ff' }, { backgroundColor: '#f0f4ff' }], { duration: 380 });
    animateChange(subtotalRule, [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 380 });
  }
  if (event && checkout.checked !== previousCheckout) {
    animateChange($('sample-total'), [{ backgroundColor: checkout.checked ? '#fff0cb' : '#dce6ff' }, { backgroundColor: '#ffffff' }], { duration: 300 });
    if (checkout.checked) {
      animateChange($('sample-checkout-row'), [{ backgroundColor: '#fff0cb' }, { backgroundColor: '#ffffff' }], { duration: 300 });
      animateChange($('sample-question'), [{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 300 });
    }
  }
  previousQuantity = quantity;
  previousCheckout = checkout.checked;
  previousSubtotal = subtotal;
}
document.querySelector('.scope-demo-controls').disabled = false;
pages.addEventListener('change', updateExample);
checkout.addEventListener('change', updateExample);
$('sample-price-enabled').addEventListener('change', updateExample);
for (const input of [$('sample-price'), $('sample-rate-reference')]) input.addEventListener('input', updateExample);
updateExample();

for (const image of document.querySelectorAll('[data-evidence-image]')) {
  const unavailable = () => {
    image.closest('picture').hidden = true;
    image.closest('figure').querySelector('.evidence-image-fallback').hidden = false;
    image.closest('figure').querySelector('details').open = true;
  };
  image.addEventListener('error', unavailable);
  if (image.complete && !image.naturalWidth) unavailable();
}
