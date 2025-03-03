require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const bodyParser = require('body-parser');
const app = express();
const Redis = require("ioredis");
const cors = require('cors')
const fs = require('fs')
const path = require('path')
const dayjs = require('dayjs')

const redis = new Redis();

app.use(cors())

// Middleware to parse the request body
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

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

// Set EJS as the template engine
app.set("view engine", "ejs");

app.get('/', async (req, res) => {
  res.render("index", { stripePublicKey: process.env.STRIPE_PUBLIC_KEY });
});

// Endpoint to create a paymentIntent
app.post('/create-payment-intent', async (req, res) => {
  const { customData: { amount, currency, contactId, contactEmail }, order } = req.body;
  try {
    writeLog(`create-payment-intent body: ${JSON.stringify(req.body)}`);
    const paymentMethod = order?.metadata?.payment_method || order?.metadata?.default_payment_method;
    if (paymentMethod) {
      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: currency || 'usd',
        payment_method: paymentMethod,
        confirm: true,
        capture_method: "manual",
        customer: order.metadata?.customer,
        automatic_payment_methods: {
          enabled: true,
          allow_redirects: 'never'
        },
      });
      writeLog(`PaymentIntent: ${JSON.stringify(paymentIntent)}`);
      const cancelPaymentIntent = await stripe.paymentIntents.cancel(paymentIntent.id);
      writeLog(`Cancel: ${JSON.stringify(cancelPaymentIntent)}`);
      if (paymentIntent.status === "requires_capture") {
        redis.set(contactId, JSON.stringify({
          status: true,
          amount,
          contactId,
          contactEmail,
          paymentMethodId: paymentMethod,
          paymentStatus: paymentIntent.status,
        }), "EX", 1440); // 1 day
        return res.json({ success: true, paymentIntent, cancelPaymentIntent });
      } else {
        redis.set(contactId, JSON.stringify({
          status: false,
          amount,
          contactId,
          contactEmail,
          paymentMethodId: paymentMethod,
          paymentStatus: paymentIntent.status,
          message: paymentIntent?.last_payment_error?.message || paymentIntent.status,
        }), "EX", 1440); // 1 day
        return res.json({ success: false, paymentIntent, cancelPaymentIntent });
      }
    }
  } catch (error) {
    console.error('Error creating payment intent:', error.message, error.code);
    writeLog(`create-payment-intent error: ${JSON.stringify(error)}`);
    const paymentIntent = {
      charge: error?.charge,
      code: error?.code,
      decline_code: error?.decline_code,
      doc_url: error?.doc_url,
      rawType: error?.rawType,
      requestId: error?.requestId,
      statusCode: error?.statusCode,
      type: error?.type,
      raw: {
        ...error?.raw,
        headers: undefined,
        payment_intent: {
          ...error?.raw?.payment_intent,
          last_payment_error: {
            ...error?.raw?.payment_intent?.last_payment_error,
            payment_method: {
              ...error?.raw?.payment_intent?.last_payment_error?.payment_method,
              card: undefined,
            }
          }
        },
        payment_method: {
          ...error?.raw?.payment_method,
          card: undefined,
        },
      },
      payment_method: {
        ...error?.payment_method,
        card: undefined,
      },
      payment_intent: {
        ...error?.payment_intent,
        last_payment_error: {
          ...error?.payment_intent?.last_payment_error,
          payment_method: {
            ...error?.payment_intent?.last_payment_error?.payment_method,
            card: undefined,
          }
        },
      },
    }
    redis.set(contactId, JSON.stringify({
      status: false,
      paymentStatus: error?.code,
      rawType: error?.rawType,
      requestId: error?.requestId,
      message: error?.raw?.message ||  error?.payment_intent?.last_payment_error?.message || error?.message,
    }), "EX", 1440); // 1 day
    return res.json({ success: false, paymentIntent });
  }
});

app.get('/check-payment-status', async (req, res) => {
  try {
    const { contactId } = req.query;
    writeLog(`check-payment-status contactId: ${contactId}`);
    const data = await redis.get(contactId);
    writeLog(`check-payment-status store data: ${JSON.stringify(data)}`);
    if (data) {
      const parseData = JSON.parse(data);
      if (parseData?.status && parseData?.paymentStatus === "requires_capture") {
        redis.del(contactId);
        return res.json({ success: true, message: "Success" });
      }
      redis.del(contactId);
      return res.json({ success: false, message: parseData?.message });
    }
    return res.json({ success: false, message: "" });
  } catch (error) {
    console.error('Check payment status error:', error);
    writeLog(`check-payment-status error: ${JSON.stringify(error)}`);
    return res.json({ success: false, message: error.message });
  }
})

app.listen(process.env.SERVER_PORT, () => console.log(`Server running on port ${process.env.SERVER_PORT}`));
