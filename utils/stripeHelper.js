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

        return { customer, paymentIntent };
    } catch (error) {
        await writeLog(`Error creating customer: ${error.message}`);
        throw new Error("Failed to create customer and setup payment method.");
    }
}

async function createSubscriptionSchedule(customerId, trialPriceId, paidPriceId, paymentMethodId, paymentIntent) {
    try {
        const now = Math.floor(Date.now() / 1000);
        const trialEndDate = now + 7 * 24 * 60 * 60;

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
                    metadata: { phase: process.env.PHASE_STATUS_TRIAL, paymentIntent: paymentIntent.id },
                },
                {
                    items: [{ price: trialPriceId }],
                    metadata: { phase: process.env.PHASE_STATUS_HELD, paymentIntent: paymentIntent.id },
                    default_payment_method: paymentMethodId,
                    iterations: 1,
                },
                {
                    items: [{ price: paidPriceId }],
                    billing_cycle_anchor: "phase_start",
                    collection_method: "charge_automatically",
                    proration_behavior: "none",
                    default_payment_method: paymentMethodId,
                    metadata: { phase: process.env.PHASE_STATUS_PAID, paymentIntent: paymentIntent.id },
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
        const { customer, paymentIntent } = await createCustomerAndSavePayment(contactEmail, paymentMethodId, priceId);
        const subscriptionSchedule = await createSubscriptionSchedule(
            customer.id,
            process.env.TRIAL_STRIPE_PRICE_ID,
            process.env.TREND_STRIPE_PRICE_ID,
            paymentMethodId,
            paymentIntent
        );

        res.json({ success: true, subscriptionSchedule });
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

                if (paymentIntentId && phase === process.env.PHASE_STATUS_HELD) {
                    await stripe.paymentIntents.capture(paymentIntentId);
                    await writeLog(`Captured payment for invoice ${invoice.id}`);
                }
                break;
            case "customer.subscription.updated":
                const subscription = event.data.object;
                if (subscription.status === "active") {
                    const currentPhase = subscription.metadata?.phase;
                    if (currentPhase === process.env.PHASE_STATUS_HELD) {
                        // Fetch subscription schedules for the customer
                        const schedules = await stripe.subscriptionSchedules.list({
                            customer: subscription.customer,
                        });

                        if (!schedules.data.length) {
                            await writeLog(`No subscription schedule found for customer ${subscription.customer}`);
                            return res.status(400).send("No subscription schedule found.");
                        }

                        // Find the active schedule
                        const activeSchedule = schedules.data.find((s) => s.status === "active");
                        if (!activeSchedule) {
                            await writeLog(`No active subscription schedule found for subscription ${subscription.id}`);
                            return res.status(400).send("No active subscription schedule found.");
                        }

                        // Extract the paid phase from the active schedule
                        const paidPhase = activeSchedule.phases.find(
                            (phase) => phase.metadata?.phase === process.env.PHASE_STATUS_PAID
                        );

                        if (!paidPhase) {
                            await writeLog(`No paid phase found for subscription ${subscription.id}`);
                            return res.status(400).send("Paid phase not found.");
                        }

                        const paidPriceId = paidPhase.items[0]?.price;
                        if (!paidPriceId) {
                            await writeLog(`No price found for paid phase in subscription ${subscription.id}`);
                            return res.status(400).send("Price ID not found for paid phase.");
                        }

                        // Update subscription to move to the paid phase
                        await stripe.subscriptions.update(subscription.id, {
                            items: [{ price: paidPriceId }],
                            metadata: {
                                phase: process.env.PHASE_STATUS_HELD,
                                paymentIntent: subscription.metadata?.paymentIntent
                            },
                        });s

                        await writeLog(`Subscription ${subscription.id} upgraded to paid phase with price ${paidPriceId}`);
                    }
                }
                break;
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
