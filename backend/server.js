require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Per-user in-memory budget store: { userId: [budgets] }
let userBudgets = {};

// ── EMAIL SETUP ──────────────────────────────────────────────────────────────
let transporter = null;
try {
  const nodemailer = require('nodemailer');
  // createTransport (NOT createTransporter) is the correct method name
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_APP_PASSWORD
    }
  });
  console.log('✅ Email service configured');
} catch (error) {
  console.log('⚠️  Email service not available:', error.message);
}

// ── SMS SETUP ────────────────────────────────────────────────────────────────
let twilioClient = null;
try {
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    const twilio = require('twilio');
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    console.log('✅ SMS service configured');
  } else {
    console.log('⚠️  SMS service: Twilio credentials missing');
  }
} catch (error) {
  console.log('⚠️  SMS service not available:', error.message);
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
// Get userId from header or query param
const getUserId = (req) => req.headers['x-user-id'] || req.query.userId || 'default';

// Build email HTML
const buildEmailHtml = (type, amount, category, date, balance) => `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;border:1px solid #ddd;border-radius:10px;">
    <h2 style="color:${type === 'income' ? '#10b981' : '#ef4444'};">
      ${type === 'income' ? '💰 Income' : '💸 Expense'} Recorded
    </h2>
    <div style="background:#f9fafb;padding:15px;border-radius:8px;margin:20px 0;">
      <p style="margin:10px 0;"><strong>Amount:</strong> ₹${Number(amount).toLocaleString('en-IN')}</p>
      <p style="margin:10px 0;"><strong>Category:</strong> ${category}</p>
      ${date ? `<p style="margin:10px 0;"><strong>Date:</strong> ${date}</p>` : ''}
      <p style="margin:10px 0;"><strong>Current Balance:</strong> ₹${Number(balance).toLocaleString('en-IN')}</p>
    </div>
    <p style="color:#6b7280;font-size:12px;">Finance Tracker — automated notification</p>
  </div>
`;

// ── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'Server is running', email: !!transporter, sms: !!twilioClient });
});

// ── BUDGETS ──────────────────────────────────────────────────────────────────
app.get('/api/budgets', (req, res) => {
  const userId = getUserId(req);
  res.json({ success: true, budgets: userBudgets[userId] || [] });
});

app.post('/api/budgets', (req, res) => {
  const userId = getUserId(req);
  const { category, limit, period } = req.body;

  if (!userBudgets[userId]) userBudgets[userId] = [];

  const newBudget = {
    id: `${userId}_${Date.now()}`,
    category,
    limit: parseFloat(limit),
    period: period || 'monthly',
    spent: 0,
    createdAt: new Date().toISOString(),
    userId
  };

  userBudgets[userId].push(newBudget);
  res.json({ success: true, budget: newBudget });
});

app.put('/api/budgets/:id/spend', (req, res) => {
  const userId = getUserId(req);
  const { id } = req.params;
  const { amount } = req.body;

  if (!userBudgets[userId]) return res.status(404).json({ success: false, message: 'No budgets for user' });

  const budget = userBudgets[userId].find(b => b.id === id);
  if (!budget) return res.status(404).json({ success: false, message: 'Budget not found' });

  budget.spent += parseFloat(amount);
  res.json({ success: true, budget, exceeded: budget.spent > budget.limit });
});

app.delete('/api/budgets/:id', (req, res) => {
  const userId = getUserId(req);
  const { id } = req.params;

  if (!userBudgets[userId]) return res.status(404).json({ success: false, message: 'No budgets for user' });

  userBudgets[userId] = userBudgets[userId].filter(b => b.id !== id);
  res.json({ success: true });
});

app.post('/api/budgets/reset', (req, res) => {
  const userId = getUserId(req);
  if (userBudgets[userId]) {
    userBudgets[userId].forEach(b => { b.spent = 0; });
  }
  res.json({ success: true, budgets: userBudgets[userId] || [] });
});

// ── SEND EMAIL ───────────────────────────────────────────────────────────────
app.post('/api/send-email', async (req, res) => {
  if (!transporter) return res.status(503).json({ success: false, message: 'Email not configured' });

  const { type, amount, category, date, balance, userEmail } = req.body;
  const toEmail = userEmail || process.env.EMAIL_USER;

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: toEmail,
      subject: `Finance Tracker: ${type === 'income' ? 'Income' : 'Expense'} Transaction`,
      html: buildEmailHtml(type, amount, category, date, balance)
    });
    res.json({ success: true, message: 'Email sent successfully' });
  } catch (error) {
    console.error('Email error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── SEND SMS ─────────────────────────────────────────────────────────────────
app.post('/api/send-sms', async (req, res) => {
  if (!twilioClient) return res.status(503).json({ success: false, message: 'SMS not configured' });

  const { type, amount, category, balance, userPhone } = req.body;
  const phoneNumber = userPhone || process.env.USER_PHONE_NUMBER;
  const message = `Finance Alert: ${type === 'income' ? '💰 Income' : '💸 Expense'} of ₹${amount} in ${category}. Balance: ₹${balance}`;

  try {
    const msg = await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phoneNumber
    });
    res.json({ success: true, sid: msg.sid });
  } catch (error) {
    console.error('SMS error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── SEND BOTH ────────────────────────────────────────────────────────────────
app.post('/api/send-notification', async (req, res) => {
  const { type, amount, category, date, balance, userEmail, userPhone } = req.body;
  const results = { email: { success: false }, sms: { success: false } };

  // Email
  if (transporter) {
    try {
      const toEmail = userEmail || process.env.EMAIL_USER;
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: toEmail,
        subject: `Finance Tracker: ${type === 'income' ? 'Income' : 'Expense'} Transaction`,
        html: buildEmailHtml(type, amount, category, date, balance)
      });
      results.email.success = true;
    } catch (error) {
      results.email.error = error.message;
      console.error('Email error:', error.message);
    }
  }

  // SMS
  if (twilioClient) {
    try {
      const phoneNumber = userPhone || process.env.USER_PHONE_NUMBER;
      const message = `Finance Alert: ${type === 'income' ? '💰 Income' : '💸 Expense'} of ₹${amount} in ${category}. Balance: ₹${balance}`;
      await twilioClient.messages.create({
        body: message,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phoneNumber
      });
      results.sms.success = true;
    } catch (error) {
      results.sms.error = error.message;
      console.error('SMS error:', error.message);
    }
  }

  res.json({ success: results.email.success || results.sms.success, results });
});

// ── BUDGET ALERT ─────────────────────────────────────────────────────────────
app.post('/api/send-budget-alert', async (req, res) => {
  const { category, limit, spent, percentage, userEmail, userPhone } = req.body;
  const results = { email: { success: false }, sms: { success: false } };

  if (transporter) {
    try {
      const toEmail = userEmail || process.env.EMAIL_USER;
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: toEmail,
        subject: '🚨 Budget Limit Exceeded Alert!',
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;border:2px solid #ef4444;border-radius:10px;background:#fef2f2;">
            <h2 style="color:#dc2626;margin-top:0;">⚠️ Budget Limit Exceeded!</h2>
            <div style="background:white;padding:20px;border-radius:8px;margin:20px 0;">
              <p><strong>Category:</strong> ${category}</p>
              <p><strong>Budget Limit:</strong> ₹${Number(limit).toLocaleString('en-IN')}</p>
              <p><strong>Amount Spent:</strong> <span style="color:#dc2626;">₹${Number(spent).toLocaleString('en-IN')}</span></p>
              <p><strong>Exceeded By:</strong> <span style="color:#dc2626;">₹${(spent - limit).toLocaleString('en-IN')}</span></p>
              <p style="font-size:18px;font-weight:bold;color:#dc2626;">${Number(percentage).toFixed(1)}% of budget used</p>
            </div>
          </div>
        `
      });
      results.email.success = true;
    } catch (error) {
      results.email.error = error.message;
      console.error('Budget alert email error:', error.message);
    }
  }

  if (twilioClient) {
    try {
      const phoneNumber = userPhone || process.env.USER_PHONE_NUMBER;
      await twilioClient.messages.create({
        body: `🚨 BUDGET ALERT: ${category} exceeded! Limit: ₹${limit}, Spent: ₹${spent}. ${Number(percentage).toFixed(0)}% used.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phoneNumber
      });
      results.sms.success = true;
    } catch (error) {
      results.sms.error = error.message;
      console.error('Budget alert SMS error:', error.message);
    }
  }

  res.json({ success: results.email.success || results.sms.success, results });
});

// ── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║   🚀 Finance Tracker Server           ║
║   📡 Port: ${PORT}                        ║
║   💰 Per-user budgets: Enabled        ║
║   📧 Email: ${transporter ? 'Ready          ' : 'Not configured'}  ║
║   📱 SMS:   ${twilioClient ? 'Ready          ' : 'Not configured'}  ║
╚═══════════════════════════════════════╝
  `);
});