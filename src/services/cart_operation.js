const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");

const { sql, poolPromise } = require("../config");
const { requireAuth } = require("../middleware/auth");

const JWT_SECRET = process.env.JWT_SECRET || "ebuyzy_super_secret_jwt_key_2026";

const sendError = (res, error, action = "Operation") => {
    console.error(`${action} Error:`, error);
    const isValidation = error.number >= 50000 && error.number < 60000;
    return res.status(isValidation ? 400 : 500).json({
        success: false,
        message: isValidation ? error.message : `${action} failed. Try again.`
    });
};

function getUserId(req) {
    if (req.user && req.user.id) return req.user.id;
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : (header.startsWith("Bearer") ? header.slice(6).trim() : null);
    if (token) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded && decoded.id) return decoded.id;
        } catch (_) {}
    }
    return req.body?.userId ?? req.query?.userId;
}

function cartResponse(result) {
    return {
        cart: (result.recordsets[0] || [])[0] || null,
        items: result.recordsets[1] || []
    };
}

router.post("/cart/addOrUpdate", async (req, res) => {
    try {
        // take the user from your auth token, never trust a body userId in production
        const userId = Number(getUserId(req) ?? req.user?.id ?? req.body.userId);
        const productId = Number(req.body.productId);
        const quantity = Number(req.body.quantity);

        if (!Number.isInteger(userId) || userId < 1 ||
            !Number.isInteger(productId) || productId < 1 ||
            !Number.isFinite(quantity)) {
            return res.status(400).json({ success: false, message: "Invalid user, product or quantity" });
        }

        const pool = await poolPromise;
        const result = await pool.request()
            .input("USER_DR",    sql.Int,            userId)
            .input("PRODUCT_DR", sql.Int,            productId)
            .input("QUANTITY",   sql.Decimal(12, 3), quantity)
            .input("IS_DELTA",   sql.Bit,            req.body.isDelta ? 1 : 0)
            .execute("PROC_EB_ADD_OR_UPDATE_CART_ITEM");

        const change = (result.recordsets[2] || [])[0] || {};
        res.status(200).json({
            success: true,
            ...cartResponse(result),
            stockCapped: !!change.stockCapped,
            availableStock: change.availableStock,
            message: change.stockCapped ? `Only ${change.availableStock} available` : undefined
        });
    } catch (error) {
        sendError(res, error, "Add Or Update Cart Item");
    }
});

router.post("/cart/get", async (req, res) => {
    try {
        const userId = Number(getUserId(req) ?? req.user?.id ?? req.body.userId);
        if (!Number.isInteger(userId) || userId < 1) {
            return res.status(400).json({ success: false, message: "Invalid user" });
        }

        const pool = await poolPromise;
        const result = await pool.request()
            .input("USER_DR", sql.Int, userId)
            .execute("PROC_EB_GET_USER_CART");

        res.status(200).json({ success: true, ...cartResponse(result) });
    } catch (error) {
        sendError(res, error, "Get User Cart");
    }
});

router.get("/cart", async (req, res) => {
    try {
        const userId = Number(getUserId(req) ?? req.user?.id ?? req.query.userId);
        if (!Number.isInteger(userId) || userId < 1) {
            return res.status(400).json({ success: false, message: "Invalid user" });
        }

        const pool = await poolPromise;
        const result = await pool.request()
            .input("USER_DR", sql.Int, userId)
            .execute("PROC_EB_GET_USER_CART");

        res.status(200).json({ success: true, ...cartResponse(result) });
    } catch (error) {
        sendError(res, error, "Get User Cart");
    }
});

router.post("/cart/remove", requireAuth, async (req, res) => {
    try {
        const userId = Number(req.user?.id ?? req.body?.userId); // always the signed-in user
        const productId = Number(req.body.productId);

        if (!Number.isInteger(userId) || userId < 1 || !Number.isInteger(productId) || productId < 1) {
            return res.status(400).json({ success: false, message: "Invalid user or product" });
        }

        const pool = await poolPromise;
        const result = await pool.request()
            .input("USER_DR",    sql.Int, userId)
            .input("PRODUCT_DR", sql.Int, productId)
            .execute("PROC_EB_REMOVE_CART_ITEM");

        const change = (result.recordsets[2] || [])[0] || {};
        res.status(200).json({
            success: true,
            ...cartResponse(result),
            removed: !!change.removed
        });
    } catch (error) {
        sendError(res, error, "Remove Cart Item");
    }
});

module.exports = router;
