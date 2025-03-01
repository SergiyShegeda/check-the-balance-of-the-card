POC: Hold full transaction amount until trial period ends
sk_test_xxxx:  Replace with your Stripe Secret key - file app.js line 3
pk_test_xxx:  Replace with your Stripe Public Key - file index.html line 35

✅ Card with funds: 4242 4242 4242 4242 (Visa)

❌ Declined card: 4000 0000 0000 0002
# Stripe Subscription API with Trial and Manual Payment Capture

This project demonstrates how to use Stripe's API to handle subscriptions with a trial period and manual payment capture. When a user signs up for a subscription, the full payment amount is held (authorized) but not charged until the trial period ends. At the end of the trial, the payment is captured, and the user is charged.

## Features
- **Manual Payment Capture**: Hold the payment authorization until the trial period ends.
- **Trial Period**: Provide a free trial period (e.g., 7 days) before the user is charged.
- **Subscription Scheduling**: Schedule different phases for the subscription (trial, held, and paid).
- **Webhook Handling**: Handle Stripe webhooks to manage events such as successful or failed payments.

## Prerequisites

To get started with this project, you will need the following:

- Node.js installed on your system.
- Stripe account with API keys.
- `.env` file to store sensitive information like API keys and price IDs.
- Webhook Secret for Stripe webhook events.

### Dependencies
The following NPM packages are required for this project:

- `express`: A web framework for building APIs.
- `stripe`: Stripe Node.js library for interacting with Stripe API.
- `body-parser`: Middleware for parsing request bodies.
- `cors`: Middleware for handling Cross-Origin Resource Sharing.
- `dayjs`: Date formatting library (used for log file naming).
- `fs`: File system module for logging purposes.

You can install them by running:

```bash
npm install express stripe body-parser cors dayjs fs
