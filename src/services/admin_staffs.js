const express = require('express');
const bcrypt  = require('bcryptjs');
const sql     = require('mssql');
const { getPool, poolPromise } = require('../config');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

const cleanMobile = (m) => String(m || "").replace(/[\s-]/g, "").replace(/^\+?91/, "");



router.get('/admin/staff/initial',
  authenticate,
  requireRole('ADMIN'),
  async (req, res) => {
    try {
      const pool = poolPromise ? await poolPromise : await getPool();

      const result = await pool.request()
        .execute('dbo.PROC_STAFF_DETAILS');

      const [roles, counts, staff] = result.recordsets;

      res.status(200).json({
        success: true,
        roles: roles || [],
        counts: counts && counts[0] ? counts[0] : { total: 0, sub_admin: 0, delivery_part: 0, active_emp: 0 },
        staff: staff || []
      });
    } catch (err) {
      console.error('Staff Details Error:', err);
      res.status(500).json({ success: false, message: 'Something went wrong.' });
    }
  });
router.post('/admin/staff',
  authenticate,
  requireRole('ADMIN'),                        // only admin can create staff
  async (req, res) => {
    try {
      const { name, mobile, password, role, dept, desig, email, address } = req.body;

      if (!password || password.length < 8)
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });

      const hash = await bcrypt.hash(password, 10);
      const pool = poolPromise ? await poolPromise : await getPool();

      let staffRole = String(role || 'SUB_ADMIN').toUpperCase().trim();
      if (staffRole === 'DELIVERY_PERSON') {
        staffRole = 'DELIVERY_PARTNER';
      }
      console.log(' req.body', req.body);
      

      const result = await pool.request()
        .input('NAME',     sql.NVarChar(100), name)
        .input('MOBILE',   sql.NVarChar(20),  cleanMobile(mobile || req.body.phone))
        .input('PASSWORD', sql.NVarChar(255), hash)
        .input('ROLE',     sql.NVarChar(20),  staffRole)
        .input('DEPT',     sql.Int,           dept ?? 1)
        .input('DESIG',    sql.Int,           desig ?? 1)
        .input('EMAIL',    sql.NVarChar(255), email || null)
        .input('ADDRESS',  sql.NVarChar(500), address || null)
        .execute('dbo.PROC_EMPLOYEE_REGISTRATION');

      const staff = result.recordset[0];

      // Save vehicle details for delivery partner if provided
      if (staff && staff.employeeId && (req.body.vehicleType || req.body.vehicleNumber)) {
        try {
          await pool.request()
            .input('EMP_DR',       sql.Int,           staff.employeeId)
            .input('VEHICLE_NAME', sql.NVarChar(200), req.body.vehicleType || null)
            .input('REG_NUMBER',   sql.NVarChar(100), req.body.vehicleNumber || null)
            .query(`INSERT INTO dbo.EB_EMPLOYEE_VEHICLES (EV_EMP_DR, EV_VEHICLE_NAME, EV_REG_NUMBER, EV_CREATED_DATE)
                    VALUES (@EMP_DR, @VEHICLE_NAME, @REG_NUMBER, CAST(GETDATE() AS DATE))`);
        } catch (vehErr) {
          console.warn('Vehicle insertion note:', vehErr.message);
        }
      }

      res.status(201).json({ success: true, ...staff });
    } catch (err) {
      // THROW 50001-50099 from the SP are safe to show the admin
      if (err.number >= 50001 && err.number <= 50099)
        return res.status(400).json({ success: false, message: err.message });

      console.error('Register Staff Error:', err);
      res.status(500).json({ success: false, message: err.message || 'Something went wrong.' });
    }
  });

module.exports = router;
