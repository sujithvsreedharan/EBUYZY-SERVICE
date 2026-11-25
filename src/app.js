const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app     = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static uploads
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.use("/api", require('./services/home'));
app.use("/api", require('./services/category'));
app.use("/api", require('./services/admin_products'));
app.use("/api", require('./services/login'));
app.use("/api", require('./services/admin_staffs'));
app.use("/api", require('./services/cart_operation'));
app.use("/api", require('./services/order_operations'));
app.use("/api", require('./services/notification'));

module.exports = app;
