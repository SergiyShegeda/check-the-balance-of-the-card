const express = require("express");
const {
    createSubscription,
    handleWebhook,
} = require("../utils/stripeHelper");

const router = express.Router();

// Route to create a subscription
router.post("/create-subscription", createSubscription);

// Webhook to handle Stripe events
router.post("/webhook", handleWebhook);

module.exports = router;
