const express = require('express');
const router = express.Router();
const db = require('../db');
const { authenticate } = require('../middleware/auth');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * 1. Create a Payment Intent
 * This is called by the frontend when the student clicks "Pay Now"
 */
router.post('/create-intent/:dueId', authenticate, async (req, res) => {
    const { dueId } = req.params;
    const studentId = req.user.id;

    try {
        // Fetch the due from DB to ensure it exists and is unpaid
        const due = db.prepare("SELECT * FROM dues WHERE id = ? AND student_id = ? AND status = 'unpaid'").get(dueId, studentId);
        
        if (!due) {
            return res.status(404).json({ error: 'Unpaid due not found' });
        }

        // Create Stripe Payment Intent
        // Note: Stripe amounts are in cents/paise (multiply by 100)
        const paymentIntent = await stripe.paymentIntents.create({
            amount: Math.round(due.amount * 100), 
            currency: 'inr',
            description: `Nexus Clearance Due: ${due.description} (${due.department})`,
            metadata: {
                student_id: studentId.toString(),
                due_id: dueId.toString()
            },
            automatic_payment_methods: {
                enabled: true,
            },
        });

        res.json({
            clientSecret: paymentIntent.client_secret,
            publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
        });

    } catch (err) {
        console.error('Stripe Intent Error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * 2. Get Student Receipts
 */
router.get('/receipts', authenticate, (req, res) => {
    const studentId = req.user.id;
    
    const query = `
        SELECT 
            p.id as payment_id,
            p.amount,
            p.transaction_ref,
            p.paid_at,
            d.department,
            d.description
        FROM payments p
        JOIN dues d ON p.due_id = d.id
        WHERE p.student_id = ?
        ORDER BY p.paid_at DESC
    `;
    
    const receipts = db.prepare(query).all(studentId);
    res.json(receipts);
});

/**
 * 3. Manual Payment Verification (Fallback for Webhooks)
 * This is called by the frontend after stripe.confirmCardPayment succeeds
 */
router.post('/verify/:paymentIntentId', authenticate, async (req, res) => {
    const { paymentIntentId } = req.params;
    const studentId = req.user.id;

    try {
        const intent = await stripe.paymentIntents.retrieve(paymentIntentId);

        if (intent.status === 'succeeded') {
            const dueId = intent.metadata.due_id;
            const amount = intent.amount / 100;

            let updated = false;
            db.transaction(() => {
                const existing = db.prepare('SELECT id FROM payments WHERE transaction_ref = ?').get(intent.id);
                if (!existing) {
                    db.prepare('INSERT INTO payments (student_id, due_id, amount, transaction_ref) VALUES (?, ?, ?, ?)')
                      .run(studentId, dueId, amount, intent.id);
                    db.prepare("UPDATE dues SET status = 'paid' WHERE id = ?").run(dueId);
                    updated = true;
                }
            })();

            return res.json({ success: true, updated });
        } else {
            return res.status(400).json({ error: `Payment status: ${intent.status}` });
        }
    } catch (err) {
        console.error('Manual Verification Error:', err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
