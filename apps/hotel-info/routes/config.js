const express = require('express');
const router = express.Router();

const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || '';
const COMPANY_ADDRESS  = process.env.COMPANY_ADDRESS  || '';

// Send runtime config to the frontend. COMPANY_ADDRESS is a default/pre-fill
// value only — the frontend keeps the field editable (e.g. for trips that
// start from an airport/port/station instead of the office).
router.get('/', (req, res) => {
  res.json({ googleMapsKey: GOOGLE_MAPS_KEY, companyAddress: COMPANY_ADDRESS });
});

module.exports = router;
