const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { writeLog } = require("./logger");

async function createPaymentMethod(type, cardTokenId) {
    try {
        const result = await stripe.paymentMethods.create({
            type: type,
            card: { token: cardTokenId },
        });
        return result.id;
    } catch (error) {
        await writeLog(`Error creating payment method: ${error.message}`);
        throw new Error("Failed to create payment method.");
    }
}

async function createCustomerAndSavePayment(email, paymentMethodId, priceId) {
    try {
        const price = await stripe.prices.retrieve(priceId);
        const customer = await stripe.customers.create({
            email,
            payment_method: paymentMethodId,
            invoice_settings: { default_payment_method: paymentMethodId },
        });

        const paymentIntent = await stripe.paymentIntents.create({
            amount: price.unit_amount,
            currency: price.currency,
            customer: customer.id,
            payment_method: paymentMethodId,
            confirm: true,
            capture_method: "manual",
            automatic_payment_methods: {
                enabled: true,
                allow_redirects: "never",
            },
        });
        // Check if the PaymentIntent requires authentication (3D Secure)
        if (paymentIntent.status === 'requires_action' || paymentIntent.status === 'requires_source_action') {
            return { customer, paymentIntent, requiresAction: true, clientSecret: paymentIntent.client_secret };
        }

        // If no authentication is required, simply return the customer and PaymentIntent
        return { customer, paymentIntent, requiresAction: false };
    } catch (error) {
        await writeLog(`Error creating customer: ${error.message}`);
        throw new Error("Failed to create customer and setup payment method.");
    }
}

async function createSubscriptionSchedule(customerId, trialPriceId, paidPriceId, paymentMethodId, paymentIntent) {
    try {
        const now = Math.floor(Date.now() / 1000);
        const trialEndDate = now + 7 * 24 * 60 * 60; // 7 days

        return await stripe.subscriptionSchedules.create({
            customer: customerId,
            start_date: now,
            metadata: { paymentIntent: paymentIntent.id },
            end_behavior: "release",
            phases: [
                {
                    items: [{ price: trialPriceId }],
                    trial: true,
                    end_date: trialEndDate,
                    metadata: {
                        phase: process.env.PHASE_STATUS_TRIAL,
                        paymentIntent: paymentIntent.id },
                },
                {
                    items: [{ price: paidPriceId }],
                    metadata: {
                        phase: process.env.PHASE_STATUS_HELD,
                        paymentIntent: paymentIntent.id,
                    },
                    trial: true,
                    default_payment_method: paymentMethodId,
                    iterations: 1,
                },
                {
                    items: [{ price: paidPriceId }],
                    billing_cycle_anchor: "phase_start",
                    collection_method: "charge_automatically",
                    default_payment_method: paymentMethodId,
                    metadata: {
                        phase: process.env.PHASE_STATUS_PAID,
                        paymentIntent: paymentIntent.id },
                },
            ],
        });
    } catch (error) {
        await writeLog(`Error creating subscription schedule: ${error.message}`);
        throw new Error("Failed to create subscription schedule.");
    }
}

async function createSubscription(req, res) {
    const { priceId, contactEmail, type, cardTokenId } = req.body;
    try {
        if (!contactEmail || !priceId || !cardTokenId) {
            throw new Error("Missing required fields: email, cardTokenId, or priceId");
        }

        const paymentMethodId = await createPaymentMethod(type, cardTokenId);
        const { customer, paymentIntent, requiresAction, clientSecret } = await createCustomerAndSavePayment(contactEmail, paymentMethodId, priceId);
        if (requiresAction) { // 3D security required
            return res.json({ success: false, requiresAction: true, clientSecret: clientSecret });
        }
        const subscriptionSchedule = await createSubscriptionSchedule(
            customer.id,
            process.env.TRIAL_STRIPE_PRICE_ID,
            priceId,
            paymentMethodId,
            paymentIntent
        );

        res.json({ success: true, subscriptionSchedule, requiresAction: false });
    } catch (error) {
        await writeLog(`Error in /create-subscription: ${error.message}`);
        res.json({ success: false, error: error.message });
    }
}

async function handleWebhook(req, res) {
    const sig = req.headers["stripe-signature"];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        await writeLog(`Webhook signature verification failed: ${err.message}`);
        return res.status(400).send(`Webhook error: ${err.message}`);
    }

    try {
        switch (event.type) {
            case "invoice.payment_succeeded":
                const invoice = event.data.object;
                const phase = invoice.subscription_details?.metadata?.phase;
                const paymentIntentId = invoice.subscription_details?.metadata?.paymentIntent;
                if (paymentIntentId && phase === process.env.PHASE_STATUS_TRIAL) {
                    await stripe.paymentIntents.capture(paymentIntentId);
                    await writeLog(`Captured payment for invoice ${invoice.id}`);
                }
                break;
            case "customer.subscription.deleted":
                // When the subscription is deleted, capture uncaptured payments if any
                const deletedSubscription = event.data.object;
                const phase_trial = deletedSubscription.metadata?.phase;
                const paymentIntentIdForCancellation = deletedSubscription.metadata?.paymentIntent;
                if (paymentIntentIdForCancellation && phase_trial === process.env.PHASE_STATUS_TRIAL) {
                    try {
                        // If the payment intent exists, attempt to capture it
                        await stripe.paymentIntents.cancel(paymentIntentIdForCancellation);
                        await writeLog(`Cancel payment for paymentIntent ${paymentIntentIdForCancellation} due to subscription cancellation.`);
                    } catch (error) {
                        await writeLog(`Failed to capture payment for paymentIntent ${paymentIntentIdForCancellation}: ${error.message}`);
                    }
                }
                break;
            case "payment_intent.payment_failed":
            case "invoice.payment_failed":
                const failedInvoice = event.data.object;
                const failedCustomer = await stripe.customers.retrieve(failedInvoice.customer);
                await writeLog(`Payment failed for subscription ${failedInvoice.subscription}. Customer: ${failedCustomer.email}`);
                // Optional: You could cancel the subscription here if needed
                // await stripe.subscriptions.del(failedInvoice.subscription);

                break;
            default:
                await writeLog(`Unhandled event type: ${event.type}`);
        }

        res.sendStatus(200);
    } catch (error) {
        await writeLog(`Error handling webhook event: ${error.message}`);
        res.status(500).send("Webhook handler failed.");
    }
}


module.exports = { createSubscription, handleWebhook };
