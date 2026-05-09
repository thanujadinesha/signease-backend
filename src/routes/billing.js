const express     = require('express');
const requireAuth = require('../middleware/auth');
const db          = require('../db');

const router = express.Router();

function stripe() {
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
}

const PLANS = {
  pro:     { tier: 'pro',     label: 'Pro',     priceId: () => process.env.STRIPE_PRICE_PRO },
  premium: { tier: 'premium', label: 'Premium', priceId: () => process.env.STRIPE_PRICE_PREMIUM },
  seat:    { tier: null,      label: 'Extra Seat', priceId: () => process.env.STRIPE_PRICE_SEAT },
};

// POST /api/billing/checkout
router.post('/checkout', requireAuth, async (req, res) => {
  const { plan } = req.body ?? {};
  const planConfig = PLANS[plan];
  if (!planConfig) return res.status(400).json({ error: 'Invalid plan' });

  const priceId = planConfig.priceId();
  if (!priceId) return res.status(500).json({ error: `Stripe price for plan "${plan}" not configured` });

  const baseUrl = process.env.APP_URL || 'https://signease.veloxio.cloud';

  try {
    const session = await stripe().checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { user_id: req.user.id, plan },
      customer_email: req.user.email,
      success_url: `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${baseUrl}/profile`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('Stripe checkout error:', e.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /api/billing/webhook  (raw body — mounted before express.json in index.js)
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe().webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (e) {
    console.error('Webhook signature error:', e.message);
    return res.status(400).json({ error: `Webhook error: ${e.message}` });
  }

  if (event.type === 'checkout.session.completed') {
    const session  = event.data.object;
    const { user_id, plan } = session.metadata ?? {};
    const planConfig = PLANS[plan];
    if (!user_id || !planConfig) return res.json({ received: true });

    try {
      if (plan === 'seat') {
        await db.query(
          'UPDATE users SET extra_seats = COALESCE(extra_seats, 0) + 1 WHERE id = $1',
          [user_id]
        );
      } else {
        const expiresAt = new Date();
        expiresAt.setFullYear(expiresAt.getFullYear() + 1);
        await db.query(
          'UPDATE users SET tier = $1, plan_expires_at = $2 WHERE id = $3',
          [planConfig.tier, expiresAt.toISOString(), user_id]
        );
      }
      console.log(`Plan updated: user=${user_id} plan=${plan}`);
    } catch (e) {
      console.error('Failed to update user plan:', e.message);
    }
  }

  res.json({ received: true });
});

// GET /api/billing/plans  (public — no auth needed)
router.get('/plans', (_req, res) => {
  res.json({
    plans: [
      {
        id:         'free',
        name:       'Free',
        price:      0,
        period:     null,
        signatures: 3,
        features:   ['3 signatures total', 'PDF & image support', 'Download signed docs'],
      },
      {
        id:         'pro',
        name:       'Pro',
        price:      25,
        period:     'year',
        signatures: 50,
        features:   ['50 signatures / year', 'All Free features', 'Priority support'],
      },
      {
        id:         'premium',
        name:       'Premium',
        price:      50,
        period:     'year',
        signatures: -1,
        features:   ['Unlimited signatures', 'All Pro features', 'Team management'],
      },
    ],
    seatPrice: 5,
  });
});

module.exports = router;
