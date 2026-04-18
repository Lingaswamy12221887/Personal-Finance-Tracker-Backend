// budget-routes.js - Add this to your server folder
const express = require('express');
const router = express.Router();

// In-memory storage (replace with database in production)
let budgets = [];

// Get all budgets
router.get('/budgets', (req, res) => {
  res.json({ success: true, budgets });
});

// Add new budget
router.post('/budgets', (req, res) => {
  const { category, limit, period } = req.body;
  
  const newBudget = {
    id: Date.now().toString(),
    category,
    limit: parseFloat(limit),
    period, // 'monthly', 'weekly', 'daily'
    spent: 0,
    createdAt: new Date().toISOString()
  };
  
  budgets.push(newBudget);
  res.json({ success: true, budget: newBudget });
});

// Update budget spent amount
router.put('/budgets/:id/spend', (req, res) => {
  const { id } = req.params;
  const { amount } = req.body;
  
  const budget = budgets.find(b => b.id === id);
  if (!budget) {
    return res.status(404).json({ success: false, message: 'Budget not found' });
  }
  
  budget.spent += parseFloat(amount);
  
  res.json({ 
    success: true, 
    budget,
    exceeded: budget.spent > budget.limit
  });
});

// Delete budget
router.delete('/budgets/:id', (req, res) => {
  const { id } = req.params;
  budgets = budgets.filter(b => b.id !== id);
  res.json({ success: true });
});

// Reset all budgets (useful for new period)
router.post('/budgets/reset', (req, res) => {
  budgets.forEach(budget => {
    budget.spent = 0;
  });
  res.json({ success: true, budgets });
});

module.exports = router;