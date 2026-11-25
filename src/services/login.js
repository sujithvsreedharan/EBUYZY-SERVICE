const express = require("express");
const router = express.Router();               // note the () your skeleton was missing
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");

const { sql, poolPromise } = require("../config");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const emptyToNull = (val) =>
    (val === undefined || val === null || (typeof val === "string" && val.trim() === "")) ? null : val;

const sendError = (res, error, action = "Operation") => {
    console.error(`${action} Error:`, error);
    const isValidation = error.number >= 50000 && error.number < 60000;
    return res.status(isValidation ? 400 : 500).json({
        success: false,
        message: isValidation ? error.message : `${action} failed. Try again.`
    });
};

// slows down password guessing: 10 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Too many attempts. Try again in a few minutes." }
});

const cleanMobile = (m) => String(m || "").replace(/[\s-]/g, "").replace(/^\+?91/, "");

function signToken(user) {
    return jwt.sign(
        { id: user.id, role: user.role },
        process.env.JWT_SECRET || "ebuyzy_super_secret_jwt_key_2026",
        { expiresIn: "7d" }
    );
}

// ---------- registration ----------
router.post("/registerCustomer", async (req, res) => {
    try {
        const b = req.body;
        const name = (b.name || "").trim();
        const mobile = cleanMobile(b.mobile || b.phone);
        const email = emptyToNull((b.email || "").trim());
        const password = String(b.password || "");

        if (!name || !/^\d{10}$/.test(mobile)) {
            return res.status(400).json({ success: false, message: "Enter your name and a valid 10-digit mobile number" });
        }
        if (email && !/^\S+@\S+\.\S+$/.test(email)) {
            return res.status(400).json({ success: false, message: "Enter a valid email address" });
        }
        if (password.length < 8) {
            return res.status(400).json({ success: false, message: "Password must be at least 8 characters" });
        }

        const hash = await bcrypt.hash(password, 10);

        const pool = await poolPromise;
        const result = await pool.request()
            .input("USER_NAME",     sql.NVarChar(100), name)
            .input("USER_MOBILE",   sql.NVarChar(20),  mobile)
            .input("USER_PASSWORD", sql.NVarChar(255), hash)
            .input("USER_EMAIL",    sql.NVarChar(255), email)
            .input("USER_ROLE",     sql.NVarChar(20),  "CUSTOMER")   // fixed here, never from the body
            .input("ADDRESS_NAME",  sql.NVarChar(50),  emptyToNull(b.addressName) ?? "Home")
            .input("ADDRESS_LINE1", sql.NVarChar(250), emptyToNull(b.addressLine1))
            .input("ADDRESS_LINE2", sql.NVarChar(250), emptyToNull(b.addressLine2))
            .input("LANDMARK",      sql.NVarChar(150), emptyToNull(b.landmark))
            .input("CITY",          sql.NVarChar(100), emptyToNull(b.city))
            .input("DISTRICT",      sql.NVarChar(100), emptyToNull(b.district))
            .input("STATE",         sql.NVarChar(100), emptyToNull(b.state) ?? "Kerala")
            .input("PINCODE",       sql.NVarChar(10),  emptyToNull(b.pincode))
            .execute("PROC_EB_USER_SIGNUP");

        const user = result.recordset[0];

        res.status(200).json({
            success: true,
            message: user.message || "Registration successful",
            userId: user.id,
            token: signToken({ id: user.id, role: user.role }),   // signed in right after signup
            user: { id: user.id, name: user.name, email: user.email, mobile: user.phone || user.mobile, role: user.role }
        });
    } catch (error) {
        sendError(res, error, "Register Customer");
    }
});

// ---------- login ----------
router.post("/login", loginLimiter, async (req, res) => {
    
    try {
        const identifier = String(req.body.username || req.body.identifier || req.body.email || req.body.mobile || "").trim();   // mobile or email
        const password = String(req.body.password || "");

        if (!identifier || !password) {
            return res.status(400).json({ success: false, message: "Enter your mobile or email and password" });
        }

        const pool = await poolPromise;
        const result = await pool.request()
            .input("mobile", sql.NVarChar(50),  cleanMobile(identifier))
            .input("email",  sql.NVarChar(100), identifier.toLowerCase())
            .query(`SELECT TOP 1
                           USER_SLNO     AS id,
                           USER_NAME     AS name,
                           USER_EMAIL    AS email,
                           USER_MOBILE   AS mobile,
                           USER_PASSWORD AS password,
                           USER_ROLE     AS role,
                           USER_ACTIVE   AS active
                    FROM dbo.EB_USER_MASTER
                    WHERE USER_MOBILE = @mobile OR USER_EMAIL = @email`);

        const user = result.recordset[0];

        // one message for "no such user" and "wrong password" so accounts can't be probed
        const invalid = () =>
            res.status(401).json({ success: false, message: "Mobile, email or password is incorrect" });

        if (!user) return invalid();

        let ok = false;
        const stored = String(user.password || "");

        if (stored.startsWith("$2")) {
            ok = await bcrypt.compare(password, stored);
        } else if (stored === password) {
            // old plain-text account: accept once, then upgrade it to a hash
            ok = true;
            const newHash = await bcrypt.hash(password, 10);
            await pool.request()
                .input("id", sql.Int, user.id)
                .input("hash", sql.NVarChar(100), newHash)
                .query("UPDATE dbo.EB_USER_MASTER SET USER_PASSWORD = @hash WHERE USER_SLNO = @id");
        }

        if (!ok) return invalid();

        if (!user.active) {
            return res.status(403).json({ success: false, message: "Your account is disabled. Contact support." });
        }

        res.status(200).json({
            success: true,
            token: signToken(user),
            user: { id: user.id, name: user.name, email: user.email, mobile: user.mobile, role: user.role }
        });
    } catch (error) {
        sendError(res, error, "Login");
    }
});

// ---------- current user profile & addresses ----------
router.get("/user/profile", requireAuth, async (req, res) => {
    try {
        const pool = await poolPromise;
        const userRes = await pool.request()
            .input("id", sql.Int, req.user.id)
            .query(`SELECT USER_SLNO AS id, USER_NAME AS name, USER_EMAIL AS email,
                           USER_MOBILE AS mobile, USER_ROLE AS role
                    FROM dbo.EB_USER_MASTER
                    WHERE USER_SLNO = @id AND USER_ACTIVE = 1`);

        if (!userRes.recordset.length) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        const user = userRes.recordset[0];

        // Fetch addresses
        const addrRes = await pool.request()
            .input("userId", sql.Int, req.user.id)
            .query(`SELECT ADDRESS_SLNO AS addressId, FULL_NAME AS fullName, MOBILE AS mobile,
                           ADDRESS_LINE1 AS addressLine1, ADDRESS_LINE2 AS addressLine2,
                           LANDMARK AS landmark, CITY AS city, DISTRICT AS district,
                           STATE AS state, PINCODE AS pincode, IS_DEFAULT AS isDefault
                    FROM dbo.EB_USER_ADDRESS
                    WHERE USER_DR = @userId AND IS_ACTIVE = 1
                    ORDER BY IS_DEFAULT DESC, ADDRESS_SLNO DESC`);

        const addresses = addrRes.recordset || [];
        const defaultAddr = addresses.find(a => a.isDefault) || addresses[0] || null;

        res.status(200).json({
            success: true,
            user: {
                ...user,
                address: defaultAddr ? `${defaultAddr.addressLine1}${defaultAddr.addressLine2 ? ', ' + defaultAddr.addressLine2 : ''}, ${defaultAddr.city} - ${defaultAddr.pincode}` : null,
                locality: defaultAddr?.landmark || defaultAddr?.city || null,
                pincode: defaultAddr?.pincode || null,
                defaultAddress: defaultAddr,
                addresses
            }
        });
    } catch (error) {
        sendError(res, error, "Get User Profile");
    }
});

// Update or save address
router.post("/user/address", requireAuth, async (req, res) => {
    try {
        const b = req.body;
        const pool = await poolPromise;

        const addressLine1 = (b.address || b.addressLine1 || "").trim();
        const addressLine2 = emptyToNull(b.gps || b.gpsLocation || b.addressLine2);
        const landmark = emptyToNull(b.locality || b.landmark);
        const city = (b.city || "Kakkanad, Kochi").trim();
        const pincode = (b.pincode || "682030").trim();
        const fullName = (b.name || req.user?.name || "Customer").trim();
        const mobile = (b.phone || req.user?.mobile || "9847000111").trim();

        if (!addressLine1) {
            return res.status(400).json({ success: false, message: "Address is required" });
        }

        // Set previous addresses isDefault = 0
        await pool.request()
            .input("userId", sql.Int, req.user.id)
            .query("UPDATE dbo.EB_USER_ADDRESS SET IS_DEFAULT = 0 WHERE USER_DR = @userId");

        // Insert new address
        const insertRes = await pool.request()
            .input("userId", sql.Int, req.user.id)
            .input("fullName", sql.NVarChar(100), fullName)
            .input("mobile", sql.NVarChar(20), mobile)
            .input("addr1", sql.NVarChar(250), addressLine1)
            .input("addr2", sql.NVarChar(250), addressLine2)
            .input("landmark", sql.NVarChar(150), landmark)
            .input("city", sql.NVarChar(100), city)
            .input("state", sql.NVarChar(100), "Kerala")
            .input("pincode", sql.NVarChar(10), pincode)
            .query(`INSERT INTO dbo.EB_USER_ADDRESS
                    (USER_DR, FULL_NAME, MOBILE, ADDRESS_LINE1, ADDRESS_LINE2, LANDMARK, CITY, STATE, PINCODE, IS_DEFAULT, IS_ACTIVE, CREATED_AT)
                    VALUES (@userId, @fullName, @mobile, @addr1, @addr2, @landmark, @city, @state, @pincode, 1, 1, SYSDATETIME());
                    SELECT SCOPE_IDENTITY() AS addressId;`);

        res.status(200).json({
            success: true,
            message: "Address saved successfully",
            addressId: insertRes.recordset[0]?.addressId
        });
    } catch (error) {
        sendError(res, error, "Save Address");
    }
});

// Update profile name, phone, email
router.post("/user/profile", requireAuth, async (req, res) => {
    try {
        const pool = await poolPromise;
        const name = (req.body.name || "").trim();
        const mobile = (req.body.phone || req.body.mobile || "").trim();
        const email = (req.body.email || "").trim();

        await pool.request()
            .input("userId", sql.Int, req.user.id)
            .input("name", sql.NVarChar(100), name)
            .input("mobile", sql.NVarChar(20), mobile)
            .input("email", sql.NVarChar(120), email)
            .query(`UPDATE dbo.EB_USER_MASTER
                    SET USER_NAME = CASE WHEN LEN(ISNULL(@name, '')) > 0 THEN @name ELSE USER_NAME END,
                        USER_MOBILE = CASE WHEN LEN(ISNULL(@mobile, '')) > 0 THEN @mobile ELSE USER_MOBILE END,
                        USER_EMAIL = CASE WHEN LEN(ISNULL(@email, '')) > 0 THEN @email ELSE USER_EMAIL END
                    WHERE USER_SLNO = @userId`);

        res.status(200).json({ success: true, message: "Profile updated successfully" });
    } catch (error) {
        sendError(res, error, "Update User Profile");
    }
});

module.exports = router;