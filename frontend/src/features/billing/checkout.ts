import type { Checkout } from './api'

const SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js'

interface RazorpayOptions {
  key: string
  order_id: string
  amount: number
  currency: string
  name: string
  description: string
  prefill?: { name?: string; contact?: string; email?: string }
  modal?: { ondismiss?: () => void }
  handler?: (response: unknown) => void
}

interface RazorpayWindow {
  Razorpay?: new (options: RazorpayOptions) => { open: () => void }
}

/** Loads the gateway's own script once, on the first payment rather than on every page. */
function loadCheckout() {
  const existing = (window as RazorpayWindow).Razorpay
  if (existing) return Promise.resolve(existing)
  return new Promise<NonNullable<RazorpayWindow['Razorpay']>>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT_URL
    script.onload = () => {
      const loaded = (window as RazorpayWindow).Razorpay
      if (loaded) resolve(loaded)
      else reject(new Error('The payment window could not be opened.'))
    }
    script.onerror = () => reject(new Error('The payment window could not be loaded. Check your connection.'))
    document.head.append(script)
  })
}

/**
 * Opens the gateway's hosted payment window.
 *
 * It resolves when the window closes, which says nothing about whether the payment went through:
 * only the server's webhook decides that. The caller refreshes the bill and tells the resident
 * the receipt will appear once the bank confirms.
 */
export async function openCheckout(checkout: Checkout, person: { name: string; phone: string | null; email: string | null }) {
  const Razorpay = await loadCheckout()
  await new Promise<void>((resolve) => {
    new Razorpay({
      key: checkout.keyId,
      order_id: checkout.orderId,
      amount: Math.round(checkout.amount * 100),
      currency: checkout.currency,
      name: 'CivicKey',
      description: 'Society maintenance',
      prefill: { name: person.name, contact: person.phone ?? undefined, email: person.email ?? undefined },
      modal: { ondismiss: resolve },
      handler: () => resolve(),
    }).open()
  })
}
