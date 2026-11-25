const express = require("express");
const router = express.Router();

const { sql, poolPromise } = require("../config");
const { requireAuth, requireStaffManager } = require("../middleware/auth");
// const { emptyToNull, sendError } = require("../utils/helpers");

// ---------- helpers ----------
const emptyToNull = (val) =>
    (val === undefined || val === null || (typeof val === "string" && val.trim() === "")) ? null : val;

const sendError = (res, error, action = "Operation") => {
    console.error(`${action} Error:`, error);
    // SP THROW 50000-59999 = our own messages, safe to show
    const isValidation = error.number >= 50000 && error.number < 60000;
    return res.status(isValidation ? 400 : 500).json({
        success: false,
        message: isValidation ? error.message : `${action} failed. Try again.`
    });
};

// ---------- place order ----------
router.post("/orders/place", requireAuth, async (req, res) => {
    try {
        const addressId = emptyToNull(req.body.addressId);
        if (addressId !== null && !Number.isInteger(Number(addressId))) {
            return res.status(400).json({ success: false, message: "Invalid address" });
        }

        let latitude = emptyToNull(req.body.latitude || req.body.lattitude);
        let longitude = emptyToNull(req.body.longitude || req.body.logitude);
        const deliveryAddress = emptyToNull(req.body.deliveryAddress);

        // If coordinates not passed directly, extract from deliveryAddress [GPS: 8.48549° N, 76.94924° E]
        if ((!latitude || !longitude) && deliveryAddress) {
            const gpsMatch = deliveryAddress.match(/\[GPS:\s*([0-9.]+)[°\s]*([NS])?[\s,]+([0-9.]+)[°\s]*([EW])?\]/i);
            if (gpsMatch) {
                if (!latitude) latitude = gpsMatch[1];
                if (!longitude) longitude = gpsMatch[3];
            }
        }

        const pool = await poolPromise;
        const result = await pool.request()
            .input("USER_DR",          sql.Int,            req.user.id)
            .input("ADDRESS_DR",       sql.Int,            addressId === null ? null : Number(addressId))
            .input("CUSTOMER_NAME",    sql.NVarChar(100),  emptyToNull(req.body.customerName))
            .input("CUSTOMER_MOBILE",  sql.NVarChar(20),   emptyToNull(req.body.customerMobile))
            .input("DELIVERY_ADDRESS", sql.NVarChar(1000), deliveryAddress)
            .input("ORDER_NOTE",       sql.NVarChar(500),  emptyToNull(req.body.note))
            .input("LATTITUDE",        sql.NVarChar(100),  latitude ? String(latitude) : null)
            .input("LONGITUDE",        sql.NVarChar(100),  longitude ? String(longitude) : null)
            .execute("PROC_EB_PLACE_ORDER");

        res.status(200).json({
            success: true,
            order: (result.recordsets[0] || [])[0] || null,
            items: result.recordsets[1] || []
        });
    } catch (error) {
        sendError(res, error, "Place Order");
    }
});

// ---------- order lists ----------
async function listOrders(req, res, { userId, allUsers }, label) {
    try {
        const b = req.body;
        const page = Math.max(1, Number(b.pageNumber) || 1);
        const size = Math.min(100, Math.max(1, Number(b.pageSize) || 20));

        const pool = await poolPromise;
        const result = await pool.request()
            .input("USER_DR",      sql.Int,           userId)
            .input("ALL_USERS",    sql.Bit,           allUsers ? 1 : 0)
            .input("ORDER_STATUS", sql.NVarChar(30),  emptyToNull(b.status))
            .input("SEARCH",       sql.NVarChar(100), emptyToNull(b.search))
            .input("FROM_DATE",    sql.Date,          emptyToNull(b.fromDate))
            .input("TO_DATE",      sql.Date,          emptyToNull(b.toDate))
            .input("PAGE_NUMBER",  sql.Int,           page)
            .input("PAGE_SIZE",    sql.Int,           size)
            .execute("PROC_EB_GET_USER_ORDERS");

        const total = (result.recordsets[1] || [])[0]?.totalOrders ?? 0;
        const orders = result.recordsets[0] || [];

        if (orders.length > 0) {
            const orderIds = orders.map((o) => o.orderId).filter(Boolean);
            if (orderIds.length > 0) {
                const itemsRes = await pool.request()
                    .query(`SELECT d.ORDER_DR AS orderId, d.PRODUCT_DR AS productId, d.PRODUCT_NAME AS productName, d.UNIT AS unit, d.UNIT_PRICE AS unitPrice, d.QUANTITY AS quantity, d.LINE_TOTAL AS lineTotal, p.PRODUCT_IMAGE AS productImage FROM dbo.EB_ORDER_DETAILS d LEFT JOIN dbo.EB_PRODUCT_MASTER p ON p.PRODUCT_SLNO = d.PRODUCT_DR WHERE d.ORDER_DR IN (${orderIds.join(',')})`);
                const itemsByOrder = {};
                for (const item of itemsRes.recordset) {
                    if (!itemsByOrder[item.orderId]) itemsByOrder[item.orderId] = [];
                    itemsByOrder[item.orderId].push(item);
                }
                for (const order of orders) {
                    order.items = itemsByOrder[order.orderId] || [];
                }
            }
        }

        res.status(200).json({
            success: true,
            orders,
            pagination: {
                pageNumber: page,
                pageSize: size,
                totalOrders: total,
                totalPages: Math.ceil(total / size)
            }
        });
    } catch (error) {
        sendError(res, error, label);
    }
}

// customer: only their own orders (user always from the token)
router.post("/orders/my", requireAuth, (req, res) =>
    listOrders(req, res, { userId: req.user.id, allUsers: false }, "Get My Orders"));

// staff: every order, with search and filters
router.post("/admin/orders", requireStaffManager, (req, res) =>
    listOrders(req, res, { userId: null, allUsers: true }, "Get All Orders"));

// ---------- order details ----------
async function orderDetails(req, res, { userId, staff }, label) {
    try {
        const orderId = emptyToNull(req.body.orderId);
        const orderCode = emptyToNull(req.body.orderCode);

        if (orderId === null && orderCode === null) {
            return res.status(400).json({ success: false, message: "Order id or code is required" });
        }
        if (orderId !== null && (!Number.isInteger(Number(orderId)) || Number(orderId) < 1)) {
            return res.status(400).json({ success: false, message: "Invalid order id" });
        }

        const pool = await poolPromise;
        const result = await pool.request()
            .input("ORDER_SLNO", sql.Int,          orderId === null ? null : Number(orderId))
            .input("ORDER_CODE", sql.NVarChar(30), orderCode === null ? null : String(orderCode))
            .input("USER_DR",    sql.Int,          userId)
            .input("STAFF_VIEW", sql.Bit,          staff ? 1 : 0)
            .execute("PROC_EB_GET_ORDER_DETAILS");

        const order = (result.recordsets[0] || [])[0];
        if (!order) {
            // same answer whether it doesn't exist or belongs to someone else
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        res.status(200).json({
            success: true,
            order,
            items: result.recordsets[1] || [],
            history: result.recordsets[2] || []
        });
    } catch (error) {
        sendError(res, error, label);
    }
}

router.post("/orders/details", requireAuth, (req, res) =>
    orderDetails(req, res, { userId: req.user.id, staff: false }, "Get Order Details"));

router.post("/admin/orders/details", requireStaffManager, (req, res) =>
    orderDetails(req, res, { userId: null, staff: true }, "Get Order Details"));

// ---------- status changes ----------
// staff: move an order along
router.post("/admin/orders/status", requireStaffManager, async (req, res) => {
    try {
        const orderId = Number(req.body.orderId);
        const status = String(req.body.status || "").trim().toUpperCase();

        if (!Number.isInteger(orderId) || orderId < 1 || !status) {
            return res.status(400).json({ success: false, message: "Order id and status are required" });
        }

        const pool = await poolPromise;
        const result = await pool.request()
            .input("ORDER_SLNO",      sql.Int,           orderId)
            .input("NEW_STATUS_CODE", sql.NVarChar(30),  status)
            .input("STATUS_NOTE",     sql.NVarChar(500), emptyToNull(req.body.note))
            .input("CHANGED_BY",      sql.Int,           req.user.id)    // from the token
            .input("OWNER_USER_DR",   sql.Int,           null)
            .execute("PROC_EB_UPDATE_ORDER_STATUS");

        res.status(200).json({ success: true, order: result.recordset[0] });
    } catch (error) {
        sendError(res, error, "Update Order Status");
    }
});

// customer: cancel their own order (only while PENDING)
router.post("/orders/cancel", requireAuth, async (req, res) => {
    try {
        const orderId = Number(req.body.orderId);
        if (!Number.isInteger(orderId) || orderId < 1) {
            return res.status(400).json({ success: false, message: "Invalid order" });
        }

        const pool = await poolPromise;
        const result = await pool.request()
            .input("ORDER_SLNO",      sql.Int,           orderId)
            .input("NEW_STATUS_CODE", sql.NVarChar(30),  "CANCELLED")    // fixed here, not from the body
            .input("STATUS_NOTE",     sql.NVarChar(500), emptyToNull(req.body.reason))
            .input("CHANGED_BY",      sql.Int,           req.user.id)
            .input("OWNER_USER_DR",   sql.Int,           req.user.id)    // makes the SP check ownership
            .execute("PROC_EB_UPDATE_ORDER_STATUS");

        res.status(200).json({ success: true, order: result.recordset[0] });
    } catch (error) {
        sendError(res, error, "Cancel Order");
    }
});

router.post("/me/profile", requireAuth, async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input("USERSLNO", sql.Int, req.user.id)
            .input("MODE",     sql.Int, 1)
            .execute("PROC_GET_PROFILE_AND_ORDER_DETAILS");

        const profile = (result.recordsets[0] || [])[0];
        if (!profile) {
            return res.status(401).json({ success: false, message: "Your session expired. Sign in again." });
        }
        res.status(200).json({ success: true, profile, addresses: result.recordsets[1] || [] });
    } catch (error) {
        sendError(res, error, "Get Profile");
    }
});

// orders tab
router.post("/me/orders", requireAuth, async (req, res) => {
    try {
        const b = req.body;
        const filter = String(b.filter || "ALL").toUpperCase();
        if (!["ALL", "ACTIVE", "DELIVERED"].includes(filter)) {
            return res.status(400).json({ success: false, message: "Invalid filter" });
        }
        const page = Math.max(1, Number(b.pageNumber) || 1);
        const size = Math.min(50, Math.max(1, Number(b.pageSize) || 20));

        const pool = await poolPromise;
        const result = await pool.request()
            .input("USERSLNO",    sql.Int,           req.user.id)
            .input("MODE",        sql.Int,           2)
            .input("FILTER",      sql.NVarChar(10),  filter)
            .input("SEARCH",      sql.NVarChar(100), emptyToNull(b.search))
            .input("PAGE_NUMBER", sql.Int,           page)
            .input("PAGE_SIZE",   sql.Int,           size)
            .execute("PROC_GET_PROFILE_AND_ORDER_DETAILS");

        // attach each order's items so the page can show them without another call
        const items = result.recordsets[2] || [];
        const orders = (result.recordsets[1] || []).map(o => ({
            ...o,
            items: items.filter(i => i.orderId === o.orderId)
        }));

        res.status(200).json({
            success: true,
            counts: (result.recordsets[0] || [])[0] || { allCount: 0, activeCount: 0, deliveredCount: 0 },
            orders,
            pageNumber: page,
            pageSize: size
        });
    } catch (error) {
        sendError(res, error, "Get My Orders");
    }
});

module.exports = router;