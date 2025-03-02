require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const stripeRoutes = require("./routes/stripeRoutes");

const app = express();

// Middleware
app.use(cors());
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Set EJS as the template engine
app.set("view engine", "ejs");

// Serve Home Page
app.get("/", (req, res) => {
  res.render("index", {
    stripe_public_key: process.env.STRIPE_PUBLIC_KEY,
    trend_stripe_price_id: process.env.TREND_STRIPE_PRICE_ID,
    thrust_stripe_price_id: process.env.THRUST_STRIPE_PRICE_ID,
    track_stripe_price_id: process.env.TRACK_STRIPE_PRICE_ID,
  });
});

// Routes
app.use("/", stripeRoutes);

// Start Server
const PORT = process.env.SERVER_PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
