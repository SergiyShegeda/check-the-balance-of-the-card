require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bodyParser = require('body-parser');
const app = express();
const cors = require('cors');
const path = require("path");
const fs = require("fs");

app.use(cors());
app.use('/webhook', express.raw({ type: 'application/json' }));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));


// Log handling
const logPath = path.join(__dirname, "logs");
const getFileName = async () => {
  if (!fs.existsSync(logPath)) {
    await fs.promises.mkdir(logPath);
  }

  const fileName = path.join(
      logPath,
      `log-${dayjs().format('YYYYMMDD')}.log`
  );
  if (!fs.existsSync(fileName)) {
    fs.createWriteStream(fileName);
  }

  return fileName;
};

const readLog = async (file) => {
  const fileName = await getFileName(file);
  try {
    if (fileName) {
      const data = await fs.promises.readFile(fileName);
      if (data.length) {
        return data.toString();
      }
    }
    return '';
  } catch (err) {
    return '';
  }
};

const writeLog = async (content) => {
  if (content) {
    const fileName = await getFileName();
    if (fileName) {
      const oldContent = await readLog(fileName);
      const now = new Date();
      await fs.promises.writeFile(
          fileName,
          `${oldContent}\n\n${now.toString()}: ${content}`
      );
    }
  }
};

// Helper function to create payment method
async function createPaymentMethod(type, cardTokenId) {
  try {
    const result = await stripe.paymentMethods.create({
      type: type,
      card: { token: cardTokenId },
    });
    return result.id;
  } catch (error) {
    console.error("Error creating payment method:", error);
    throw new Error("Failed to create payment method.");
  }
}

// Create customer and save payment method
async function createCustomerAndSavePayment(email, paymentMethodId, priceId) {
  try {
    const price = await stripe.prices.retrieve(priceId);
    const customer = await stripe.customers.create({
      email: email,
      payment_method: paymentMethodId,
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    // Create a PaymentIntent and hold the payment manually
    const paymentIntent = await stripe.paymentIntents.create({
      amount: price.unit_amount,
      currency: price.currency,
      customer: customer.id,
      payment_method: paymentMethodId,
      confirm: true,
      capture_method: "manual", // Hold funds but don't charge yet
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: 'never',
      },
    });

    return { customer, paymentIntent };
  } catch (error) {
    console.error("Error creating customer:", error);
    throw new Error("Failed to create customer and setup payment method.");
  }
}

// Create subscription with trial period
async function createSubscriptionSchedule(customerId, trialPriceId, paidPriceId, paymentMethodId, paymentIntent) {
  try {
    const now = Math.floor(Date.now() / 1000); // Current timestamp in seconds
    const trialEndDate = now + (7 * 24 * 60 * 60); // Trial period of 7 days

    // Create the subscription schedule
    return await stripe.subscriptionSchedules.create({
      customer: customerId,
      start_date: now, // Subscription starts now
      metadata: {
        paymentIntent: paymentIntent.id
      },
      end_behavior: 'release', // After all phases, the subscription is released (ends)
      phases: [
        {
          // Trial Phase
          items: [{price: trialPriceId}],
          trial: true, // Indicating that this phase is a trial
          end_date: trialEndDate, // End the trial after 7 days
          metadata: {
           phase: 'trial',
          },
        },
        {
          // Trial Phase
          items: [{price: trialPriceId}],
          metadata: {
            paymentIntent: paymentIntent.id,
            phase: 'held',
          },
          default_payment_method: paymentMethodId,
          iterations: 1,
        },
        {
          // Paid Phase
          items: [{ price: paidPriceId }],  // Switch to the paid price
          billing_cycle_anchor: 'phase_start',  // Align billing cycle with the phase start
          collection_method: 'charge_automatically',  // Automatically charge at the start of the paid phase
          proration_behavior: 'none',  // No prorations between trial and paid phase
          default_payment_method: paymentMethodId,
          metadata: {
            phase: 'paid',
          },
        }
      ],
    });
  } catch (error) {
    console.error("Error creating subscription schedule:", error);
    throw new Error("Failed to create subscription schedule.");
  }
}

// Create subscription endpoint
app.post('/create-subscription', async (req, res) => {
  const { priceId, contactEmail, type, cardTokenId } = req.body;
  try {
    if (!contactEmail || !priceId || !cardTokenId) {
      throw new Error("Missing required fields: email, cardTokenId, or priceId");
    }
    const paymentMethodId = await createPaymentMethod(type, cardTokenId);
    const { customer, paymentIntent } = await createCustomerAndSavePayment(contactEmail, paymentMethodId, priceId);
    if (!customer || !customer.id || !paymentIntent || !paymentIntent.id) {
      throw new Error("Customer or PaymentIntent creation failed");
    }

    const trialPriceId = process.env.TRIAL_STRIPE_PRICE_ID; // Price ID for the trial phase
    const paidPriceId = process.env.TREND_STRIPE_PRICE_ID; // Price ID for the trial phase
    const subscriptionSchedule = await createSubscriptionSchedule(customer.id, trialPriceId, paidPriceId, paymentMethodId, paymentIntent);
    if (!subscriptionSchedule || !subscriptionSchedule.id) {
      throw new Error("Subscription schedule creation failed");
    }


    res.json({ success: true, subscriptionSchedule });
  } catch (error) {
    console.error("Error in /create-subscription:", error);
    res.json({ success: false, error: error.message });
  }
});

// Webhook to handle events from Stripe
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    // Verify the webhook signature
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.log('Webhook signature verification failed:', err);
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'invoice.payment_succeeded':
        const invoice = event.data.object;
        const phase = invoice.subscription_details.metadata.phase;
        const paymentIntentId = invoice.subscription_details.metadata.paymentIntent; // Get the PaymentIntent ID from metadata
        if (paymentIntentId && phase === 'held') {
          // Capture the payment if it was manually held
          try {
            await stripe.paymentIntents.capture(paymentIntentId);
            console.log('Captured payment for invoice', invoice.id);
          } catch (e) {
            console.log(`Capturing payment for invoice ${ invoice.id } failed:`, e);
            return res.status(400).send(`Capturing error: ${e.message}`);
          }
        }
        break;
      case 'invoice.payment_failed':
        const failedInvoice = event.data.object;
        const failedCustomer = await stripe.customers.retrieve(failedInvoice.customer);
        console.error(`Payment failed for subscription ${failedInvoice.subscription}. Customer: ${failedCustomer.email}`);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
        break;
    }

    // Acknowledge receipt of the event to Stripe
    res.sendStatus(200);

  } catch (error) {
    console.error("Error handling webhook event:", error);
    res.status(500).send("Webhook handler failed.");
  }
});

// Start the server
app.listen(process.env.SERVER_PORT, () => console.log(`Server running on port ${process.env.SERVER_PORT}`));
